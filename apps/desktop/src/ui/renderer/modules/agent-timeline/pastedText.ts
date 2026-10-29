
export const PASTE_COLLAPSE_LINES = 12;
export const PASTE_COLLAPSE_CHARS = 1200;

export function shouldCollapsePaste(text: string): boolean {
  if (!text) return false;
  return text.length >= PASTE_COLLAPSE_CHARS || text.split('\n').length > PASTE_COLLAPSE_LINES;
}

export function pasteToken(n: number, text: string, zh: boolean): string {
  const lines = text.split('\n').length;
  return zh ? `[粘贴的文本 #${n} · ${lines} 行]` : `[Pasted text #${n} · ${lines} lines]`;
}

/** 把输入框里还在的占位词换回原文; 不在映射里的方括号原样保留 */
export function expandPastes(text: string, pastes: ReadonlyMap<string, string>): string {
  let out = text;
  for (const [token, body] of pastes) {
    if (out.includes(token)) out = out.split(token).join(body);
  }
  return out;
}

/** 只留输入框里还出现的那些 (占位词被删 = 那段不要了) */
export function prunePastes(text: string, pastes: ReadonlyMap<string, string>): Map<string, string> {
  const next = new Map<string, string>();
  for (const [token, body] of pastes) if (text.includes(token)) next.set(token, body);
  return next;
}
