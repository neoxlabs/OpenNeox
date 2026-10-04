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
import { truncateUtf16Safe, takeUtf16SafeTail } from '../utils/wireText.js';
import { COMPACTION_SUMMARY_MARKER, isCompactionSummaryMessage } from '../utils/compression/llmSummarizer.js';
import { isStreamRecoveredChunk, isStreamRetryChunk } from './runnerHeadDefs.js';

/** Below this much summarizable history a summary saves nothing worth a request. */
export const MIN_SUMMARIZABLE_TOKENS = 6_000;

/** Output budget for the summary call. The prompt asks for ~2.5K tokens; the rest is headroom
 * for reasoning models, whose thinking counts against max_tokens. */
export const SUMMARY_MAX_OUTPUT_TOKENS = 16_000;

/** The latest user message is kept verbatim up to this size; beyond it, head and tail. */
const LAST_USER_MAX_CHARS = 8_000;

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

function capLastUser(message: Message): Message {
  if (typeof message.content !== 'string') {
    const text = getTextFromContent(message.content as any);
    if (text.length <= LAST_USER_MAX_CHARS) return message;
    return { ...message, content: capText(text) };
  }
  if (message.content.length <= LAST_USER_MAX_CHARS) return message;
  return { ...message, content: capText(message.content) };
}

function capText(text: string): string {
  const head = truncateUtf16Safe(text, Math.floor(LAST_USER_MAX_CHARS * 0.75));
  const tail = takeUtf16SafeTail(text, Math.floor(LAST_USER_MAX_CHARS * 0.25));
  return `${head}\n\n[... ${text.length - head.length - tail.length} chars omitted ...]\n\n${tail}`;
}

/**
 * Rebuild the history around a summary. Everything between the system prefix and the latest
 * user message, and everything after it, is replaced by the summary; nothing with a tool call
 * survives, so no tool_call / tool_result pair can be left half.
 */
export function rebuildAfterSummary(messages: Message[], summary: string): { messages: Message[]; summarizedCount: number } {
  const kept = messages.filter(isKeptSystem);
  const lastUser = lastUserIndex(messages, 0);
  const summarizedCount = messages.length - kept.length - (lastUser >= 0 ? 1 : 0);
  const record: Message = {
    role: 'system',
    content: `${COMPACTION_SUMMARY_MARKER} — ${summarizedCount} earlier messages summarized]\n\n`
      + '以下是本会话此前工作的完整记录（原消息已压缩）。继续工作时以它为准，不要重复已经完成的步骤；'
      + '最新一条用户消息在后面。\n\n'
      + summary.trim(),
  };
  const rebuilt = [...kept, record];
  if (lastUser >= 0) rebuilt.push(capLastUser(messages[lastUser]));
  return { messages: rebuilt, summarizedCount };
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
): Promise<string> {
  const startedAt = Date.now();
  const stream = provider.chatStreamed(buildSummaryRequest(wireMessages), {
    ...options, maxTokens: SUMMARY_MAX_OUTPUT_TOKENS,
  } as any);
  let summary = '';
  let usage: Record<string, any> | undefined;
  for await (const chunk of stream) {
    /* A provider retry restarts the request and streams it again from the start. */
    if (isStreamRetryChunk(chunk) || isStreamRecoveredChunk(chunk)) { summary = ''; continue; }
    const delta = chunk?.choices?.[0]?.delta;
    if (typeof delta?.content === 'string') summary += delta.content;
    if (chunk?.usage) usage = chunk.usage;
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
