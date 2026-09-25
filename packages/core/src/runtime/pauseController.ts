/**
 * PauseController — agentLoop 暂停/恢复控制器
 *
 * 基于 Promise 的挂起/唤醒机制：
 * - requestPause() → 设标志位
 * - agentLoop 在安全点（两轮 LLM 调用之间）检查标志 → 调用 waitForResume() 挂起
 * - resume() → resolve Promise → agentLoop 继续跑
 *
 * 安全点原则：
 * - 不在 LLM 流式输出中间打断
 * - 不在工具执行中间打断
 * - 在循环顶部、当前轮所有工具执行完毕后挂起
 */

import type { Message } from '@neoxlabs/kernel/types/index.js';
import { withWatchdog, envTimeoutMs } from '@neoxlabs/kernel/utils/stallGuard.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

/** 暂停心跳阈值:暂停超过此时长开始打"仍处于暂停"日志(默认 30s) */
const PAUSE_WATCH_MS = envTimeoutMs('NEOX_PAUSE_WATCH_MS', 30_000);
/** 最大暂停时长:超过则自动恢复并告警(0 = 禁用, 纯观测) */
const MAX_PAUSE_MS = envTimeoutMs('NEOX_MAX_PAUSE_MS', 0);

// ============================================================================
// Types
// ============================================================================

export interface ProcessSnapshot {
  /** 进程 ID */
  pid: string;
  /** 完整对话历史（含 tool results） */
  messages: Message[];
  /** 预算状态 */
  budgetState: {
    tokensUsed: number;
    toolCallsUsed: number;
    startTime: number;
    /** 暂停前已消耗的时间（ms） */
    elapsedBeforePause: number;
  };
  /** LLM 调用次数 */
  llmCallCount: number;
  /** 累积工具调用次数 */
  totalToolCalls: number;
  /** 已累积的输出文本 */
  totalText: string;
  /** 暂停时间戳 */
  pausedAt: number;
  role?: string;
  sessionId?: string;
}

// ============================================================================
// PauseController
// ============================================================================

export class PauseController {
  private _paused = false;
  private _resumePromise: Promise<void> | null = null;
  private _resumeResolve: (() => void) | null = null;
  private _snapshot: ProcessSnapshot | null = null;
  private _onSnapshotReady?: (snapshot: ProcessSnapshot) => void;

  /** 当前是否处于暂停状态 */
  get isPaused(): boolean { return this._paused; }

  /** 当前快照（暂停后可用） */
  get snapshot(): ProcessSnapshot | null { return this._snapshot; }

  /**
   * 请求暂停 — 仅设标志位
   * agentLoop 在下一个安全点检查并挂起
   * 不会中断正在进行的 LLM 调用或工具执行
   */
  requestPause(): void {
    if (this._paused) return;
    this._paused = true;
    this._resumePromise = new Promise(resolve => {
      this._resumeResolve = resolve;
    });
  }

  /**
   * 注册快照就绪回调
   * 用于 ProcessManager 在快照可用时持久化到 SQLite
   */
  onSnapshotReady(callback: (snapshot: ProcessSnapshot) => void): void {
    this._onSnapshotReady = callback;
  }

  /**
   * 保存快照 + 挂起等待恢复
   *
   * 在 agentLoop 循环顶部调用。
   * 此时：上一轮 LLM 调用已完成 + 所有工具已执行完毕 + 结果已写入 messages
   * → 安全的暂停点
   *
   * 这个方法会 await 直到 resume() 被调用
   */
  async waitForResume(snapshotData: Omit<ProcessSnapshot, 'pausedAt'>): Promise<void> {
    this._snapshot = { ...snapshotData, pausedAt: Date.now() };

    // 通知外部快照已就绪（ProcessManager 可以持久化）
    this._onSnapshotReady?.(this._snapshot);

    // 挂起 — 直到 resume() 调用 resolve
    if (this._resumePromise) {
      /* 卡死防御:resume()/reset() 是唯一的唤醒源。若因进程崩溃 / 异常路径
       * 未调用, 此处会永久挂起且日志无线索。接入 stallGuard:
       *   · 软看门狗:暂停过久周期性打心跳日志(sessionId / 已暂停时长可见)
       *   · 可选 MAX_PAUSE_MS:超过则自动恢复并告警, 避免"忘了 resume"导致僵死 */
      const sessionId = snapshotData.sessionId;
      const pid = snapshotData.pid;

      let maxPauseTimer: ReturnType<typeof setTimeout> | undefined;
      if (MAX_PAUSE_MS > 0) {
        maxPauseTimer = setTimeout(() => {
          if (this._paused) {
            cliLogger.warn('PAUSE', `⏱️ Max pause ${MAX_PAUSE_MS}ms exceeded — auto-resuming to avoid deadlock`, {
              sessionId, pid, pausedFor: this.getPauseDuration(),
            });
            this.resume();
          }
        }, MAX_PAUSE_MS);
        if (typeof maxPauseTimer?.unref === 'function') maxPauseTimer.unref();
      }

      try {
        await withWatchdog(this._resumePromise, {
          label: 'pause:waitForResume',
          warnAfterMs: PAUSE_WATCH_MS,
          context: { sessionId, pid },
          tag: 'PAUSE',
        });
      } finally {
        if (maxPauseTimer) clearTimeout(maxPauseTimer);
      }
    }
  }

  /**
   * 恢复执行
   * @returns 暂停时保存的快照（用于调整预算等）
   */
  resume(): ProcessSnapshot | null {
    const snap = this._snapshot;
    this._paused = false;
    this._snapshot = null;

    // resolve Promise → agentLoop 从 await 处继续
    this._resumeResolve?.();
    this._resumeResolve = null;
    this._resumePromise = null;

    return snap;
  }

  /**
   * 计算暂停持续时间（ms）
   * 用于恢复后调整预算时钟
   */
  getPauseDuration(): number {
    if (!this._snapshot) return 0;
    return Date.now() - this._snapshot.pausedAt;
  }

  /**
   * 重置控制器状态（进程完成或被 kill 时清理）
   */
  reset(): void {
    this._paused = false;
    this._snapshot = null;
    this._resumeResolve?.();
    this._resumeResolve = null;
    this._resumePromise = null;
  }
}


const controllers = new Map<string, PauseController>();

/** 拿这个会话的控制器, 没有就建一个。 */
export function getPauseController(sessionId: string): PauseController {
  let c = controllers.get(sessionId);
  if (!c) { c = new PauseController(); controllers.set(sessionId, c); }
  return c;
}

/** 只看不建 —— 查状态用, 别为了查一下就凭空造一个出来。 */
export function peekPauseController(sessionId: string): PauseController | undefined {
  return controllers.get(sessionId);
}

/**
 * 请求暂停。返回 false = 这个会话没在跑 (没有控制器), 调用方该如实告诉用户,
 * 而不是显示成"已暂停"。
 */
export function pauseSession(sessionId: string): boolean {
  const c = controllers.get(sessionId);
  if (!c || c.isPaused) return false;
  c.requestPause();
  return true;
}

export function clearSessionPause(sessionId: string): void {
  controllers.get(sessionId)?.reset();
}

/** 恢复。返回 false = 它本来就没暂停。 */
export function resumeSession(sessionId: string): boolean {
  const c = controllers.get(sessionId);
  if (!c || !c.isPaused) return false;
  c.resume();
  return true;
}

export function isSessionPaused(sessionId: string): boolean {
  return controllers.get(sessionId)?.isPaused === true;
}

export function disposePauseController(sessionId: string): void {
  const c = controllers.get(sessionId);
  if (!c) return;
  c.reset();
  controllers.delete(sessionId);
}

/**
 * 适配成 runner 认的 PauseGate。
 *
 * 两处对不上, 所以要这一层而不是直接传:
 *   · PauseController.isPaused 是 getter, PauseGate 要的是方法
 *   · waitForResume 要一份 ProcessSnapshot, 而 runner 只知道 sessionId/iteration/toolCalls
 *
 * 快照这里**只填 runner 真的知道的那几个字段**, 其余给零值 —— 不去假装拿到了完整
 * 对话历史。快照的用途是"恢复后调预算时钟"和给 ProcessManager 持久化, 编一份假的
 * messages 进去只会让下游以为自己拿到了真历史。
 */
export function toPauseGate(c: PauseController): PauseGateLike {
  return {
    isPaused: () => c.isPaused,
    waitForResume: (ctx) => c.waitForResume({
      pid: ctx.sessionId || 'unknown',
      messages: [],
      budgetState: { tokensUsed: 0, toolCallsUsed: ctx.toolCalls, startTime: Date.now(), elapsedBeforePause: 0 },
      llmCallCount: ctx.iteration,
      totalToolCalls: ctx.toolCalls,
      totalText: '',
      sessionId: ctx.sessionId,
    }),
    /* reset 同时清标志和唤醒等待者 —— 停止 / run 结束时 runner 调它 */
    cancel: () => c.reset(),
  };
}

/** 跟 kernel 的 PauseGate 同形 —— 不 import 它, 免得 core 跟 kernel 的类型互相拽。 */
export interface PauseGateLike {
  isPaused(): boolean;
  waitForResume(ctx: { sessionId: string; iteration: number; toolCalls: number }): Promise<void>;
  cancel?(): void;
}
