/**
 * 往输入框里放一段文字 (esc 中断且模型还没开口时, 把刚发的消息放回去, 改一改就能重发)。
 * 输入框的值是 App 内部 state, 外部 (main 的中断路径) 够不着 —— 走这个小总线。
 * App 只在输入框为空时接收, 不覆盖用户已经开始打的字。
 */
const listeners = new Set<(text: string) => void>();

export function requestInputPrefill(text: string): void {
  for (const fn of listeners) {
    try { fn(text); } catch { /* */ }
  }
}

export function onInputPrefill(fn: (text: string) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
