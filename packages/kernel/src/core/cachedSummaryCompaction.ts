/**
 * Compaction by summarizing on the conversation's own cached prefix.
 *
 * The summary request is the conversation exactly as the next turn would send it (same system
 * prompt, same tools, same messages) plus one user message asking for a summary. The whole
 * prefix is a cache hit, so the cost is one request whose time is mostly the summary output.
 * The old path re-sent the history as flattened text in dozens of per-category requests with
 * their own prompts: zero cache hits, and four minutes for a 400K-token session in a CLI trial.
 *
 * After the summary comes back the history is rebuilt as
 *   the system messages (prompt, project memory; unchanged, so their cache still hits)
 *   + one work-record message holding the summary
 *   + the latest user message
 *   + unfinished work state (todo / plan) re-injected by the caller.
 * That lands a session back near its starting size (system prompt + tools + a few K),
 * whatever size it had grown to.
 */

import type { LLMProvider, Message, Tool } from '../types/index.js';
import { estimateTokensFromMessages } from '../compat/memoryPressure.js';
import { estimateTokens } from '../utils/tokenEstimate.js';
import { getTextFromContent } from '../utils/messageUtils.js';

import { COMPACTION_SUMMARY_MARKER, isCompactionSummaryMessage } from '../utils/compression/llmSummarizer.js';
import { buildUserQuotesSection, capTaskAnchorMessage, findTaskAnchorIndex } from '../utils/compression/taskAnchor.js';
import { isStreamRecoveredChunk, isStreamRetryChunk } from './runnerHeadDefs.js';

/** Below this much summarizable history a summary saves nothing worth a request. */
export const MIN_SUMMARIZABLE_TOKENS = 6_000;

/** Output budget for the summary call. The prompt asks for ~2.5K tokens; the rest is headroom
 * for reasoning models, whose thinking counts against max_tokens. */
export const SUMMARY_MAX_OUTPUT_TOKENS = 16_000;


export const CACHED_SUMMARY_PROMPT = `请先暂停手头的工作，不要调用任何工具。

这段对话马上要被压缩：你现在写的摘要会**替代**上面全部的历史消息（系统提示词保留），之后你只能依据这份摘要继续工作。请写一份详细、准确、拿来就能接着干活的工作记录，按下面的分节输出，某节没有内容就写「无」：

1. 用户目标与要求：用户要做成什么；所有明确提过的要求、约束、偏好，以及被否决的做法（尽量保留原话要点）。
2. 待办与进度：还没完成的事项（TODO / 计划里的每一步及其状态），当前正在做哪一步。
3. 已完成的工作：做了什么、得出什么结论、关键决定及理由。
4. 文件与代码：创建或修改过的文件路径，每个文件改了什么；关键函数、配置、接口的位置和要点。
5. 关键工具信息：仍在运行的后台进程（pid、命令、端口）、服务地址、账号、环境变量、测试和构建命令及最近一次结果、遇到过的报错和解决办法。
6. 最近状态：最后几次工具调用的结果要点，以及下一步打算做什么。

要求：
- 写具体的路径、命令、数字和报错原文，不写空话。
- 历史里如果已经有更早的工作记录（以 "${COMPACTION_SUMMARY_MARKER}" 开头），把其中仍然有效的内容并入对应分节，不要丢。
- 用这段对话使用的语言书写。
- 总长度控制在 2500 token 以内。
- 只输出工作记录正文，不要寒暄，不要调用工具。`;

/** System messages other than an earlier work record: prompt, project memory, tagged context.
 * They survive compaction wherever they sit; a prompt that ended up behind the history (a
 * resumed session) was otherwise summarized away with it. */
function isKeptSystem(message: Message): boolean {
  return message.role === 'system' && !isCompactionSummaryMessage(message);
}

function lastUserIndex(messages: Message[], from: number): number {
  for (let i = messages.length - 1; i >= from; i--) {
    if (messages[i].role === 'user') return i;
  }
  return -1;
}

/** Tokens a summary would replace: everything after the system prefix except the latest user message. */
export function summarizableTokens(messages: Message[]): number {
  const lastUser = lastUserIndex(messages, 0);
  return estimateTokensFromMessages(messages.filter((m, i) => !isKeptSystem(m) && i !== lastUser));
}

export function hasEnoughToSummarize(messages: Message[]): boolean {
  return summarizableTokens(messages) >= MIN_SUMMARIZABLE_TOKENS;
}

/** The summary request: the wire messages as the next turn would send them, plus the prompt. */
export function buildSummaryRequest(wireMessages: Message[]): Message[] {
  return [...wireMessages, { role: 'user', content: CACHED_SUMMARY_PROMPT }];
}


/**
 * Rebuild the history around a summary. Everything between the system prefix and the latest
 * user message, and everything after it, is replaced by the summary; nothing with a tool call
 * survives, so no tool_call / tool_result pair can be left half.
 */
export function rebuildAfterSummary(messages: Message[], summary: string): { messages: Message[]; summarizedCount: number } {
  const kept = messages.filter(isKeptSystem);
  const lastUser = lastUserIndex(messages, 0);
  /* 任务正文（首条用户消息）单独留一份：摘要只写转述，用户交代的要求原文不能只剩转述。 */
  const taskAnchor = findTaskAnchorIndex(messages);
  const anchorKept = taskAnchor >= 0 && taskAnchor !== lastUser;
  const summarizedCount = messages.length - kept.length - (lastUser >= 0 ? 1 : 0) - (anchorKept ? 1 : 0);
  const record: Message = {
    role: 'system',
    content: `${COMPACTION_SUMMARY_MARKER} — ${summarizedCount} earlier messages summarized]\n\n`
      + '以下是本会话此前工作的完整记录（原消息已压缩）。继续工作时以它为准，不要重复已经完成的步骤；'
      + '原始任务与最新一条用户消息在后面（均为原话）。\n\n'
      + summary.trim(),
  };
  const quotes = buildUserQuotesSection(messages, [taskAnchor, lastUser]);
  const rebuilt = [...kept];
  if (anchorKept) rebuilt.push(capTaskAnchorMessage(messages[taskAnchor]!));
  rebuilt.push(quotes ? { ...record, content: record.content + quotes } : record);
  if (lastUser >= 0) rebuilt.push(capTaskAnchorMessage(messages[lastUser]));
  return { messages: rebuilt, summarizedCount };
}

export function rebuildWithSpeculativeSummary(
  messages: Message[], summary: string, summarizedUpTo: number,
): { messages: Message[]; summarizedCount: number } {
  const kept = messages.filter(isKeptSystem);
  const head = messages.slice(0, summarizedUpTo);
  const tail = messages.slice(summarizedUpTo).filter((m) => !isKeptSystem(m));
  const lastUser = lastUserIndex(messages, 0);
  /* 首条用户消息（任务正文）落在被摘要的那段里时同样单独留一份。 */
  const taskAnchor = findTaskAnchorIndex(messages);
  const anchorSummarized = taskAnchor >= 0 && taskAnchor < summarizedUpTo && taskAnchor !== lastUser;
  const summarizedCount = head.filter((m) => !isKeptSystem(m)).length
    - (lastUser >= 0 && lastUser < summarizedUpTo ? 1 : 0)
    - (anchorSummarized ? 1 : 0);
  const record: Message = {
    role: 'system',
    content: `${COMPACTION_SUMMARY_MARKER} — ${summarizedCount} earlier messages summarized]\n\n`
      + '以下是本会话此前工作的完整记录（原消息已压缩）。继续工作时以它为准，不要重复已经完成的步骤；'
      + '之后的消息原样保留在后面。\n\n'
      + summary.trim(),
  };
  const quotes = buildUserQuotesSection(messages.slice(0, summarizedUpTo), [taskAnchor, lastUser]);
  const rebuilt: Message[] = [...kept];
  if (anchorSummarized) rebuilt.push(capTaskAnchorMessage(messages[taskAnchor]!));
  rebuilt.push(quotes ? { ...record, content: record.content + quotes } : record);
  if (lastUser >= 0 && lastUser < summarizedUpTo) rebuilt.push(capTaskAnchorMessage(messages[lastUser]));
  rebuilt.push(...tail);
  return { messages: rebuilt, summarizedCount };
}

/** 一段消息的指纹: 预做摘要之后这段要是被改过 (轻量压缩改写了旧工具结果 / 回滚), 摘要就不能用 */
export function messagesFingerprint(messages: Message[]): string {
  let h = 2166136261;
  const s = JSON.stringify(messages.map((m) => [m.role, typeof m.content === 'string' ? m.content : getTextFromContent(m.content as any), m.tool_call_id ?? '', (m.tool_calls ?? []).map((t: any) => t?.id ?? '').join(',')]));
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `${messages.length}:${(h >>> 0).toString(36)}:${s.length}`;
}

/** A summary this short did not really summarize anything (refusal, tool-call-only reply). */
export function isUsableSummary(summary: string): boolean {
  return estimateTokens(summary.trim()) >= 200;
}

/** The request itself did not fit the window: only then do the per-category summaries take over. */
export function isContextOverflowError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /prompt is too long|context length exceeded|maximum context length|context_length_exceeded|too many tokens/i.test(message);
}

/** Summary length the prompt asks for; the progress estimate measures output against it. */
const EXPECTED_SUMMARY_TOKENS = 2_500;
/** Share of the bar given to the wait before the summary text starts (prefill, thinking). */
const PRE_OUTPUT_SHARE = 15;
/** The estimate never claims to be done; 100 comes only from the finished request. */
const MAX_ESTIMATED_PERCENT = 95;

export function estimateSummaryPercent(summaryTokens: number, reasoningTokens: number, elapsedMs: number): number {
  const waiting = 1 - Math.exp(-(elapsedMs / 20_000 + reasoningTokens / 4_000));
  const pre = PRE_OUTPUT_SHARE * waiting;
  if (summaryTokens <= 0) return Math.floor(pre);
  const writing = 1 - Math.exp(-summaryTokens / EXPECTED_SUMMARY_TOKENS * 1.6);
  const percent = pre + (MAX_ESTIMATED_PERCENT - pre) * writing;
  return Math.min(MAX_ESTIMATED_PERCENT, Math.floor(percent));
}

/** Streamed progress of the summary request: estimated percent and output tokens so far. */
export interface SummaryStreamProgress {
  percent: number;
  outputTokens: number;
}

/**
 * Send the summary request and collect the text. Same options as a turn (model, tools,
 * temperature...), so nothing but the appended prompt differs from the cached prefix.
 */
export async function requestCachedPrefixSummary(
  provider: LLMProvider,
  wireMessages: Message[],
  options: {
    model: string; tools: Tool[]; temperature?: number; maxInputTokens?: number;
    disableSystemPrompt?: boolean; enableFGTS?: boolean; signal?: AbortSignal; effortLevel?: string;
  },
  onProgress?: (progress: SummaryStreamProgress) => void,
): Promise<string> {
  const startedAt = Date.now();
  const stream = provider.chatStreamed(buildSummaryRequest(wireMessages), {
    ...options, maxTokens: SUMMARY_MAX_OUTPUT_TOKENS,
  } as any);
  let summary = '';
  let reasoning = '';
  let usage: Record<string, any> | undefined;
  /* Reported when the percent moves, and on a timer so the bar also moves during prefill,
   * when no chunk arrives at all. */
  let lastPercent = -1;
  const report = () => {
    if (!onProgress) return;
    const summaryTokens = estimateTokens(summary);
    const reasoningTokens = estimateTokens(reasoning);
    const percent = estimateSummaryPercent(summaryTokens, reasoningTokens, Date.now() - startedAt);
    /* Only forward: a provider retry restarts the text, the bar must not jump back. */
    if (percent <= lastPercent) return;
    lastPercent = percent;
    try { onProgress({ percent, outputTokens: summaryTokens + reasoningTokens }); } catch { /* display only */ }
  };
  const ticker = onProgress ? setInterval(report, 500) : null;
  try {
    for await (const chunk of stream) {
      /* A provider retry restarts the request and streams it again from the start. */
      if (isStreamRetryChunk(chunk) || isStreamRecoveredChunk(chunk)) { summary = ''; reasoning = ''; continue; }
      const delta = chunk?.choices?.[0]?.delta;
      if (typeof delta?.content === 'string') summary += delta.content;
      if (typeof delta?.reasoning_content === 'string') reasoning += delta.reasoning_content;
      if (chunk?.usage) usage = chunk.usage;
      report();
    }
  } finally {
    if (ticker) clearInterval(ticker);
  }
  const promptTokens = usage?.prompt_tokens ?? 0;
  const cachedTokens = usage?.prompt_cache_hit_tokens ?? usage?.cache_read_input_tokens
    ?? usage?.prompt_tokens_details?.cached_tokens ?? usage?.cached_tokens ?? 0;
  void import('../utils/stallGuard.js').then(({ writeStallFile }) => {
    writeStallFile('info', 'COMPACT_SUMMARY', 'cached-prefix summary request', {
      ms: Date.now() - startedAt,
      promptTokens,
      cachedTokens,
      cacheHitRatio: promptTokens > 0 ? Number((cachedTokens / promptTokens).toFixed(3)) : null,
      completionTokens: usage?.completion_tokens ?? 0,
      summaryChars: summary.length,
    });
  }).catch(() => { /* diagnostics must not break compaction */ });
  return summary;
}

/**
 * A resumed session whose history starts with a compaction work record has no system prompt yet
 * (the record is a system message but not a prompt), and memory.add() appends: the prompt landed
 * behind the whole history. The next compaction then summarized it away and the model ran on
 * without it (CLI trial: 12.9K context, less than the 17.9K a fresh session starts at).
 * Put it in front, where a fresh session has it.
 */
export function movePromptAheadOfHistory(
  memory: { getMessagesForLLM(): Message[]; setMessages(messages: Message[]): void },
  prompt: string,
): void {
  const all = memory.getMessagesForLLM();
  const last = all[all.length - 1];
  /* add() skips a system message identical to one already present; move only what it added. */
  if (last?.role === 'system' && last.content === prompt) memory.setMessages([last, ...all.slice(0, -1)]);
}
