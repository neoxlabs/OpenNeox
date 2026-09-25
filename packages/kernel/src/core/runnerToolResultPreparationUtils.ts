import { cliLogger } from '../platform/cliLogger.js';
import type { ToolResult } from './parallelExecutor.js';
import type { ParsedToolArguments } from './toolArgsParser.js';
import { enrichToolResult } from './runnerHintUtils.js';
import { truncateToolOutput } from './runnerUtils.js';
import { truncateUtf16Safe } from '../utils/wireText.js';
import { extractToolImages } from '../utils/imageToolResult.js';
import type { ErrorPatternMemory } from './reasoning/errorPatternMemory.js';
import type { ToolCallDeduplicator } from './reasoning/toolCallDeduplicator.js';
import { isMutationTool, type EditRegion, type FileHotspotDetector } from './reasoning/fileHotspotDetector.js';

const TOOL_JSON_SOFT_LIMIT = 12_000;
const TOOL_JSON_PREVIEW_CHARS = 320;
const TOOL_JSON_MAX_HUNKS = 6;

/* R3: tool result 动态截断阈值.
 *   现在 TOOL_JSON_SOFT_LIMIT 固定 12k — 对 GLM 32K context 来说占 37% 太狠,
 *   对 Sonnet/Kimi 200K+ context 来说太保守. 按模型 maxInputTokens 动态算:
 *   effectiveLimit = clamp(maxInputTokens * fraction, MIN, MAX_SOFT_LIMIT).
 *   fraction = 0.05 (单条 tool result 不超过 context 5%).
 *   MIN = 2000 (低于这个 tool result 等于不能传任何有用信息).
 *   MAX = TOOL_JSON_SOFT_LIMIT = 12k (避免上限失控). */
const TOOL_RESULT_LIMIT_MIN = 2000;
const TOOL_RESULT_LIMIT_FRACTION = 0.05;
/** 输出本身就是"模型要逐字复制的源文本"的工具 —— 见下方 readLike 注释。 */
const READ_LIKE_TOOLS = new Set(['readfile', 'read', 'read_file', 'search', 'search_files', 'list_directory', 'show_tree']);
/** 读文件工具自己按预算控量 (整文件 25k token / 多文件合计上限), 内核不再按 12K 二次截断。 */
const FILE_READ_TOOLS = new Set(['readfile', 'read', 'read_file']);
/** 大窗口模型读文件结果的安全上限 (字符) —— 只防失控, 正常读不会碰到。 */
const FILE_READ_HARD_LIMIT = 160_000;
/** 窗口不到这个数的模型, 读文件仍按 12K 截 (25k token 的整文件会吃掉小窗口的大半)。 */
const FILE_READ_LARGE_WINDOW_TOKENS = 200_000;

/** 从 edit 回执 metadata.hunks 取出本次动到的行段 (编辑后坐标); 取不到返回 undefined */
function extractEditRegions(rawResult: string): EditRegion[] | undefined {
  if (!rawResult || !rawResult.includes('"hunks"')) return undefined;
  try {
    const hunks = (JSON.parse(rawResult) as { metadata?: { hunks?: Array<{ start_line?: number; new_line_count?: number }> } })
      ?.metadata?.hunks;
    if (!Array.isArray(hunks)) return undefined;
    const regions = hunks
      .filter((h) => typeof h?.start_line === 'number')
      .map((h) => ({ start: h.start_line as number, end: (h.start_line as number) + Math.max(0, (h.new_line_count ?? 1) - 1) }));
    return regions.length > 0 ? regions : undefined;
  } catch {
    return undefined;
  }
}

function computeFileReadLimit(modelMaxInputTokens?: number): number {
  if (!modelMaxInputTokens || modelMaxInputTokens < FILE_READ_LARGE_WINDOW_TOKENS) return TOOL_JSON_SOFT_LIMIT;
  return FILE_READ_HARD_LIMIT;
}

function computeEffectiveSoftLimit(modelMaxInputTokens?: number): number {
  if (!modelMaxInputTokens || modelMaxInputTokens <= 0) return TOOL_JSON_SOFT_LIMIT;
  const fractional = Math.floor(modelMaxInputTokens * TOOL_RESULT_LIMIT_FRACTION);
  return Math.max(TOOL_RESULT_LIMIT_MIN, Math.min(TOOL_JSON_SOFT_LIMIT, fractional));
}

function shorten(value: string, maxChars: number = TOOL_JSON_PREVIEW_CHARS): string {
  if (value.length <= maxChars) return value;
  return `${truncateUtf16Safe(value, maxChars)}…`;
}

/* 上下文卫生: surface 系工具 (open_surface / update_surface / plan_op / todo_replace)
 * 的返回是一个含 __neox_surface_event__ marker 的 JSON, 里面带着 agent 刚写的**完整内容**
 * (plan_op.content 可能几十 K)。这份内容: (1) 已经在 agent 自己这一步的 tool_call args 里 (一份),
 * (2) canonical 副本在右栏 surface 上, (3) renderer 从**流事件**里拿原始结果渲染 (不受此处影响,
 * 跟 compactEditLikeToolOutput 压 edit 结果但时间线 diff 照常渲染是同一个道理)。
 * 所以进 LLM 记忆的这一份纯属回显 double —— 换成一句紧凑 ack, 既不丢信息 (args 里还有一份),
 * 又省掉每轮重复携带的几十 K。绝不动 read/shell/search/edit 这类"观察类" ground truth。 */
const SURFACE_MARKER_LITERAL = '__neox_surface_event__';

function compactSurfaceMarkerToolOutput(raw: string): string {
  if (!raw || !raw.includes(SURFACE_MARKER_LITERAL)) return raw;
  let obj: any;
  try { obj = JSON.parse(raw); } catch { return raw; }
  if (!obj || obj[SURFACE_MARKER_LITERAL] !== true || typeof obj.action !== 'string') return raw;

  const id = obj.surfaceId ? ` (surface ${obj.surfaceId})` : '';
  const size = (s: any) => (typeof s === 'string' && s.length ? ` · ${s.length} chars` : '');
  const tail = 'Applied to the right-panel canvas (canonical copy lives there); you already have what you wrote — do not re-echo it.';

  switch (obj.action) {
    case 'open': {
      const kind = obj.surface?.kind || obj.kind || 'surface';
      const title = obj.surface?.title || obj.title;
      return `✅ Opened ${kind} surface${id}${title ? ` · "${title}"` : ''}. ${tail}`;
    }
    case 'update':
      return `✅ Updated surface${id}. ${tail}`;
    case 'close':
      return `✅ Closed surface${id}.`;
    case 'todo_replace': {
      const n = Array.isArray(obj.todos) ? obj.todos.length : undefined;
      return `✅ Updated todos${id}${n != null ? ` · ${n} items` : ''}.`;
    }
    case 'plan_op': {
      const op = obj.planOp || {};
      const where = op.heading ? ` · section "${op.heading}"` : '';
      switch (op.kind) {
        case 'content':            return `✅ Plan written${id}${size(op.content)}. ${tail}`;
        case 'replace_section':    return `✅ Plan section replaced${id}${where}${size(op.content)}.`;
        case 'append':             return `✅ Appended to plan${id}${size(op.text)}.`;
        case 'set_section_status': return `✅ Plan section status set${id}${where} → ${op.status || ''}.`;
        case 'add_note':           return `✅ Note added to plan${id}.`;
        default:                   return `✅ Plan updated${id}.`;
      }
    }
    default:
      return `✅ Surface event applied${id}.`;
  }
}

function compactEditLikeToolOutput(toolName: string, raw: string): string {
  const normalized = (toolName || '').toLowerCase();
  if (normalized !== 'edit_file' && normalized !== 'edit') {
    return raw;
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return raw;

    const cloned: any = { ...parsed };
    const metadata: any = cloned.metadata && typeof cloned.metadata === 'object'
      ? { ...cloned.metadata }
      : undefined;

    //  Phase 3: edit 结果不再包含 edit_info / hunks[].old_string/new_string
    // 只需压缩 actual_content（错误时包含的文件内容片段）
    if (typeof cloned.actual_content === 'string' && cloned.actual_content.length > TOOL_JSON_PREVIEW_CHARS) {
      cloned.actual_content = shorten(cloned.actual_content);
      cloned.actual_content_truncated = true;
    }

    // edit 原始输出可带 old/new 预览（供 UI diff 用）：
    // 进入 LLM 记忆前只保留行元数据，避免无用 token 膨胀
    if (Array.isArray(metadata?.hunks)) {
      const compactedHunks = metadata.hunks.map((hunk: any) => ({
        start_line: hunk?.start_line,
        old_line_count: hunk?.old_line_count,
        new_line_count: hunk?.new_line_count,
      }));

      if (compactedHunks.length > TOOL_JSON_MAX_HUNKS) {
        const total = compactedHunks.length;
        metadata.hunks = compactedHunks.slice(0, TOOL_JSON_MAX_HUNKS);
        metadata.hunks_omitted = total - TOOL_JSON_MAX_HUNKS;
        metadata.hunks_total = total;
      } else {
        metadata.hunks = compactedHunks;
      }
    }

    if (metadata) cloned.metadata = metadata;
    return JSON.stringify(cloned);
  } catch {
    return raw;
  }
}

export async function prepareToolResultForMemory(options: {
  result: ToolResult;
  toolCalls: any[];
  executableToolCalls: Array<{ id: string }>;
  parsedArgsByToolId: Map<string, ParsedToolArguments>;
  autoVerifyPipeline: {
    shouldVerify: (toolName: string, success: boolean) => boolean;
    verify: (filePath: string) => Promise<any>;
    formatForToolResult: (verifyResult: any) => string | undefined;
  };
  extractVerifyFilePath: (toolName: string, args: Record<string, any> | undefined) => string | undefined;
  executionPolicyOrchestrator: {
    applyToolResultPolicy: (input: { result: ToolResult; toolCalls: any[]; truncatedResult: string }) => Promise<{
      truncatedResult: string;
      toolInput: Record<string, any>;
      shouldBreak: boolean;
      encounteredError: boolean;
    }>;
  };
  /** 可选: 失败时拼递进式 escalated hint(对标 agentLoop.ts 的对称行为) */
  errorPatternMemory?: ErrorPatternMemory;
  /** 可选: 跨 step 同 (toolName, args) 重复检测; 触发时 append reminder, 超阈值置 dedupForceStop */
  toolCallDedup?: ToolCallDeduplicator;
  /**
   * 可选: 单文件短窗口高频编辑检测 — 补 LoopDetector hash-based 盲区.
   * hook-flash.html 类场景: 12 次独立 edit 流每次 line range 不同 → hash 不同 → LoopDetector 拦不下.
   * 本项按 (filePath, timestamp) 聚合, 5min 窗口内 >= 5 次 mutation 触发 <system-reminder> 软提示,
   * 不硬拦, 由 LLM 自行判断是不是该收敛 (真 refactor 场景 5min 编 10 次也算合理).
   */
  fileHotspot?: FileHotspotDetector;
  /**
   * 可选: 当前模型的 input context window 上限 (tokens). 用于动态算 tool result
   * 截断阈值 — 大窗口模型 (Sonnet 200K / Kimi 256K) 截 12K 太保守, 小窗口模型
   * (GLM 32K) 截 12K 太狠. 不传则 fallback 固定 12K (老行为).
   */
  modelMaxInputTokens?: number;
}): Promise<{
  truncatedResult: string;
  toolInput: Record<string, any>;
  shouldBreak: boolean;
  encounteredError: boolean;
  /** dedup 检测到 streak >= REPEAT_FORCE_STOP_STREAK, runner 应停 turn */
  dedupForceStop?: boolean;
}> {
  const { result, toolCalls, executableToolCalls, parsedArgsByToolId } = options;
  const rawResult = typeof result.output === 'string'
    ? result.output
    : JSON.stringify(result.output);
  // 先剥离 surface marker 回显 (几十 K → ack), 再走 edit 结果压缩, 最后动态截断。
  const compactedResult = compactEditLikeToolOutput(
    result.name,
    compactSurfaceMarkerToolOutput(rawResult),
  );
  /* Preserve image-protocol payloads without truncation or text prefixes so the
   * image extractor can decode them. */
  if (extractToolImages(compactedResult)) {
    const policy = await options.executionPolicyOrchestrator.applyToolResultPolicy({
      result,
      toolCalls: options.toolCalls,
      truncatedResult: compactedResult,
    });
    return { ...policy, truncatedResult: compactedResult };
  }
  /* R3: 按模型 context window 动态算 effective soft limit. 不传则 fallback 12K (老行为).
   *
   *  读类工具例外 : readfile 自己已按 12K 控量 (超了会缩块重读), 而账本
   * (readLedger) 在**这里截断之前**就按全文登记了。若再按 context 5% 把它砍到 10K / 6K / 2K,
   * 模型看到的是中段被挖掉的文件, 账本却说它"读过全文且文件未变" → edit 失败时诊断成
   * fresh ("是你抄错了"), 而它抄的那段根本没发给它。读类结果一律给满 12K 上限, 与 readfile
   * 自己的控量对齐 —— 两边同一个数, 账本登记的就是模型真看到的。
   *
   *  读文件再例外 : 09-11 起 readfile 整文件按 25k token 给全, 这里却还卡 12K 字符,
   * 300 行以上的文件被挖掉中段, 模型只能分段重读 (真实会话里一个 3000 行文件读了 13 次),
   * 账本又按全文登记。大窗口模型读文件改由 readfile 自己控量, 这里只留失控上限。 */
  const toolName = String(result.name || '').toLowerCase();
  const effectiveSoftLimit = FILE_READ_TOOLS.has(toolName)
    ? computeFileReadLimit(options.modelMaxInputTokens)
    : READ_LIKE_TOOLS.has(toolName)
      ? TOOL_JSON_SOFT_LIMIT
      : computeEffectiveSoftLimit(options.modelMaxInputTokens);
  let truncatedResult = compactedResult.length > effectiveSoftLimit
    ? truncateToolOutput(compactedResult, effectiveSoftLimit)
    : compactedResult;

  truncatedResult = enrichToolResult(truncatedResult, result.name, result.executionTime || 0);

  if (options.autoVerifyPipeline.shouldVerify(result.name, result.success)) {
    const matchingToolCall = executableToolCalls.find((tc) => tc.id === result.id);
    const verifyArgs = matchingToolCall ? parsedArgsByToolId.get(matchingToolCall.id)?.args : undefined;
    const verifyFilePath = options.extractVerifyFilePath(result.name, verifyArgs);
    if (verifyFilePath) {
      try {
        const verifyResult = await options.autoVerifyPipeline.verify(verifyFilePath);
        if (verifyResult) {
          const verifyStr = options.autoVerifyPipeline.formatForToolResult(verifyResult);
          if (verifyStr) {
            truncatedResult += verifyStr;
            if (process.env.CLI_DEBUG === '1') {
              cliLogger.debug('AUTO_VERIFY', `${verifyResult.passed ? 'PASS' : 'FAIL'} for ${verifyFilePath}`);
            }
          }
        }
      } catch {
        // verification error — silent skip
      }
    }
  }

  //  失败时拼递进式 escalated hint — 对齐 agentLoop.ts:1551-1573 的行为.
  // ErrorPatternMemory.buildEscalatedHint 根据连续失败次数 + 错误类型生成具体策略,
  // 比如 edit 第 2 次失败建议重读, 第 3 次建议切 write_file, 第 4 次建议求助用户.
  if (!result.success && options.errorPatternMemory) {
    try {
      const matchingToolCall = executableToolCalls.find((tc) => tc.id === result.id);
      const args = matchingToolCall ? parsedArgsByToolId.get(matchingToolCall.id)?.args : undefined;
      const filePath = typeof args?.file_path === 'string'
        ? args.file_path
        : typeof args?.path === 'string'
          ? args.path
          : undefined;
      const hint = options.errorPatternMemory.buildEscalatedHint(result.name, filePath);
      if (hint) {
        truncatedResult = `${truncatedResult}\n\n${hint}`;
      }
    } catch {
      // hint 生成失败静默跳过 — 不影响主流程
    }
  }

  //  ToolCallDeduplicator — anti 死循环: 跨 step 同 (toolName, args) 连续重复
  // 用 streak 升级 reminder (r1 streak>=3 / r2 streak>=5 / r3 streak>=8 / forceStop streak>=12).
  // 不论 success/failure 都 check — 模型也可能在"成功但无意义"的工具上死磕.
  // 跟 errorPatternMemory.buildEscalatedHint 是 sibling 关系, 双层保险.
  let dedupForceStop = false;
  if (options.toolCallDedup) {
    try {
      const matchingToolCall = executableToolCalls.find((tc) => tc.id === result.id);
      const args = matchingToolCall ? parsedArgsByToolId.get(matchingToolCall.id)?.args : undefined;
      const dedupResult = options.toolCallDedup.checkAndRecord(result.name, args);
      if (dedupResult.reminder) {
        /* reminder 文本已含开头 \n\n 分隔符 (toolCallDeduplicator REMINDER_R1 等), 直接 concat 即可 */
        truncatedResult = `${truncatedResult}${dedupResult.reminder}`;
      }
      if (dedupResult.forceStop) {
        dedupForceStop = true;
        cliLogger.warn('RUNNER',
          `🛑 tool dedup force stop: tool=${result.name} streak=${dedupResult.streak} — runner will halt turn`);
      } else if (dedupResult.level !== 'none') {
        cliLogger.info('RUNNER',
          `🔁 tool dedup ${dedupResult.level}: tool=${result.name} streak=${dedupResult.streak} — reminder appended to tool result`);
      }
    } catch (err: any) {
      cliLogger.debug('RUNNER', `tool dedup check failed: ${err?.message ?? err} — skipping`);
    }
  }

  /* FileHotspotDetector — 单文件短窗口高频编辑软提示 (E6).
   *   与 toolCallDedup 是不同维度: dedup 看"同工具+同参数", hotspot 看"同文件+短时间".
   *   hook-flash.html 场景: 12 次 edit 每次 line range 不同, dedup hash 变了不算重复,
   *   但 hotspot 累计 count 会命中. 成功/失败 都记 (真在改 = 真占资源, 无论是否报错).
   *   只对 mutation 类工具生效, read/search/shell 不计. */
  if (options.fileHotspot) {
    try {
      if (isMutationTool(result.name)) {
        const matchingToolCall = executableToolCalls.find((tc) => tc.id === result.id);
        const args = matchingToolCall ? parsedArgsByToolId.get(matchingToolCall.id)?.args : undefined;
        const filePath = typeof args?.file_path === 'string'
          ? args.file_path
          : typeof args?.path === 'string'
            ? args.path
            : undefined;
        if (filePath) {
          const hotspotResult = options.fileHotspot.recordAndCheck(filePath, Date.now(), extractEditRegions(rawResult));
          if (hotspotResult.reminder) {
            truncatedResult = `${truncatedResult}${hotspotResult.reminder}`;
          }
          if (hotspotResult.level !== 'none') {
            cliLogger.info('RUNNER',
              `🔥 file hotspot ${hotspotResult.level}: ${filePath} count=${hotspotResult.count} in 5min window`);
          }
        }
      }
    } catch (err: any) {
      cliLogger.debug('RUNNER', `file hotspot check failed: ${err?.message ?? err} — skipping`);
    }
  }

  const policyResult = await options.executionPolicyOrchestrator.applyToolResultPolicy({
    result,
    toolCalls,
    truncatedResult,
  });
  return { ...policyResult, dedupForceStop };
}
