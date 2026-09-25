/**
 * Deduplicate user messages while ignoring an injected current-time tail.
 *
 * The runtime may append a current-time marker to stored messages. Both sides
 * are normalized before applying the equality or prefix comparison.
 */

const CURRENT_TIME_TAIL = /\s*<current-time>[^<]*<\/current-time>\s*$/;

/** 去掉尾部注入的 <current-time> 标记 (没有就原样返回)。 */
export function stripInjectedTimeTail(text: string): string {
  return text.replace(CURRENT_TIME_TAIL, '');
}

/**
 * 历史里这条用户消息与本次 task 是否"同一句话" (忽略两边尾部的时间标记)。
 * 口径与原判据一致: 完全相等, 或 task 以历史内容为前缀且多出的部分 < 600 字符 (注入的附加内容)。
 * 历史内容剥完为空时一律 false —— 否则 startsWith 恒真, 会把用户的话吃掉。
 */
export function isSameUserMessage(historyContent: string, task: string): boolean {
  const h = stripInjectedTimeTail(historyContent);
  if (h.length === 0) return false;
  const t = stripInjectedTimeTail(task);
  return h === t || (t.startsWith(h) && t.length - h.length < 600);
}
