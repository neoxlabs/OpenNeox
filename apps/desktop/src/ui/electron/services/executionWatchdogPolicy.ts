
/** 单轮软上界 —— 超过就必须说话 (不强制收敛, 可能真的在跑一个很长的工具) */
export const EXECUTION_HARD_CEILING_MS = 8 * 60_000;
/** 事件间隔阈值 —— 低于它说明流还活着, 继续观察 */
export const WATCHDOG_IDLE_RENEW_MS = 170_000;

export interface WatchdogInput {
  /** 距离最近一次 SSE 事件的毫秒数 */
  idleForMs: number;
  /** 本轮第一次武装看门狗至今的毫秒数 (续期不刷新) */
  totalMs: number;
  /** 这一轮是否已经报过长跑告警 */
  alreadyNotifiedLongRun: boolean;
}

export interface WatchdogDecision {
  /** 是否要发一条"本轮已运行 N 分钟"的可见告警 */
  warnLongRun: boolean;
  /** 告警里显示的分钟数 (warnLongRun 为 false 时无意义) */
  longRunMinutes: number;
  /** 是否只续期继续观察 —— true 表示流还活着, 不进入收敛判定 */
  renewOnly: boolean;
}

export function evaluateExecutionWatchdog(input: WatchdogInput): WatchdogDecision {
  const { idleForMs, totalMs, alreadyNotifiedLongRun } = input;

  const warnLongRun = totalMs > EXECUTION_HARD_CEILING_MS && !alreadyNotifiedLongRun;

  return {
    warnLongRun,
    longRunMinutes: Math.round(totalMs / 60_000),
    renewOnly: idleForMs < WATCHDOG_IDLE_RENEW_MS,
  };
}
