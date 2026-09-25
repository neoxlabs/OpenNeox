
import type { AgenticRuntime } from '../agenticRuntime.js';
import type { AgenticChatHandlers } from '../agenticRuntime.js';
import type { InterruptedRunStore, InterruptedRunRecord } from '../store/InterruptedRunStore.js';
import { repairMessageHistory, type RepairResult } from './repairMessageHistory.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { getPendingAskUserStore } from '../store/PendingAskUserStore.js';

/** caller (server bootstrap) 提供的 emit 钩子 — 把 resume 结果广播到 chat:stream */
export interface ResumeEventEmitter {
  emitResumed(sessionId: string, repaired: RepairResult): void;
  emitFailed(sessionId: string, reason: string): void;
}

export interface ScannerOptions {
  store: InterruptedRunStore;
  agenticRuntime: AgenticRuntime;
  emitter: ResumeEventEmitter;
  /** 当前 server 的标识 — 跟 stale row 的 server_token 比较, 不同 = 真重启 */
  currentServerToken: string;
  /** 默认 30s — 心跳少于这个值不算 stale */
  staleAfterMs?: number;
  /** caller 可以指定 handlers (主要给 onRuntimeEvent 用, 让 resume 跑的事件流也走主链) */
  handlersFactory?: (record: InterruptedRunRecord) => AgenticChatHandlers | undefined;
}

export async function runResumeScanner(opts: ScannerOptions): Promise<void> {
  const { store, emitter, currentServerToken } = opts;

  let staleRows: InterruptedRunRecord[];
  try {
    staleRows = store.findStaleRunning({ staleAfterMs: opts.staleAfterMs ?? 30_000 });
  } catch (err: any) {
    cliLogger.warn('RESUME_SCAN', `findStaleRunning failed: ${err?.message} — skipping`);
    return;
  }

  if (staleRows.length === 0) {
    cliLogger.debug('RESUME_SCAN', 'no stale runs found');
    return;
  }

  cliLogger.info('RESUME_SCAN', `found ${staleRows.length} stale run(s)`,
    { sessions: staleRows.map(r => r.sessionId) });

  for (const row of staleRows) {
    /* 双重验证 — server_token 跟当前 server 一样说明是同一进程, 不是 crash 留下的.
     * 实际只在罕见 race 下会触发 (e.g. heartbeat 卡住但进程还活). 跳过保险. */
    if (row.serverToken && row.serverToken === currentServerToken) {
      cliLogger.warn('RESUME_SCAN',
        `skip session=${row.sessionId} — token matches current server (heartbeat may be stuck)`,
      );
      continue;
    }

    try {
      await resumeOneSession(row, opts);
    } catch (err: any) {
      const msg = err?.message || String(err);
      cliLogger.error('RESUME_SCAN', `resume failed for session=${row.sessionId}: ${msg}`);
      try { store.markErrored(row.sessionId, `resume failed: ${msg}`); } catch { /* noop */ }
      emitter.emitFailed(row.sessionId, msg);
    }
  }
}

async function resumeOneSession(
  row: InterruptedRunRecord,
  opts: ScannerOptions,
): Promise<void> {
  const { store, emitter, currentServerToken } = opts;
  const { sessionId } = row;

  cliLogger.info('RESUME_SCAN', `closing interrupted run session=${sessionId} mode=${row.mode}`,
    { lastHeartbeat: row.lastHeartbeatAt, iteration: row.iteration });

  /* 0. 若 session 还挂着 pending_ask_user (服务在 ask_user 等待用户答案时崩),
   *    跳过自动 resume — agentLoop 续上去也只会拿到 INTERRUPTED tool_result
   *    然后再 LLM 一轮才到 ask 用户. 等用户 submit (replyAskUser handler) 把
   *    真实答案当 tool_result 塞进 messages 后, 那个 handler 自己会触发 chat({isResume:true}).
   *    标 row 为 resumed 防止下次再扫. */
  const pendingAsk = getPendingAskUserStore()?.findBySession(sessionId) ?? [];
  if (pendingAsk.length > 0) {
    cliLogger.info('RESUME_SCAN',
      `skip auto-resume for session=${sessionId} — ${pendingAsk.length} pending ask_user(s); will resume on user submit`);
    store.markResumed(sessionId, currentServerToken);
    /* 仍然 emitResumed 让 UI 知道 server 已重启 (避免 UI 卡在"运行中"). 修补统计走空, 不补 INTERRUPTED. */
    emitter.emitResumed(sessionId, {
      repairedToolCalls: 0,
      droppedPartialMessages: 0,
      totalMessagesAfter: 0,
      ok: true,
      reason: 'awaiting_user_submit',
    });
    return;
  }

  /* 1. 修补 messages 历史 */
  const repair = repairMessageHistory(sessionId);
  if (!repair.ok) {
    throw new Error(repair.reason || 'repair failed');
  }

  store.markCancelled(sessionId);
  emitter.emitResumed(sessionId, repair);
}
