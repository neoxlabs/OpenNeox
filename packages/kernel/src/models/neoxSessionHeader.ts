export type NeoxSessionProvider = () => string | undefined;

let provider: NeoxSessionProvider | null = null;

export function setNeoxSessionProvider(p: NeoxSessionProvider | null): void {
  provider = p;
}

/** 当前调用所属的主会话 id; 取不到返回 undefined (调用方据此不发头) */
export function currentNeoxSessionId(): string | undefined {
  try {
    const id = provider?.();
    if (!id) return undefined;
    /* 头值只能是可见 ASCII; 会话 id 本来就是 uuid / 字母数字, 这里只做防御性截断 */
    const safe = String(id).replace(/[^\x21-\x7e]/g, '').slice(0, 128);
    return safe || undefined;
  } catch {
    return undefined;
  }
}
