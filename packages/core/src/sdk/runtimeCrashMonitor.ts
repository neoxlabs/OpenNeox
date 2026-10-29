
export interface RuntimeExitInfo {
  /** waitpid 退出码; 被信号带走时是 0 */
  code: number;
  /** 被哪个信号带走的 (正常退出为 null) */
  signal?: NodeJS.Signals | null;
  deliberateClose: boolean;
}

/** 该不该当成原生崩溃记一条。主动关闭永远不算; 有信号或非 0 退出才算。 */
export function isAbnormalRuntimeExit(info: RuntimeExitInfo): boolean {
  if (info.deliberateClose) return false;
  if (info.signal) return true;
  return info.code !== 0;
}

/**
 * 上报一次 runtime 子进程异常退出 (kind:'native', process:'process')。
 *
 * @param since 子进程启动时刻 (ms) —— reporter 只找这之后产生的 .ips。
 * @param ipsDelayMs 等 .ips 落盘的时间 (测试传 0; 缺省 2000)。
 *
 * 全部吞异常: 上报绝不能影响退出处理。
 */
export function reportAbnormalRuntimeExit(params: RuntimeExitInfo & { since: number; ipsDelayMs?: number }): void {
  if (!isAbnormalRuntimeExit(params)) return;
  try {
    void import('@neoxlabs/platform/platform/crashReport/index.js')
      .then((m) => m.getCrashReporter()?.reportRuntimeProcessExit({
        exitCode: params.code,
        signal: params.signal ?? undefined,
        since: params.since,
        ...(params.ipsDelayMs !== undefined ? { ipsDelayMs: params.ipsDelayMs } : {}),
      }))
      .catch(() => { /* 上报失败不影响退出处理 */ });
  } catch {
    /* 动态 import 本身失败也不影响退出处理 */
  }
}
