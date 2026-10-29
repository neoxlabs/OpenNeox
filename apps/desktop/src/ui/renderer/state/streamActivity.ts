
const lastActivityAt = new Map<string, number>();

/** 有 assistant 增量落到这个会话上 (token / text / reasoning)。热路径, 只写一个数。 */
export function noteStreamActivity(sessionId: string | null | undefined): void {
  if (!sessionId) return;
  lastActivityAt.set(sessionId, Date.now());
}

/** 距离上一次增量过了多久; 从没有过增量返回 Infinity。 */
export function msSinceStreamActivity(sessionId: string | null | undefined): number {
  if (!sessionId) return Infinity;
  const t = lastActivityAt.get(sessionId);
  return t === undefined ? Infinity : Date.now() - t;
}

type FreezeListener = (sessionId: string) => void;
const freezeListeners = new Set<FreezeListener>();

/** 停止时调用: 请求渲染端立刻定格这个会话的流式文本。 */
/** 最近一次"定格"发生在什么时候 —— 打字机组件据此**当场落地**, 不再一个字一个字吐。 */
let lastFreezeAt = 0;
export function msSinceStreamFreeze(): number {
  return lastFreezeAt === 0 ? Infinity : Date.now() - lastFreezeAt;
}

export function requestStreamFreeze(sessionId: string | null | undefined): void {
  if (!sessionId) return;
  lastFreezeAt = Date.now();
  for (const fn of freezeListeners) {
    try { fn(sessionId); } catch { /* 单个订阅者出错不影响其他人 */ }
  }
}

/** 订阅定格请求; 返回退订函数。 */
export function subscribeStreamFreeze(fn: FreezeListener): () => void {
  freezeListeners.add(fn);
  return () => { freezeListeners.delete(fn); };
}

const runEndedAt = new Map<string, number>();

/** run_result 到达 (正常结束/失败/被中断都算)。 */
export function markRunEnded(sessionId: string | null | undefined): void {
  if (!sessionId) return;
  runEndedAt.set(sessionId, Date.now());
}

/**
 * 等这个会话在 `since` 之后收到过 run_result。
 * @returns true = 等到了; false = 超时 (引擎没回收尾)。两种情况调用方都继续 ——
 *          宁可抖一下, 也不能把用户的消息卡住不发。
 */
export async function waitForRunEnd(
  sessionId: string | null | undefined,
  since: number,
  timeoutMs = 2500,
): Promise<boolean> {
  if (!sessionId) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = runEndedAt.get(sessionId);
    if (t !== undefined && t >= since) return true;
    await new Promise<void>((res) => setTimeout(res, 30));
  }
  return false;
}

/** 会话被删/切走时清掉, 别让 Map 无限长。 */
export function forgetStreamActivity(sessionId: string | null | undefined): void {
  if (!sessionId) return;
  lastActivityAt.delete(sessionId);
  runEndedAt.delete(sessionId);
}

/**
 * 等到这个会话的流"安静"下来 (连续 quietMs 没有新增量) 再返回。
 *
 * @returns true = 真的安静了; false = 等到 timeoutMs 还在吐 (上游没理会中断)。
 *          调用方拿 false 也照常继续 —— 宁可抖一下, 也不能把用户的消息卡住不发。
 */
export async function waitForStreamQuiet(
  sessionId: string | null | undefined,
  opts: { quietMs?: number; timeoutMs?: number } = {},
): Promise<boolean> {
  const quietMs = opts.quietMs ?? 180;
  const timeoutMs = opts.timeoutMs ?? 1500;
  if (!sessionId) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (msSinceStreamActivity(sessionId) >= quietMs) return true;
    await new Promise<void>((res) => setTimeout(res, 30));
  }
  return msSinceStreamActivity(sessionId) >= quietMs;
}
