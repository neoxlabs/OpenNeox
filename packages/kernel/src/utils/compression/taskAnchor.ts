
import type { Message } from '../../types/index.js';
import { getTextFromContent } from '../messageUtils.js';
import { truncateUtf16Safe, takeUtf16SafeTail } from '../wireText.js';

/** 单条用户消息超过这个长度才允许截断 —— 任务正文通常远小于它。 */
export const TASK_ANCHOR_MAX_CHARS = 20_000;

export const USER_QUOTE_MAX_CHARS = 2_000;

export const USER_QUOTES_TOTAL_MAX_CHARS = 12_000;

/** 降级行保留的原文前缀长度：更早的消息只留前 80 字 + 「…」。 */
export const USER_QUOTE_OVERFLOW_HEAD_CHARS = 80;

/** 是否可能是任务正文：真正由用户写的 user 消息（有正文）。 */
export function isUserTaskMessage(message: Message | null | undefined): boolean {
  if (!message || message.role !== 'user') return false;
  return getTextFromContent(message.content as any).trim().length > 0;
}

/** 首条用户消息的下标；没有则 -1。 */
export function findTaskAnchorIndex(messages: Message[]): number {
  for (let i = 0; i < messages.length; i++) {
    if (isUserTaskMessage(messages[i])) return i;
  }
  return -1;
}

/** 首条用户消息本身；没有则 null。 */
export function findTaskAnchor(messages: Message[]): Message | null {
  const index = findTaskAnchorIndex(messages);
  return index >= 0 ? messages[index]! : null;
}

/**
 * 任务正文的内容上限：不超过 TASK_ANCHOR_MAX_CHARS 原样返回（同一个字符串引用），
 * 超过才保留头 75% / 尾 25%，并在截断处写明原文长度与省略量。
 */
export function capTaskAnchorText(text: string): string {
  if (text.length <= TASK_ANCHOR_MAX_CHARS) return text;
  const head = truncateUtf16Safe(text, Math.floor(TASK_ANCHOR_MAX_CHARS * 0.75));
  const tail = takeUtf16SafeTail(text, Math.floor(TASK_ANCHOR_MAX_CHARS * 0.25));
  const omitted = text.length - head.length - tail.length;
  return `${head}\n\n…(原文共 ${text.length} 字, 此处省略 ${omitted} 字)…\n\n${tail}`;
}

/**
 * 任务消息的裁剪版本。字符串内容按 capTaskAnchorText 处理；多模态消息保持原样
 * （图片等附件不是任务正文，混进纯文本会丢附件）。
 */
export function capTaskAnchorMessage(message: Message): Message {
  if (typeof message.content !== 'string') return message;
  const capped = capTaskAnchorText(message.content);
  return capped === message.content ? message : { ...message, content: capped };
}

export function capUserQuote(text: string): string {
  if (text.length <= USER_QUOTE_MAX_CHARS) return text;
  const head = truncateUtf16Safe(text, Math.floor(USER_QUOTE_MAX_CHARS * 0.75));
  const tail = takeUtf16SafeTail(text, Math.floor(USER_QUOTE_MAX_CHARS * 0.25));
  const omitted = text.length - head.length - tail.length;
  return `${head}\n…(本条原文共 ${text.length} 字, 此处省略 ${omitted} 字)…\n${tail}`;
}

/**
 * 被摘要掉的那段里，用户自己说过的话逐条留一份 —— 摘要器只会写转述，
 * 用户提过的约束/否决/补充往往就在这些短句里。
 *
 * @param skip 不收集的下标（首条任务正文、最新一条用户消息已经单独保留）。
 * @returns 要接在摘要记录后面的章节；没有可收集的消息时返回空串。
 */
export function buildUserQuotesSection(messages: Message[], skip: number[] = []): string {
  const skipSet = new Set(skip.filter((i) => i >= 0));
  const entries: { index: number; text: string; capped: string }[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    if (skipSet.has(i) || messages[i]!.role !== 'user') continue;
    const text = getTextFromContent(messages[i]!.content as any).trim();
    if (!text) continue;
    entries.push({ index: i, text, capped: capUserQuote(text) });
  }
  if (entries.length === 0) return '';

  /* 逐字保留的合计有上限：从最近一条往前取，装满预算为止；更早的（超出部分）
   * 只留前 80 字 + 「…」，避免摘要自己膨胀成第二份历史。 */
  let budget = USER_QUOTES_TOTAL_MAX_CHARS;
  let firstVerbatim = entries.length;
  for (let k = entries.length - 1; k >= 0; k -= 1) {
    const len = entries[k]!.capped.length;
    if (len > budget) break;
    budget -= len;
    firstVerbatim = k;
  }

  const lines: string[] = [];
  for (let k = 0; k < entries.length; k += 1) {
    const e = entries[k]!;
    if (k >= firstVerbatim) {
      lines.push(`- [第 ${e.index + 1} 条] ${e.capped}`);
    } else {
      const head = truncateUtf16Safe(e.text, USER_QUOTE_OVERFLOW_HEAD_CHARS);
      lines.push(`- [第 ${e.index + 1} 条] ${head}…`);
    }
  }
  return '\n\n## 用户原话（中间消息，逐条保留）\n\n' + lines.join('\n');
}
