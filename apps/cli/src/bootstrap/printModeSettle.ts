/**
 * waitForPrintSettlement — `neox -p` 收尾前等后台活落地。
 *
 * 为什么不直接在 printMode 里 sleep 轮询:
 *   · 首轮结束那一刻到底还有没有活, 是「四级信号」的事 (见 core 的 sessionWorkState);
 *   · 「等多久算真的结束了」有两条互相冲突的要求: 普通 `neox -p "问题"` 不能凭空多等,
 *     而后台任务结束 → 通知 → 下一轮之间有空档, 早一拍退出就丢结果;
 *   · 上限 (--timeout / --max-turns / 内部保险丝) 要能单测, 别靠真跑 CLI 才能验。
 *
 * 判据:
 *   1. 首轮结束后的第一次采样就没有任何活 → 立刻收工 (普通问答零额外延迟)。
 *   2. 采样到过活之后, 要求连续 quietMs 都没有活才算收工 —— 覆盖 exit 事件尚未送达、
 *      autoResume 去抖窗口 (1000ms) 这些空档。
 *   3. 一直有活 → 受 deadlineAt (--timeout) 和 maxTurns (--max-turns) 约束;
 *      没给 maxTurns 时用内部保险丝 MAX_CONTINUATION_TURNS, 防「每轮都新起一个后台任务」
 *      把 -p 挂死。
 */

import type { SessionWorkState } from '@neoxlabs/core/sdk/localRuntimeAdapter.js';

export type PrintSettleResult = 'settled' | 'timeout' | 'aborted' | 'turn_limit';

export interface WaitForPrintSettlementOptions {
  /** 采样当前会话活动; 宿主拿不到活动信息 (旧 runtime / daemon 分支) 时回 null = 不等 */
  getState: () => SessionWorkState | null;
  /** AbortSignal —— --timeout 到点 / 用户 Ctrl+C 都会 abort */
  signal?: AbortSignal;
  /** 绝对截止时刻 (epoch ms), 到点返回 'timeout' */
  deadlineAt?: number;
  /** 连续多久没有活才算收工。默认 1000ms, 跟 BackgroundTaskNotifier 的 autoResume 去抖同量级 */
  quietMs?: number;
  /** 采样间隔, 默认 200ms */
  pollMs?: number;
  /** --max-turns: 总共最多跑几轮 (含首轮)。不传 = 不按轮数限 */
  maxTurns?: number;
  /** 内部保险丝: 后台通知最多再拉起几轮。默认 20 */
  maxContinuationTurns?: number;
  /** 单测注入 */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 每次采样 (调试用, 不要往 stdout/stderr 写) */
  onSample?: (state: SessionWorkState, turns: number) => void;
  /** 触发上限 (打 stderr 提示用) */
  onLimit?: (reason: 'max_turns' | 'continuations') => void;
}

/** 内部保险丝 —— 只拦「每轮都新起后台任务」这种真·失控, 正常长任务受 --timeout 管。 */
export const MAX_CONTINUATION_TURNS = 20;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
  });
}

function hasPending(state: SessionWorkState): boolean {
  return state.activeChat
    || state.pendingNotifications
    || state.trackedBackgroundProcesses > 0
    || state.runningSubAgents;
}

export async function waitForPrintSettlement(
  opts: WaitForPrintSettlementOptions,
): Promise<PrintSettleResult> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const quietMs = opts.quietMs ?? 1000;
  const pollMs = opts.pollMs ?? 200;
  const maxContinuations = opts.maxContinuationTurns ?? MAX_CONTINUATION_TURNS;

  /** 已经跑了几轮 —— 首轮算 1, 之后每看到一次 activeChat 由闲转忙就 +1 */
  let turns = 1;
  let prevActive = false;
  /** 观测到过「有活」之后才需要静默窗口; 从没观察到 = 首轮干完就收工 */
  let sawPending = false;
  let quietSince: number | null = null;

  for (;;) {
    if (opts.signal?.aborted) return 'aborted';
    if (opts.deadlineAt !== undefined && now() >= opts.deadlineAt) return 'timeout';

    const state = opts.getState();
    if (!state) return 'settled';

    if (state.activeChat && !prevActive) turns++;
    prevActive = state.activeChat;
    opts.onSample?.(state, turns);

    if (opts.maxTurns !== undefined && turns > opts.maxTurns) {
      opts.onLimit?.('max_turns');
      return 'turn_limit';
    }
    if (turns - 1 > maxContinuations) {
      opts.onLimit?.('continuations');
      return 'turn_limit';
    }

    if (hasPending(state)) {
      sawPending = true;
      quietSince = null;
    } else if (!sawPending) {
      return 'settled';
    } else if (quietSince === null) {
      quietSince = now();
    } else if (now() - quietSince >= quietMs) {
      return 'settled';
    }

    await sleep(pollMs);
  }
}
