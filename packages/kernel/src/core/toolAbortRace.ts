
/** 工具在 abort 后仍不返回的哨兵值 —— 调用方用 `=== TOOL_ABANDONED` 判定。 */
export const TOOL_ABANDONED: unique symbol = Symbol('neox.toolAbandoned');
export type ToolAbandoned = typeof TOOL_ABANDONED;

export const DEFAULT_TOOL_ABORT_GRACE_MS = 3000;

export interface ToolAbortRaceOptions {
  /** abort 之后还愿意等多久 (ms)。默认 3000。 */
  graceMs?: number;
  /** 工具没响应 abort、本端先放弃等待时调一次。 */
  onAbandoned?: (info: { waitedMs: number }) => void;
  /** 放弃之后工具才真正 settle —— 结果已丢弃，这里只用来记日志。 */
  onLateSettle?: (info: {
    outcome: 'fulfilled' | 'rejected';
    /** 从 abort 到工具真正 settle 的毫秒数 */
    afterAbortMs: number;
    error?: unknown;
  }) => void;
  /** 注入时钟 (测试用)，默认 Date.now。 */
  now?: () => number;
}

/**
 * 等工具完成，但 abort 之后最多再等 `graceMs`。
 *
 * - 正常完成 / abort 后及时返回 → 返回工具结果，行为与直接用 await 一致；
 * - abort 后超过 graceMs 仍未返回 → 返回 `TOOL_ABANDONED`，promise 留在后台，
 *   它迟到的结果（含 rejection）在这里被吞掉，绝不会回到调用方；
 * - 没给 signal → 直接 await（CLI 进程内 / SDK 不传信号的场合行为不变）。
 */
export function awaitToolWithAbort<T>(
  run: Promise<T>,
  signal: AbortSignal | undefined,
  options: ToolAbortRaceOptions = {},
): Promise<T | ToolAbandoned> {
  if (!signal) return run;

  const graceMs = Number.isFinite(options.graceMs) ? Math.max(0, Number(options.graceMs)) : DEFAULT_TOOL_ABORT_GRACE_MS;
  const now = options.now ?? Date.now;

  return new Promise<T | ToolAbandoned>((resolve, reject) => {
    let done = false;
    let abandonedAt: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const onAbort = () => {
      if (done || timer) return;
      abandonedAt = now();
      timer = setTimeout(() => {
        timer = null;
        if (done) return;
        done = true;
        cleanup();
        options.onAbandoned?.({ waitedMs: now() - (abandonedAt ?? now()) });
        resolve(TOOL_ABANDONED);
      }, graceMs);
      /* 不让兜底计时器吊住进程退出 (CLI 按 Esc 后立刻退出不该被这 3 秒挡住)。 */
      (timer as unknown as { unref?: () => void }).unref?.();
    };

    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });

    run.then(
      (value) => {
        if (done) {
          /* 已经放弃等待: 结果丢弃，只留一行日志 (给以后 LOOP-13 用)。 */
          options.onLateSettle?.({ outcome: 'fulfilled', afterAbortMs: now() - (abandonedAt ?? now()) });
          return;
        }
        done = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (done) {
          options.onLateSettle?.({ outcome: 'rejected', afterAbortMs: now() - (abandonedAt ?? now()), error });
          return;
        }
        done = true;
        cleanup();
        reject(error);
      },
    );
  });
}
