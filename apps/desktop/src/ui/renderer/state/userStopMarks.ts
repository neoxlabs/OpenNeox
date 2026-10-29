
const marks = new Map<string, number>();

/** 用户按下停止 */
export function markUserStopped(sessionId: string): void {
  if (!sessionId) return;
  marks.set(sessionId, Date.now());
}

/**
 * 这个会话是不是刚被用户停过。
 * withinMs 给得比较宽 (默认 20s): 工具的 abort 结果可能要等上游超时才回来,
 * 但又不能无限期 —— 否则下一轮真出错也会被误判成"用户停的"。
 * 新一轮发送时 clearUserStopMark 会主动清掉, 这个窗口只是兜底。
 */
export function wasRecentlyStoppedByUser(sessionId: string, withinMs = 20_000): boolean {
  if (!sessionId) return false;
  const t = marks.get(sessionId);
  if (t === undefined) return false;
  if (Date.now() - t > withinMs) {
    marks.delete(sessionId);
    return false;
  }
  return true;
}

/** 新一轮开始 / 会话删除 —— 标记作废 */
export function clearUserStopMark(sessionId: string): void {
  if (!sessionId) return;
  marks.delete(sessionId);
}
