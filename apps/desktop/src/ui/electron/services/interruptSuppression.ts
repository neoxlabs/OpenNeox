
export type SuppressibleState = 'idle' | 'running' | 'recovering';

export const INTERRUPT_SUPPRESS_MAX_MS = 90_000;

export function shouldSuppressRunningAfterInterrupt(args: {
  next: SuppressibleState;
  reason: string;
  /** 用户点停止的时刻; undefined = 这个会话没被中断过 */
  interruptedAt: number | undefined;
  /** 中断之后是否又收到过该会话的内容产出 (token / tool 等) */
  sawActivityAfterInterrupt: boolean;
  now: number;
}): boolean {
  const { next, reason, interruptedAt, sawActivityAfterInterrupt, now } = args;
  if (interruptedAt === undefined) return false;
  if (next !== 'running' && next !== 'recovering') return false;
  /* 用户自己发的新消息 = 新一轮, 抑制不适用 —— 否则就从"停不下来"变成"发了消息不动" */
  if (reason === 'send:start' || reason === 'send:accepted') return false;
  /* agent 还在真产出 = abort 没生效, 必须如实显示 */
  if (sawActivityAfterInterrupt) return false;
  return now - interruptedAt < INTERRUPT_SUPPRESS_MAX_MS;
}
