
import fs from 'node:fs';
import path from 'node:path';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { workspaceDataDir } from '../platform/workspaceDataDir.js';

// ============================================================================
// 类型
// ============================================================================

export type SummaryMode = 'full' | 'partial-from' | 'partial-up-to';

export interface SessionMemorySummary {
  /** 1. 当前任务状态 (1-2 句话: completed / in-progress / blocked + 原因) */
  state: string;
  /** 2. 核心任务意图 (1-3 句话: 用户在做什么) */
  task: string;
  /** 3. 改动文件清单 — **每条含完整代码片段**:
   *     "path/file.ts (修改原因) — ```ts\n<code snippet ≤30 lines>\n```"
   *     摘要后想知道改了啥不用回原对话.
   */
  filesWithCode: string[];
  /** 4. 工作流步骤 (有序, 每条一句). */
  workflow: string[];
  errorsWithFeedback: string[];
  allUserMessages: string[];
  /** 7. 引用的文档 / 参考资料 (URL / 文件路径) */
  documentation: string[];
  /** 8. 沉淀的决策 / 偏好 / 项目事实 (跨 session 长期有用) */
  learnings: string[];
  pendingAndNextStep: string;
  /** 元数据 */
  meta: {
    generatedAt: number;
    sourceMessageCount: number;
    summaryModel: string;
    /** 摘要模式 (full / partial-*) */
    mode: SummaryMode;
    /** PARTIAL 模式下的 boundary message id / index */
    partialBoundary?: string | number;
  };
}

/** LLM provider 接口最小子集 — 让 caller 可以传主 LLM 或 fork agent adapter */
export interface SessionMemoryLLMProvider {
  chat(messages: Array<{ role: string; content: string }>, opts?: {
    model?: string;
    temperature?: number;
    maxTokens?: number;
  }): Promise<{ content: string }>;
}

export interface ExtractSessionMemoryOptions {
  messages: Array<{ role: string; content: any }>;
  llmProvider: SessionMemoryLLMProvider;
  model: string;
  /** 摘要总字数预算 (大概). 默认 2500 (升级到 9 段 + 代码片段需更多) */
  maxSummaryWords?: number;
  /** 超时 ms. 默认 90s (fork agent 跑摘要可能比主 LLM 慢) */
  timeoutMs?: number;
  /** 摘要模式. full = 全量; partial-from = 摘 boundary 后续; partial-up-to = 摘 boundary 之前 */
  mode?: SummaryMode;
  /** PARTIAL 模式下的 boundary — message index (number) 或 message id (string).
   *   number → 直接切; string → 按 message.id === string 找 index. */
  partialBoundary?: string | number;
}

// ============================================================================
// Prompt 模板
// ============================================================================

/** 9 段 FULL 摘要 prompt — CC autoCompact 风格 + Neox 跨 session 持久化优化 */
const EXTRACT_PROMPT_FULL = `You are a session memory summarizer. Read the following conversation between a user and an AI coding agent, then produce a structured JSON summary covering 9 specific sections. This summary will be loaded as context into the user's NEXT session (cross-session memory), so accuracy + retainability matter more than verbosity.

**Crucial: First fill the "_analysis" field as your scratchpad — go through the conversation chronologically and identify (a) user's explicit asks & corrections, (b) files touched, (c) errors & how resolved, (d) user feedback, (e) pending tasks. THEN fill the 9 data fields based on your analysis.** This 2-stage approach (analyze → output) is empirically proven to improve summary fidelity ~30% (CC autoCompact pattern).

OUTPUT FORMAT (strict JSON, no markdown wrapper, no commentary outside JSON):

{
  "_analysis": "<your chronological scratchpad reasoning — what user asked, what was done, what was disputed, what's pending. Won't be persisted. Be thorough here so the 9 fields below come out precise.>",

  "state": "<1-2 sentences: task status (completed / in-progress / blocked). If blocked, what blocks it.>",

  "task": "<1-3 sentences: user's core intent in this session.>",

  "filesWithCode": [
    "<path> — <change reason in 5-15 words> — \\\`\\\`\\\`<lang>\\n<code snippet up to 30 lines, REAL code not pseudocode>\\n\\\`\\\`\\\`",
    "...one entry per touched file, INCLUDE THE ACTUAL CODE SNIPPETS verbatim. This lets next session see what changed without re-reading."
  ],

  "workflow": [
    "<ordered step taken (one sentence each)>",
    "..."
  ],

  "errorsWithFeedback": [
    "<error description> → <how it was resolved> [user said: '<verbatim user feedback if any, '' if none>']",
    "..."
  ],

  "allUserMessages": [
    "<full verbatim user message text — NOT paraphrased — chronological order. Include EVERY non-tool user message, even short ones like 'continue' / 'no, do X instead'. This is ground truth for intent recovery.>",
    "..."
  ],

  "documentation": [
    "<doc URL or file path referenced>",
    "..."
  ],

  "learnings": [
    "<durable cross-session knowledge: user preferences, project facts, key technical decisions. NOT session-specific state.>",
    "..."
  ],

  "pendingAndNextStep": "<2-4 sentences. List pending tasks (if any). State precise next step. Include verbatim user quote that motivates it: e.g. '[Pending] tests not run yet. [Next] User said \\\"先跑测试\\\" → run npm test then re-verify.'>"
}

RULES:
- Each array can be empty if nothing applies (use []).
- Total length cap: <maxSummaryWords> words across all string values combined (excluding _analysis scratchpad).
- Use the SAME language as the conversation (中文 → 中文, English → English).
- Be specific: include file paths, function names, exact error messages, verbatim user quotes.
- Don't repeat content across sections; each fact appears in the MOST appropriate one.
- Skip pure conversational noise (greetings, "ok thanks") UNLESS they signal intent change.
- For "learnings": ONLY durable cross-session knowledge. Skip session-specific state (that goes in "state" / "task").
- For "allUserMessages": copy user message text VERBATIM, even quirky phrasing — paraphrasing loses ground truth.
- For "filesWithCode": code snippets must be REAL extracted from conversation, NOT made up. If no actual code shown for a file, write "<no code shown — only path discussed>".`;

/** PARTIAL 模式 prompt — 强调"只摘 boundary 后/前的 messages" */
const EXTRACT_PROMPT_PARTIAL_FROM = `You are a session memory summarizer. The conversation has earlier messages that are being KEPT as-is (not summarized). Your job is to summarize ONLY the RECENT portion (after the boundary marker). Output the same 9-section JSON structure.

[Same _analysis-first + JSON structure as FULL mode — DO include _analysis scratchpad, then fill 9 fields based on the RECENT portion only.]

[Boundary: messages BEFORE this marker are NOT to be summarized.]`;

const EXTRACT_PROMPT_PARTIAL_UP_TO = `You are a session memory summarizer. The conversation has later messages that are being KEPT as-is (not summarized). Your job is to summarize ONLY the EARLIER portion (before the boundary marker). Output the same 9-section JSON structure.

[Same _analysis-first + JSON structure as FULL mode — DO include _analysis scratchpad, then fill 9 fields based on the EARLIER portion only.]

[Boundary: messages AFTER this marker are NOT to be summarized.]`;

// ============================================================================
// 主函数
// ============================================================================

/**
 * 从一段对话提取 9 段语义化摘要.
 *
 * 失败处理: LLM 调用失败 / JSON 解析失败 → throw, 调用方决定降级.
 */
export async function extractSessionMemory(
  options: ExtractSessionMemoryOptions,
): Promise<SessionMemorySummary> {
  const {
    messages,
    llmProvider,
    model,
    maxSummaryWords = 2500,
    timeoutMs = 90_000,
    mode = 'full',
    partialBoundary,
  } = options;

  if (messages.length === 0) {
    throw new Error('extractSessionMemory: messages is empty');
  }

  /* PARTIAL 模式: 按 boundary 切 messages */
  const filteredMessages = applyPartialBoundary(messages, mode, partialBoundary);
  if (filteredMessages.length === 0) {
    throw new Error(`extractSessionMemory: PARTIAL mode (${mode}, boundary=${partialBoundary}) filtered out all messages`);
  }

  const transcript = renderConversationTranscript(filteredMessages);
  const systemPrompt = pickPrompt(mode).replace('<maxSummaryWords>', String(maxSummaryWords));

  const startedAt = Date.now();
  const llmCallPromise = llmProvider.chat([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Conversation transcript (mode=${mode}):\n\n${transcript}` },
  ], {
    model,
    temperature: 0.3,
    /* 升级到 9 段 + 代码片段 + verbatim user messages → 输出预算翻倍 */
    maxTokens: Math.max(4000, maxSummaryWords * 3),
  });

  const timeoutPromise = new Promise<never>((_, reject) => {
    const tid = setTimeout(() => {
      clearTimeout(tid);
      reject(new Error(`extractSessionMemory timeout after ${(timeoutMs / 1000).toFixed(1)}s`));
    }, timeoutMs);
  });

  const response = await Promise.race([llmCallPromise, timeoutPromise]);
  const elapsed = Date.now() - startedAt;

  /* 解析 JSON. 容忍 LLM 把 JSON 包在 markdown ```json...``` 块里. */
  const json = stripMarkdownCodeFence(response.content.trim());
  let parsed: any;
  try {
    parsed = JSON.parse(json);
  } catch (err: any) {
    throw new Error(`extractSessionMemory: LLM returned invalid JSON: ${err?.message}. Preview: ${json.slice(0, 200)}`);
  }

  /* _analysis 字段不持久化 (是 LLM 的 scratchpad), 只用作 reasoning 质量信号 */
  const analysisLength = typeof parsed._analysis === 'string' ? parsed._analysis.length : 0;

  const summary: SessionMemorySummary = {
    state: typeof parsed.state === 'string' ? parsed.state : '',
    task: typeof parsed.task === 'string' ? parsed.task : '',
    filesWithCode: arrOfStrings(parsed.filesWithCode),
    workflow: arrOfStrings(parsed.workflow),
    errorsWithFeedback: arrOfStrings(parsed.errorsWithFeedback),
    allUserMessages: arrOfStrings(parsed.allUserMessages),
    documentation: arrOfStrings(parsed.documentation),
    learnings: arrOfStrings(parsed.learnings),
    pendingAndNextStep: typeof parsed.pendingAndNextStep === 'string' ? parsed.pendingAndNextStep : '',
    meta: {
      generatedAt: Date.now(),
      sourceMessageCount: filteredMessages.length,
      summaryModel: model,
      mode,
      partialBoundary,
    },
  };

  cliLogger.info('SESSION_MEMORY',
    `extracted (${elapsed}ms, ${filteredMessages.length}/${messages.length} msgs, mode=${mode}, analysis=${analysisLength}c → ${summarizeStats(summary)})`);

  return summary;
}

// ============================================================================
// 格式化辅助
// ============================================================================

/**
 * 渲染 markdown — 9 段中文标题, 空段省略.
 */
export function formatSessionMemoryAsMarkdown(summary: SessionMemorySummary): string {
  const parts: string[] = [];

  const modeNote = summary.meta.mode === 'full' ? '' : ` · ${summary.meta.mode}`;
  parts.push(`# 上次会话摘要 (${new Date(summary.meta.generatedAt).toISOString().slice(0, 10)}${modeNote})`);
  parts.push('');

  if (summary.state) {
    parts.push('## 状态'); parts.push(summary.state); parts.push('');
  }
  if (summary.task) {
    parts.push('## 任务'); parts.push(summary.task); parts.push('');
  }
  if (summary.filesWithCode.length > 0) {
    parts.push('## 改动的文件 (含代码片段)');
    for (const f of summary.filesWithCode) { parts.push(`- ${f}`); parts.push(''); }
  }
  if (summary.workflow.length > 0) {
    parts.push('## 工作流步骤');
    summary.workflow.forEach((w, i) => parts.push(`${i + 1}. ${w}`));
    parts.push('');
  }
  if (summary.errorsWithFeedback.length > 0) {
    parts.push('## 错误 + 用户反馈');
    for (const e of summary.errorsWithFeedback) parts.push(`- ${e}`);
    parts.push('');
  }
  if (summary.allUserMessages.length > 0) {
    parts.push('## 用户原话 (verbatim, 按时间序)');
    summary.allUserMessages.forEach((m, i) => {
      parts.push(`${i + 1}. > ${m.replace(/\n/g, '\n   > ')}`);
    });
    parts.push('');
  }
  if (summary.documentation.length > 0) {
    parts.push('## 引用文档');
    for (const d of summary.documentation) parts.push(`- ${d}`);
    parts.push('');
  }
  if (summary.learnings.length > 0) {
    parts.push('## 沉淀的决策 / 学到的');
    for (const l of summary.learnings) parts.push(`- ${l}`);
    parts.push('');
  }
  if (summary.pendingAndNextStep) {
    parts.push('## 待办 + 下一步'); parts.push(summary.pendingAndNextStep); parts.push('');
  }

  parts.push('---');
  parts.push(`*来源: ${summary.meta.sourceMessageCount} 条消息, 模型: ${summary.meta.summaryModel}, 模式: ${summary.meta.mode}*`);

  return parts.join('\n');
}

// ============================================================================
// 内部辅助
// ============================================================================

function pickPrompt(mode: SummaryMode): string {
  switch (mode) {
    case 'partial-from': return EXTRACT_PROMPT_PARTIAL_FROM + '\n\n' + EXTRACT_PROMPT_FULL;
    case 'partial-up-to': return EXTRACT_PROMPT_PARTIAL_UP_TO + '\n\n' + EXTRACT_PROMPT_FULL;
    case 'full':
    default: return EXTRACT_PROMPT_FULL;
  }
}

function applyPartialBoundary(
  messages: Array<{ role: string; content: any; id?: string }>,
  mode: SummaryMode,
  boundary?: string | number,
): Array<{ role: string; content: any }> {
  if (mode === 'full' || boundary === undefined) return messages;

  /* boundary number → 直接 index, string → 找 messages 里 id === string 的 index */
  let idx: number;
  if (typeof boundary === 'number') {
    idx = boundary;
  } else {
    idx = messages.findIndex(m => (m as any).id === boundary);
    if (idx === -1) {
      throw new Error(`extractSessionMemory: PARTIAL boundary message id "${boundary}" not found in messages`);
    }
  }

  if (idx < 0 || idx >= messages.length) {
    throw new Error(`extractSessionMemory: PARTIAL boundary index ${idx} out of range [0, ${messages.length})`);
  }

  if (mode === 'partial-from') {
    /* 摘 boundary 之后 (含 boundary) */
    return messages.slice(idx);
  }
  /* partial-up-to: 摘 boundary 之前 (含 boundary) */
  return messages.slice(0, idx + 1);
}

function renderConversationTranscript(messages: Array<{ role: string; content: any }>): string {
  /* system 段是 agent 自己的说明书 (2 万多字符), 不是对话 —— 原来整段抄进转录,
   * 摘要请求一半以上的输入是它, 还可能被当成"用户的要求"摘进记忆。 */
  return messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      const content = typeof m.content === 'string' ? m.content : safeStringify(m.content);
      return `[${m.role}]\n${content}`;
    })
    .join('\n\n');
}

function safeStringify(value: any): string {
  try { return JSON.stringify(value); } catch { return String(value); }
}

function stripMarkdownCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (match) return match[1].trim();
  return trimmed;
}

function arrOfStrings(value: any): string[] {
  return Array.isArray(value) ? value.filter((x: any) => typeof x === 'string') : [];
}

function summarizeStats(s: SessionMemorySummary): string {
  return `state=${s.state.length}c task=${s.task.length}c files=${s.filesWithCode.length} workflow=${s.workflow.length} errors=${s.errorsWithFeedback.length} userMsgs=${s.allUserMessages.length} docs=${s.documentation.length} learnings=${s.learnings.length} pending=${s.pendingAndNextStep.length}c`;
}

// ============================================================================
// 持久化 (写到 ~/.neox/workspaces/<id>/session-memory.md —— 不进用户项目)
// ============================================================================

export function getSessionMemoryFilePath(workspaceRoot: string): string {
  return path.join(workspaceDataDir(workspaceRoot), 'session-memory.md');
}

/** 老位置的文件搬过来并从用户项目里删掉 (一次性; .neox 空了连目录一起删, 里面有别的就不动) */
function migrateLegacySessionMemory(workspaceRoot: string): void {
  const legacyDir = path.join(workspaceRoot, '.neox');
  const legacy = path.join(legacyDir, 'session-memory.md');
  if (!fs.existsSync(legacy)) return;
  const target = getSessionMemoryFilePath(workspaceRoot);
  try {
    if (!fs.existsSync(target)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(legacy, target);
    }
    fs.unlinkSync(legacy);
    if (fs.readdirSync(legacyDir).length === 0) fs.rmdirSync(legacyDir);
    cliLogger.info('SESSION_MEMORY', `moved out of the project → ${target}`);
  } catch (err: any) {
    cliLogger.warn('SESSION_MEMORY', `legacy move failed: ${err?.message ?? err}`);
  }
}

export function loadSessionMemoryMarkdown(workspaceRoot: string): string | null {
  migrateLegacySessionMemory(workspaceRoot);
  try {
    const p = getSessionMemoryFilePath(workspaceRoot);
    if (!fs.existsSync(p)) return null;
    const content = fs.readFileSync(p, 'utf-8').trim();
    return content || null;
  } catch (err: any) {
    cliLogger.debug('SESSION_MEMORY', `load failed: ${err?.message ?? err}`);
    return null;
  }
}

const PROMPT_DROPPED_SECTIONS = ['## 用户原话', '## 待办 + 下一步'];

export function sessionMemoryForPrompt(markdown: string): string {
  const out: string[] = [];
  let dropping = false;
  for (const line of markdown.split('\n')) {
    if (line.startsWith('## ')) dropping = PROMPT_DROPPED_SECTIONS.some((h) => line.startsWith(h));
    else if (line === '---') dropping = true; // 页脚 (来源/模型/模式) 对模型没用
    if (!dropping) out.push(line);
  }
  return out.join('\n').trim();
}

export function saveSessionMemoryMarkdown(workspaceRoot: string, markdown: string): string {
  migrateLegacySessionMemory(workspaceRoot);
  const p = getSessionMemoryFilePath(workspaceRoot);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, markdown, 'utf-8');
  cliLogger.info('SESSION_MEMORY', `saved (${markdown.length} chars) → ${p}`);
  return p;
}

// ============================================================================
// Facade — 提取 + 写盘 一站
// ============================================================================

export interface ExtractAndSaveOptions extends ExtractSessionMemoryOptions {
  workspaceRoot: string;
}

export async function extractAndSaveSessionMemory(
  options: ExtractAndSaveOptions,
): Promise<{ filePath: string; summary: SessionMemorySummary }> {
  const summary = await extractSessionMemory(options);
  const markdown = formatSessionMemoryAsMarkdown(summary);
  const filePath = saveSessionMemoryMarkdown(options.workspaceRoot, markdown);
  return { filePath, summary };
}
