
/** `__unknown__` 是历史占位值, 等同于"没有归属", 不能当成一个会话 id 用 */
export function normalizeEventSessionId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized || normalized === '__unknown__') return undefined;
  return normalized;
}

export function resolveStreamEventSessionId(event: any): string | undefined {
  return normalizeEventSessionId(event?.sessionId)
    || normalizeEventSessionId(event?.session_id)
    || normalizeEventSessionId(event?.data?.sessionId)
    || normalizeEventSessionId(event?.data?.session_id)
    || normalizeEventSessionId(event?.payload?.sessionId)
    || normalizeEventSessionId(event?.payload?.session_id);
}
