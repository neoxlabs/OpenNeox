
const HINT_LINE = /^(?:[⏱⌚⏰]️?\s*)?\[[^\]\n]*\btook\b[^\]\n]*\]\s*(?:\r?\n|$)/;

export function stripToolHintHeader(text: string): string {
  let out = text.trimStart();
  /* 转发/重试路径上可能被拼过不止一次, 多摘几层; 封顶 3 层防呆 */
  for (let i = 0; i < 3; i += 1) {
    const next = out.replace(HINT_LINE, '').trimStart();
    if (next === out) break;
    out = next;
  }
  return out;
}
