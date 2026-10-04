/**
 * LLM 摘要压缩器 — 按内容类型分桶，并行摘要，保 agent 不降智。
 *
 * 4 桶分类：文件内容 / 命令输出 / 搜索结果 / 对话流
 * 每桶专用 prompt，并行调用降级模型（全局并发闸），超大桶分片 map-reduce。
 *
 * 滚动摘要：上一轮压缩产出的 [Compressed Work Record] 按类别折叠进
 * 本轮各桶一起重摘要 —— 任何时刻 memory 里最多存在一条 summary，多次压缩不堆积。
 *
 * 摘要缓存：桶/分片级 内容哈希 → 摘要 (实例级 LRU)。净增守卫作废结果、超时重试、
 * 相邻两次压缩间内容未变时不重烧 LLM。
 *
 * 通过 onProgress 回调驱动 UI 进度条。
 */

import type { Message, LLMProvider } from '../../types/index.js';
import { estimateTokensFromMessages } from '../../compat/memoryPressure.js';
import { estimateTokens } from '../tokenEstimate.js';
import { getTextFromContent } from '../messageUtils.js';
import { takeUtf16SafeTail, truncateUtf16Safe } from '../wireText.js';
import { cliLogger } from '../../platform/cliLogger.js';
import { getSummaryModel } from '../../core/toolSummaryGenerator.js';

// ════════════════════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════════════════════

export type BucketKind = 'files' | 'commands' | 'search' | 'conversation';

/** 压缩摘要消息的身份标记 — 持久化往返 (入库/回读白名单) 与滚动合并识别都靠它。 */
export const COMPACTION_SUMMARY_MARKER = '[Compressed Work Record';

/** 该消息是否是压缩产出的摘要 (role=system + 内容以标记开头)。
 *  跨包共用 (host 落盘 / loadHistory 回读白名单), 只依赖 role+content 两个字段。 */
export function isCompactionSummaryMessage(msg: { role?: string; content?: unknown } | null | undefined): boolean {
  return !!msg
    && msg.role === 'system'
    && typeof msg.content === 'string'
    && msg.content.startsWith(COMPACTION_SUMMARY_MARKER);
}

export interface BucketProgress {
  bucket: BucketKind;
  label: string;
  /** 该桶包含的消息数 */
  messageCount: number;
  /** 该桶原始 token 估算 */
  estimatedTokens: number;
  status: 'pending' | 'compressing' | 'done' | 'empty';
  /** 摘要后 token（done 时有值） */
  compressedTokens?: number;
  /** 该桶涉及的文件/命令/搜索词列表（给 UI 显示） */
  items?: string[];
}

export interface CompressionProgress {
  phase: 'categorizing' | 'compressing' | 'done';
  /** 总共几个有内容的桶 */
  totalBuckets: number;
  /** 已完成几个 */
  completedBuckets: number;
  /** 各桶详情 */
  buckets: BucketProgress[];
  /** 总原始 token */
  originalTokens: number;
  /** 当前已压缩的 token */
  compressedTokens: number;
  /** 使用的摘要模型 */
  summaryModel: string;
}

export interface SummarizeResult {
  messages: Message[];
  originalTokens: number;
  compressedTokens: number;
  savedTokens: number;
  summarizedCount: number;
  preservedCount: number;
  summaryModel: string;
  /** 各桶压缩详情 */
  bucketDetails: BucketProgress[];
}

export interface LLMSummarizerConfig {
  /** 末尾保护 N 条 non-system 消息 (最近决策) */
  protectRecentCount?: number;
  /**
   * 末尾保护的 **token 预算** (raw 口径)。给了就按它算保护几条 —— 从最后一条往前累加,
   * 加满为止, 再按 tool-pair 对齐。
   *
   * 按 token 保护则无论消息大小, 尾部占用恒定。0 = 不保护 (收敛循环最后一轮用)。
   */
  protectRecentTokens?: number;
  /**
   * 头部保护 N 条 non-system 消息 (任务初心 / 用户原始 prompt).
   * 默认 2: 首轮 user + 它的 assistant reply, 长会话压缩后模型仍记得"原本要做啥".
   * 设 0 关闭头部保护.
   */
  protectHeadCount?: number;
  timeoutMs?: number;
  maxSummaryTokens?: number;
  /** 单次 LLM 调用的桶 transcript 上限(字符), 超过则分片 map-reduce (多次调用提质量) */
  chunkCharLimit?: number;
  /** 桶间/分片间 LLM 调用的全局并发数 */
  llmConcurrency?: number;
  /** 摘要缓存条数上限 (实例级 LRU) */
  cacheSize?: number;
  /** 手动 /compact: 极低保护区 + 强制烧 LLM (忽略 MIN_COMPRESSIBLE) */
  force?: boolean;
}

const DEFAULT_CONFIG: Required<LLMSummarizerConfig> = {
  protectRecentCount: 10,
  /** -1 = 未指定, 走 protectRecentCount 的老路 (SDK/其它调用方不受影响) */
  protectRecentTokens: -1,
  protectHeadCount: 2,
  timeoutMs: 45_000,
  maxSummaryTokens: 1500,
  chunkCharLimit: 48_000,
  llmConcurrency: 3,
  cacheSize: 64,
  force: false,
};

/** 可压缩量低于该值不烧 LLM — 摘要产出比压掉的还多就是白烧  */
const MIN_COMPRESSIBLE_TOKENS = 2000;

/**
 * 从尾部往前累加消息, 返回 token 预算内能保住的条数。
 * 预算 0 → 0 条; 预算再大也不超过总条数。第一条即超预算时仍保 1 条 ——
 * 尾部一条不留会让模型完全失去"我刚才在干嘛"的锚点。
 */
export function countTailMessagesWithinTokens(messages: Message[], budget: number): number {
  if (budget <= 0 || messages.length === 0) return 0;
  let used = 0;
  let kept = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = estimateTokensFromMessages([messages[i]!]);
    if (kept > 0 && used + t > budget) break;
    used += t;
    kept++;
    if (used >= budget) break;
  }
  return kept;
}

// ════════════════════════════════════════════════════════════════════════════
// 分桶规则
// ════════════════════════════════════════════════════════════════════════════

const FILE_TOOLS = new Set([
  'readfile', 'read_file', 'read', 'file_read',
  'write_file', 'writefile', 'write',
  'edit_file', 'editfile', 'edit',
  'delete_file',
]);

const COMMAND_TOOLS = new Set([
  'execute_shell', 'bash', 'shell', 'run_command',
  'execute_command', 'terminal',
]);

const SEARCH_TOOLS = new Set([
  'grep', 'search', 'glob', 'file_search', 'find_files',
  'web_search', 'web_fetch', 'search_files',
]);

function classifyToolMessage(msg: Message): BucketKind {
  const name = ((msg as any).name || '').toLowerCase();
  if (FILE_TOOLS.has(name)) return 'files';
  if (COMMAND_TOOLS.has(name)) return 'commands';
  if (SEARCH_TOOLS.has(name)) return 'search';
  return 'conversation';
}

// ════════════════════════════════════════════════════════════════════════════
// 桶专用 Prompt
// ════════════════════════════════════════════════════════════════════════════

const BUCKET_PROMPTS: Record<BucketKind, string> = {
  files: `You are compressing file-related tool outputs for an AI coding agent.

For each file, produce ONE line:
- [filepath] (N lines): [key structures, issues found with line numbers, important functions/classes]

Rules:
- Preserve ALL file paths, function names, line numbers, error messages
- For edits: record what changed and which lines
- For writes: record what was created
- For deletes: record what was removed
- Use the same language as the original content
- Be extremely concise — one line per file, max 2 lines for complex files`,

  commands: `You are compressing shell/command outputs for an AI coding agent.

For each command, produce ONE line:
- [command]: [success/failure] — [key output: test counts, build errors, important lines]

Rules:
- Preserve exact error messages and exit codes
- For tests: record pass/fail counts and which tests failed
- For builds: record if successful or what errors occurred
- For installs: record what was installed and any warnings
- Be extremely concise`,

  search: `You are compressing search/grep results for an AI coding agent.

For each search, produce ONE line:
- [search query] in [scope]: [N matches] — [key findings with file:line references]

Rules:
- Preserve search patterns and file:line locations
- Record match counts
- Highlight the most relevant matches (max 3 per search)
- For web searches: preserve URLs and key findings
- Be extremely concise`,

  /* 补 Dead Ends / Rejected 两节:
   * 压缩后最贵的错误不是"忘了做过什么"(重做一遍还能对), 而是"忘了什么行不通" ——
   * 模型会把已经失败过的修法、用户已经否决过的方向再走一遍, 用户看到的就是"压缩完变笨了"。
   * Done/Pending 原本就有, 但走不通的路会被当成普通对话丢掉。
   * 注: 工具失败另有确定性回灌(postCompactReinject 的 trackToolFailure), 这里是第二道 —— 它
   * 能覆盖"用户口头否决"这类工具层看不见的信息。 */
  conversation: `You are compressing a conversation between a user and an AI coding agent.

Produce a structured summary:
## User Goals
- [exact user requirements — do not paraphrase]

## Decisions Made
- [decision]: [reasoning]

## Current Status
- Done: [what's completed]
- Pending: [what remains]

## Dead Ends (do not retry these)
- [approach that was tried and failed]: [why it failed]

## Rejected by User
- [direction the user explicitly turned down]: [their reason, if given]

## Current Work
- [precisely what was being worked on right before this summary — file names, exact code/commands in flight]

## Next Step
- [the immediate next action, directly in line with the user's most recent request; omit if the task just concluded]

Rules:
- Preserve the user's exact intent and requirements
- Record every decision and why it was made
- Track what's done vs what's pending
- **Never drop a failed approach or a user rejection** — repeating them is the most
  expensive mistake after compaction. Keep these two sections even if everything else
  must be shortened. Omit a section only when it is genuinely empty.
- **Current Work and Next Step are equally mandatory**: the convergence loop may drop the
  entire recent tail on its last pass, so this summary becomes the only record of what was
  in flight. Quote exact file paths, commands and user wording rather than paraphrasing.
- Use the same language as the conversation
- Be concise but preserve all decision context`,
};

const BUCKET_LABELS: Record<BucketKind, string> = {
  files: 'Files',
  commands: 'Commands',
  search: 'Search',
  conversation: 'Conversation',
};

// ════════════════════════════════════════════════════════════════════════════
// Core
// ════════════════════════════════════════════════════════════════════════════

interface Bucket {
  kind: BucketKind;
  messages: Message[];
  /** 该桶涉及的具体项目（文件名/命令/搜索词） */
  items: string[];
  /** 上一轮 summary 里属于本桶的段落 (滚动合并输入, 无则 '') */
  prior: string;
}

/** 全局 LLM 并发闸 — 桶与分片共用同一个实例, 防止一次压缩打爆 provider 限速。 */
class Semaphore {
  private queue: Array<() => void> = [];
  private inUse = 0;
  constructor(private readonly limit: number) {}
  async acquire(): Promise<void> {
    if (this.inUse < this.limit) {
      this.inUse++;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    // release() 把名额直接转交给队首, inUse 不变
  }
  release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.inUse--;
  }
}

/** 缓存 key 用的字符串哈希 (FNV-1a 32bit)。key 里另拼了长度, 碰撞概率可忽略。 */
/**
 * 这个错误是不是"provider 不认识这个模型" —— 只有这类才值得换模型重试.
 *
 *   404 / model not found / unknown model / unsupported model / does not exist 都算。
 *   限流(429)、超时、5xx、鉴权失败**不算** —— 那些换个模型也一样失败, 重试只是
 *   多烧一次钱并把真实故障掩盖成"压缩慢"。
 */
function isModelUnavailableError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err ?? '').toLowerCase();
  if (!msg) return false;
  if (/\b(429|too many requests|rate.?limit|timeout|aborted|abort)\b/.test(msg)) return false;
  return /\b404\b/.test(msg)
    || msg.includes('model not found')
    || msg.includes('unknown model')
    || msg.includes('unsupported model')
    || msg.includes('does not exist')
    || msg.includes('no such model');
}

function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export class LLMSummarizer {
  private config: Required<LLMSummarizerConfig>;

  constructor(config?: LLMSummarizerConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async summarize(
    messages: Message[],
    tokenBudget: number,
    llmProvider: LLMProvider,
    currentModel: string,
    onProgress?: (progress: CompressionProgress) => void,
    overrides?: Partial<LLMSummarizerConfig>,
  ): Promise<SummarizeResult> {
    const originalTokens = estimateTokensFromMessages(messages);
    const summaryModel = getSummaryModel(currentModel);
    /* 摘要模型被 provider 拒掉时的退路 — 见 cachedLLM 里的说明 */
    this.currentModelForFallback = currentModel;
    const prevConfig = this.config;
    if (overrides) {
      this.config = { ...this.config, ...overrides };
    }

    try {
      return await this.summarizeWithConfig(
        messages,
        tokenBudget,
        llmProvider,
        summaryModel,
        onProgress,
        originalTokens,
      );
    } finally {
      this.config = prevConfig;
    }
  }

  private async summarizeWithConfig(
    messages: Message[],
    tokenBudget: number,
    llmProvider: LLMProvider,
    summaryModel: string,
    onProgress: ((progress: CompressionProgress) => void) | undefined,
    originalTokens: number,
  ): Promise<SummarizeResult> {
    const force = !!this.config.force;

    // ── 1. 分区 (旧 summary 单独拎出, 参与滚动合并, 不进"永不压"区) ──
    const partition = this.partitionMessages(messages);
    const { systemMessages, priorSummaries } = partition;
    let compressible = partition.compressible;
    let headPreserved = partition.headPreserved;
    let tailPreserved = partition.tailPreserved;

    /* 手动 force: 默认保护把大 tool 输出全护在尾部 → 可压区空 → 永不烧 LLM.
     * 只留最近 2 条, 其余全部进摘要. */
    if (force) {
      const nonSystem = [
        ...partition.headPreserved,
        ...partition.compressible,
        ...partition.tailPreserved,
      ];
      const keepTail = Math.min(2, nonSystem.length);
      headPreserved = [];
      compressible = nonSystem.slice(0, Math.max(0, nonSystem.length - keepTail));
      tailPreserved = nonSystem.slice(Math.max(0, nonSystem.length - keepTail));
      cliLogger.info('LLMSummarizer',
        `Manual force repartition: compressible=${compressible.length} msgs, keepTail=${tailPreserved.length}`);
    }

    const preservedCount = headPreserved.length + tailPreserved.length;

    /* ── 1.5 保护区超大单条就地裁剪 ──
     * force: 更狠 (≤2K), 否则大 tool 结果躺在尾部把预算吃光. */
    const perMessageCap = force
      ? Math.min(2000, Math.max(800, Math.floor(tokenBudget * 0.08)))
      : Math.max(4000, Math.floor(tokenBudget * 0.2));
    const snippedHead = this.snipOversizedPreserved(headPreserved, perMessageCap);
    const snippedTail = this.snipOversizedPreserved(tailPreserved, perMessageCap);
    const protectedSnipped = snippedHead !== headPreserved || snippedTail !== tailPreserved;
    headPreserved = snippedHead;
    tailPreserved = snippedTail;

    /* ── 1.6 可压缩量太小不烧 LLM ──
     * force 只要有可压消息就烧 (手动 /compact 用户明确要 summary). */
    const compressibleTokens = compressible.length > 0 ? estimateTokensFromMessages(compressible) : 0;
    const tooSmall = compressible.length === 0
      || (!force && compressibleTokens < MIN_COMPRESSIBLE_TOKENS);

    if (tooSmall) {
      const lightMessages = (protectedSnipped || force)
        ? [...systemMessages, ...headPreserved, ...priorSummaries, ...compressible, ...tailPreserved]
        : messages;
      const lightTokens = estimateTokensFromMessages(lightMessages);
      cliLogger.warn('LLMSummarizer',
        `Skip LLM summarize: compressible=${compressible.length} msgs / ${compressibleTokens} tok`
        + ` (force=${force}, min=${MIN_COMPRESSIBLE_TOKENS})`);
      return {
        messages: lightMessages,
        originalTokens,
        compressedTokens: lightTokens,
        savedTokens: Math.max(0, originalTokens - lightTokens),
        summarizedCount: 0,
        preservedCount,
        summaryModel,
        bucketDetails: [],
      };
    }

    // ── 2. 分桶 + 旧 summary 按类别折叠 (滚动合并) ──
    const buckets = this.categorizeToBuckets(compressible);
    const priorSections = this.parsePriorSections(priorSummaries);
    for (const b of buckets) b.prior = priorSections[b.kind];

    /* active = 有新内容需要 LLM 重摘要 (旧段落一并喂进去合并);
     * carry  = 本轮没有新内容但旧 summary 里有该类段落 → 原样携带, 不烧 LLM。 */
    const activeBuckets = buckets.filter(b => b.messages.length > 0);
    const carryBuckets = buckets.filter(b => b.messages.length === 0 && b.prior);

    const bucketProgresses: BucketProgress[] = buckets.map(b => ({
      bucket: b.kind,
      label: BUCKET_LABELS[b.kind],
      messageCount: b.messages.length,
      estimatedTokens: b.messages.length > 0 ? estimateTokensFromMessages(b.messages)
        : b.prior ? estimateTokens(b.prior) : 0,
      status: b.messages.length > 0 ? 'pending' as const
        : b.prior ? 'done' as const : 'empty' as const,
      compressedTokens: b.messages.length === 0 && b.prior ? estimateTokens(b.prior) : undefined,
      items: b.items.slice(0, 10),
    }));

    let completedCount = 0;
    const emitProgress = (phase: CompressionProgress['phase'], compressedTokens = originalTokens) => {
      onProgress?.({
        phase,
        totalBuckets: activeBuckets.length,
        completedBuckets: completedCount,
        buckets: bucketProgresses,
        originalTokens,
        compressedTokens,
        summaryModel,
      });
    };

    emitProgress('categorizing');

    // ── 3. 并行摘要每个桶 (全局并发闸共享给桶内分片) ──
    const semaphore = new Semaphore(this.config.llmConcurrency);
    const partByKind = new Map<BucketKind, string>();
    for (const b of carryBuckets) partByKind.set(b.kind, b.prior);

    await Promise.all(activeBuckets.map(async (bucket) => {
      const bp = bucketProgresses.find(p => p.bucket === bucket.kind)!;
      bp.status = 'compressing';
      emitProgress('compressing');

      const summary = await this.summarizeBucket(bucket, llmProvider, summaryModel, semaphore);
      partByKind.set(bucket.kind, summary);

      bp.status = 'done';
      bp.compressedTokens = estimateTokens(summary);
      completedCount++;
      emitProgress('compressing');
    }));

    // ── 4. 组装 (桶顺序固定, 与并行完成顺序无关) ──
    const summaryParts = buckets
      .filter(b => partByKind.has(b.kind))
      .map(b => `### ${BUCKET_LABELS[b.kind]}\n${partByKind.get(b.kind)}`);
    const combinedSummary = summaryParts.join('\n\n');
    const mergedNote = priorSummaries.length > 0 ? `, merged ${priorSummaries.length} earlier record(s)` : '';
    const summaryMessage: Message = {
      role: 'system',
      content: `${COMPACTION_SUMMARY_MARKER} — ${compressible.length} messages across ${summaryParts.length} categories${mergedNote}]\n\n${combinedSummary}`,
    };

    /* 组装顺序: system → 头部保护 (任务初心) → summary (中间压缩) → 尾部保护 (最近上下文).
     * 这样模型既看到"原本要做啥", 又看到"中间做了啥摘要", 又看到"最近这几条决策上下文". */
    const resultMessages = [
      ...systemMessages,
      ...headPreserved,
      summaryMessage,
      ...tailPreserved,
    ];

    const compressedTokens = estimateTokensFromMessages(resultMessages);

    emitProgress('done', compressedTokens);

    cliLogger.info('LLMSummarizer',
      `Compressed: ${messages.length} msgs (${originalTokens} tok) → ${resultMessages.length} msgs (${compressedTokens} tok), ` +
      `saved ${originalTokens - compressedTokens} tok, ${activeBuckets.length} buckets summarized + ${carryBuckets.length} carried` +
      `${priorSummaries.length ? `, merged ${priorSummaries.length} prior record(s)` : ''} (model=${summaryModel})`);

    return {
      messages: resultMessages,
      originalTokens,
      compressedTokens,
      savedTokens: originalTokens - compressedTokens,
      summarizedCount: compressible.length + priorSummaries.length,
      preservedCount: headPreserved.length + tailPreserved.length,
      summaryModel,
      bucketDetails: bucketProgresses,
    };
  }

  // ════════════════════════════════════════════════════════════════════════════
  // 单桶摘要 — 分片 map-reduce + 缓存
  // ════════════════════════════════════════════════════════════════════════════

  /** 桶 transcript 在 chunkCharLimit 内: (旧段落 + 新内容) 一次调用合并摘要。
   *  超限: 分片各自摘要 (map, 并行), 再连同旧段落一次 reduce 收敛成桶摘要 —— 比把
   *  超长 transcript 硬塞一次调用的质量高得多 (每片都得到完整注意力)。 */
  private async summarizeBucket(
    bucket: Bucket,
    llmProvider: LLMProvider,
    model: string,
    semaphore: Semaphore,
  ): Promise<string> {
    const prompt = BUCKET_PROMPTS[bucket.kind];
    const chunks = this.chunkParts(this.formatBucketParts(bucket), this.config.chunkCharLimit);

    if (chunks.length === 1) {
      return this.cachedLLM(llmProvider, model, bucket.kind, prompt, this.withPriorBlock(bucket.prior, chunks[0]), semaphore);
    }

    const chunkSummaries = await Promise.all(chunks.map(chunk =>
      this.cachedLLM(llmProvider, model, bucket.kind, prompt, chunk, semaphore)));

    const reduceInput = this.withPriorBlock(
      bucket.prior,
      `[PARTIAL SUMMARIES of one long history — merge into a single deduplicated summary in the same format]\n${chunkSummaries.join('\n---\n')}`,
    );
    return this.cachedLLM(llmProvider, model, bucket.kind, prompt, reduceInput, semaphore);
  }

  /** 旧 summary 段落拼在新内容前, 带内联合并指令。 */
  private withPriorBlock(prior: string, transcript: string): string {
    if (!prior) return transcript;
    return `[PRIOR COMPRESSED RECORD — already-summarized earlier history. Merge it with the new content below; deduplicate entries about the same file/command/topic keeping the newest status; never drop user goals or decisions recorded here.]\n${prior}\n\n[NEW CONTENT]\n${transcript}`;
  }

  /** 把 formatted parts 贪心打包成 ≤limit 字符的分片 (单 part 超限自成一片)。 */
  private chunkParts(parts: string[], limit: number): string[] {
    const chunks: string[] = [];
    let current: string[] = [];
    let currentLen = 0;
    for (const part of parts) {
      if (currentLen > 0 && currentLen + part.length > limit) {
        chunks.push(current.join('\n---\n'));
        current = [];
        currentLen = 0;
      }
      current.push(part);
      currentLen += part.length + 5;
    }
    if (current.length) chunks.push(current.join('\n---\n'));
    return chunks.length ? chunks : [''];
  }

  // ════════════════════════════════════════════════════════════════════════════
  // 摘要缓存 — 内容哈希 → 摘要 (实例级 LRU)
  //
  // 命中场景: ① 净增守卫作废整轮结果后下一次重压 (内容没变, 4 桶全命中, 零 LLM);
  // ② 某桶失败重试 (已成功的桶/分片不重烧); ③ 相邻两次压缩间某桶无新内容。
  // key 含 model + 桶类型 + transcript 长度 + prompt/transcript 哈希, 与会话状态无关。
  // ════════════════════════════════════════════════════════════════════════════

  private summaryCache = new Map<string, string>();
  /** summarize() 每次进来时记下的当前模型 — 摘要模型被上游拒绝时拿它兜底 */
  private currentModelForFallback: string | undefined;

  private async cachedLLM(
    llmProvider: LLMProvider,
    model: string,
    kind: BucketKind,
    systemPrompt: string,
    transcript: string,
    semaphore: Semaphore,
  ): Promise<string> {
    const key = `${model}|${kind}|${transcript.length}|${fnv1a(systemPrompt)}|${fnv1a(transcript)}`;
    const hit = this.cacheGet(key);
    if (hit !== undefined) {
      cliLogger.debug('LLMSummarizer', `cache hit: ${kind} (${transcript.length} chars)`);
      return hit;
    }
    await semaphore.acquire();
    try {
      const again = this.cacheGet(key); // 等闸期间同 key 可能已被别的分片算完
      if (again !== undefined) return again;
      let summary: string;
      try {
        summary = await this.callLLM(llmProvider, model, systemPrompt, transcript);
      } catch (err) {
        /* 摘要模型不被当前 provider 认识 → 退回当前模型重试一次.
         *
         *   getSummaryModel() 是**纯名称映射** (gpt-5.4 → gpt-5.4-mini 之类), 它并不知道
         *   这个便宜的兄弟型号在用户当前接的 provider 上到底存不存在。而 provider 是
         *   Runner 构造时定下的、之后再没更新过 (runner.ts:552 只调一次 setLLMProvider),
         *   期间 this.model 却会变 —— 流式错误降级 (runner.ts:3696)、run 结束还原 (3839)、
         *   用户在会话里换模型。两边一漂, 就会拿着 A 家的模型名去问 B 家, 上游回 404,
         *   用户看到的是"LLM 压缩失败 · Anthropic API error: 404", 且重启就好
         *   (新 Runner 的 provider 和 model 重新配上了)。
         *
         *   currentModel 一定是安全的: 主循环此刻正在用它跟同一个 provider 说话。
         *   贵一点, 但压缩成功远好过压缩失败——失败意味着上下文继续膨胀直到彻底崩。 */
        const fallback = this.currentModelForFallback;
        if (!fallback || fallback === model || !isModelUnavailableError(err)) throw err;
        cliLogger.warn('LLMSummarizer',
          `summary model "${model}" rejected by provider (${(err as Error)?.message ?? err}); retrying with current model "${fallback}"`);
        summary = await this.callLLM(llmProvider, fallback, systemPrompt, transcript);
      }
      this.cacheSet(key, summary);
      return summary;
    } finally {
      semaphore.release();
    }
  }

  private cacheGet(key: string): string | undefined {
    const val = this.summaryCache.get(key);
    if (val !== undefined) {
      this.summaryCache.delete(key);
      this.summaryCache.set(key, val); // 刷新 LRU 顺序
    }
    return val;
  }

  private cacheSet(key: string, val: string): void {
    this.summaryCache.set(key, val);
    while (this.summaryCache.size > this.config.cacheSize) {
      const oldest = this.summaryCache.keys().next().value;
      if (oldest === undefined) break;
      this.summaryCache.delete(oldest);
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // 旧 summary 解析 — 按 "### Files/Commands/…" 段落拆回各桶
  // ════════════════════════════════════════════════════════════════════════════

  private parsePriorSections(priorSummaries: Message[]): Record<BucketKind, string> {
    const acc: Record<BucketKind, string[]> = { files: [], commands: [], search: [], conversation: [] };
    const kindByLabel = new Map<string, BucketKind>(
      (Object.keys(BUCKET_LABELS) as BucketKind[]).map(k => [BUCKET_LABELS[k], k]),
    );
    for (const msg of priorSummaries) {
      // 去掉 "[Compressed Work Record — …]" 头行
      const body = getTextFromContent(msg.content).replace(/^\[[^\]]*\]\s*/, '');
      const buf: Record<BucketKind, string[]> = { files: [], commands: [], search: [], conversation: [] };
      let current: BucketKind = 'conversation'; // 无标题/未知标题的内容归 conversation, 保底不丢
      for (const line of body.split('\n')) {
        const heading = line.match(/^###\s+(\w+)\s*$/);
        const kind = heading ? kindByLabel.get(heading[1]) : undefined;
        if (kind) {
          current = kind;
          continue;
        }
        buf[current].push(line);
      }
      for (const k of Object.keys(buf) as BucketKind[]) {
        const text = buf[k].join('\n').trim();
        if (text) acc[k].push(text);
      }
    }
    return {
      files: acc.files.join('\n'),
      commands: acc.commands.join('\n'),
      search: acc.search.join('\n'),
      conversation: acc.conversation.join('\n'),
    };
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Partition
  // ════════════════════════════════════════════════════════════════════════════

  /** 保护区内单条超过 capTokens 的 string 消息裁中段(头尾各留约 40%, 标注省略量)。
   *  没有任何裁剪时返回**原数组引用**, 调用方以引用相等判断是否发生过裁剪。
   *  多模态(数组 content)与非 string 一律不动。 */
  private snipOversizedPreserved(preserved: Message[], capTokens: number): Message[] {
    let touched = false;
    const out = preserved.map((msg) => {
      const content = (msg as any).content;
      if (typeof content !== 'string') return msg;
      const tokens = estimateTokens(content);
      if (tokens <= capTokens) return msg;
      /* tokens→字符换算按本条消息的实际密度(CJK 密度高), 头尾各留 cap 的 40% */
      const charsPerToken = content.length / tokens;
      const keepChars = Math.max(200, Math.floor(capTokens * 0.4 * charsPerToken));
      /* UTF-16 safe — 避免孤立 surrogate 进 LLM JSON body */
      const head = truncateUtf16Safe(content, keepChars);
      const tail = takeUtf16SafeTail(content, keepChars);
      const omittedChars = content.length - head.length - tail.length;
      const omittedLines = content.slice(head.length, content.length - tail.length).split('\n').length;
      touched = true;
      return {
        ...msg,
        content: `${head}\n\n[... 内容过长已截断: 省略 ${omittedLines} 行 / ${omittedChars} 字符 ...]\n\n${tail}`,
      };
    });
    return touched ? out : preserved;
  }

  private partitionMessages(messages: Message[]): {
    systemMessages: Message[];
    priorSummaries: Message[];
    headPreserved: Message[];
    compressible: Message[];
    tailPreserved: Message[];
  } {
    const systemMessages: Message[] = [];
    const priorSummaries: Message[] = [];
    const nonSystem: Message[] = [];
    for (const msg of messages) {
      if (isCompactionSummaryMessage(msg)) {
        /* 上一轮压缩产出的 summary — 不进"永不压"的 system 区, 交给滚动合并折叠,
         * 保证任何时刻 memory 里最多一条 summary (堆积根治,)。 */
        priorSummaries.push(msg);
      } else if (msg.role === 'system') {
        systemMessages.push(msg);
      } else {
        nonSystem.push(msg);
      }
    }

    /* 尾部保护: 优先按 token 预算 (见 protectRecentTokens 注释), 没给才退回按条数。 */
    const protectCount = this.config.protectRecentTokens >= 0
      ? countTailMessagesWithinTokens(nonSystem, this.config.protectRecentTokens)
      : Math.min(this.config.protectRecentCount, nonSystem.length);
    const tailSplitIdx = nonSystem.length - protectCount;
    const safeTailSplitIdx = this.findSafeSplitPoint(nonSystem, tailSplitIdx);

    // 头部保护: 最早 protectHeadCount 条不可压缩 (任务初心 / 原始 prompt 永不丢).
    // 上限 safeTailSplitIdx 防止头尾重叠 (短会话时尾部 protect 已覆盖前面所有消息).
    const headCount = Math.max(0, Math.min(this.config.protectHeadCount, safeTailSplitIdx));

    return {
      systemMessages,
      priorSummaries,
      headPreserved: nonSystem.slice(0, headCount),
      compressible: nonSystem.slice(headCount, safeTailSplitIdx),
      tailPreserved: nonSystem.slice(safeTailSplitIdx),
    };
  }

  /** 从尾部往前累加, 在 token 预算内最多能保住几条 (预算 0 → 一条不保) */
  private countTailWithinTokens(messages: Message[], budget: number): number {
    return countTailMessagesWithinTokens(messages, budget);
  }

  private findSafeSplitPoint(messages: Message[], splitIdx: number): number {
    let idx = splitIdx;
    while (idx > 0 && (messages[idx]?.role === 'tool' || this.hasToolCalls(messages[idx]))) {
      idx--;
    }
    if (idx > 0 && this.hasToolCalls(messages[idx])) {
      idx--;
    }
    return Math.max(0, idx);
  }

  private hasToolCalls(msg: Message): boolean {
    return msg?.role === 'assistant' && Array.isArray((msg as any).tool_calls) && (msg as any).tool_calls.length > 0;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Categorize
  // ════════════════════════════════════════════════════════════════════════════

  private categorizeToBuckets(messages: Message[]): Bucket[] {
    const map: Record<BucketKind, Bucket> = {
      files: { kind: 'files', messages: [], items: [], prior: '' },
      commands: { kind: 'commands', messages: [], items: [], prior: '' },
      search: { kind: 'search', messages: [], items: [], prior: '' },
      conversation: { kind: 'conversation', messages: [], items: [], prior: '' },
    };

    for (const msg of messages) {
      if (msg.role === 'tool') {
        const kind = classifyToolMessage(msg);
        map[kind].messages.push(msg);
        const name = (msg as any).name || '';
        const content = getTextFromContent(msg.content);
        // 提取该桶的 item 标识（文件路径、命令、搜索词）
        const item = this.extractItemLabel(kind, name, content);
        if (item && !map[kind].items.includes(item)) {
          map[kind].items.push(item);
        }
      } else if (msg.role === 'assistant' && (msg as any).tool_calls?.length) {
        // assistant(tool_calls) 按第一个 tool 的类型分桶
        const firstCall = (msg as any).tool_calls[0];
        const fakeTool = { role: 'tool' as const, name: firstCall?.function?.name, content: '' };
        const kind = classifyToolMessage(fakeTool as any);
        map[kind].messages.push(msg);
      } else {
        map.conversation.messages.push(msg);
      }
    }

    return [map.files, map.commands, map.search, map.conversation];
  }

  private extractItemLabel(kind: BucketKind, toolName: string, content: string): string | null {
    if (kind === 'files') {
      const pathMatch = content.match(/^(?:File|Reading|Writing|Editing)?\s*[:：]?\s*([^\n]{5,120})/i)
        || content.match(/^([/\\][\w./\\-]+)/m);
      return pathMatch?.[1]?.trim().slice(0, 80) || toolName;
    }
    if (kind === 'commands') {
      const cmdMatch = content.match(/^\$?\s*(.{5,100})/m);
      return cmdMatch?.[1]?.trim().slice(0, 60) || toolName;
    }
    if (kind === 'search') {
      return toolName;
    }
    return null;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Format
  // ════════════════════════════════════════════════════════════════════════════

  /** 每条消息格式化成独立 part (分片打包的最小单元)。 */
  private formatBucketParts(bucket: Bucket): string[] {
    const parts: string[] = [];

    for (const msg of bucket.messages) {
      const content = getTextFromContent(msg.content);

      if (msg.role === 'tool') {
        const toolName = (msg as any).name || 'unknown';
        const preview = content.length > 4000
          ? content.slice(0, 2000) + `\n... [${content.length} chars total] ...\n` + content.slice(-500)
          : content;
        parts.push(`[${toolName}]\n${preview}`);
      } else if (msg.role === 'assistant' && (msg as any).tool_calls?.length) {
        const calls = ((msg as any).tool_calls as any[])
          .map(tc => `${tc.function?.name || '?'}(${(tc.function?.arguments || '').slice(0, 150)})`)
          .join(', ');
        parts.push(`[CALLS: ${calls}]${content ? '\n' + content : ''}`);
      } else {
        /* 对话消息也设单条上限 — 一条超长 user 粘贴不该独占整个分片预算 */
        const capped = content.length > 12_000
          ? content.slice(0, 8000) + `\n... [${content.length} chars total, middle omitted] ...\n` + content.slice(-3000)
          : content;
        parts.push(`[${msg.role.toUpperCase()}]\n${capped}`);
      }
    }

    return parts;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // LLM Call
  // ════════════════════════════════════════════════════════════════════════════

  private async callLLM(
    llmProvider: LLMProvider,
    model: string,
    systemPrompt: string,
    transcript: string,
  ): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await llmProvider.chat(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Compress the following:\n\n${transcript}` },
        ],
        {
          model,
          temperature: 0,
          maxTokens: this.config.maxSummaryTokens,
          signal: controller.signal,
        },
      );

      const summary = response.choices?.[0]?.message?.content ?? '';
      if (!summary.trim()) {
        throw new Error('LLM returned empty summary');
      }
      return summary;
    } finally {
      clearTimeout(timer);
    }
  }
}
