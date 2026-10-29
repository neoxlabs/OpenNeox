import { EventEmitter } from 'events';
import { evaluateExecutionWatchdog } from './executionWatchdogPolicy.js';
import { randomUUID } from 'crypto';
import path from 'path';
import type {
  ChatRequestPayload,
  ChatResponsePayload,
  StreamEvent,
  ChatMessage,
} from '../../shared/ipc';
/* Message / SQLiteSession 不再在 desktop 直接读 — 历史装配下沉到 server. */
import { configService } from '@neoxlabs/platform/platform/configService.js';
import { neoxLogger } from '@neoxlabs/kernel/platform/neoxLogger.js';
import { setTerminalExecutor, setDiagnosticsExecutor, setPdfExporter, setDailyLoginsConsentResolver } from '@neoxlabs/core/tools/runtimeTools.js';
import { renderHtmlToPdfFile } from './htmlToPdf.js';
import { resolveDailyLoginsChoice } from './externalChrome/dailyLoginsConsent.js';
import { setHostCapabilities } from '@neoxlabs/core';
import { RuntimeEventForwarder } from './runtimeEventForwarder.js';
import { shouldSuppressRunningAfterInterrupt } from './interruptSuppression.js';
import { requestTerminalExecution } from '../ipc/terminalRequestBridge.js';
import { requestEditorDiagnostics } from '../ipc/diagnosticsRequestBridge.js';
import { createElectronServices } from '../../../platform-electron/electronServices.js';
import { ActionLogService } from '@neoxlabs/core/platform/actionLog/index.js';
import { readPlanMaxParallelSessions } from '@neoxlabs/core/platform/membershipCacheRead.js';
import { normalizeRunMode, type AgentRunMode } from '@neoxlabs/core/runtime/modeFactory.js';
// SDK — runtime (优先 worker thread, 回退进程内 LocalRuntimeAdapter)
import { NeoxClient } from '@neoxlabs/core/sdk/client.js';
import { LocalNeoxClient } from '@neoxlabs/core/sdk/localNeoxClient.js';
import { LocalRuntimeAdapter } from '@neoxlabs/core/sdk/localRuntimeAdapter.js';
import { WorkerRuntimeAdapter } from '@neoxlabs/core/sdk/workerRuntimeAdapter.js';
import { Worker as NodeWorker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { getDeviceFingerprint } from './deviceFingerprint.js';
import { tokenDirPath } from '../ipc/authHandlers.js';
import { sameWorkspace } from '../../shared/workspacePath.node.js';
import { ensureWorkTaskDir, isInsideDir } from './workTaskDir.js';
import { flushTaskDirRenames } from './taskDirNaming.js';
import { isNeoxCloudProviderId } from '../../shared/neoxCloud.js';

type AgentBridgeEvents = {
  stream: (event: StreamEvent) => void;
};

type ApprovalNeededEvent = {
  type: 'approval_needed';
  requestId: string;
  toolName: string;
  args?: Record<string, any>;
  reason?: string;
  allowRemember?: boolean;
  scopeKey?: string;
  risk?: Extract<StreamEvent, { type: 'approval_needed' }>['risk'];
  provenance?: Extract<StreamEvent, { type: 'approval_needed' }>['provenance'];
};

type ApprovalCancelledEvent = {
  type: 'approval_cancelled';
  requestId: string;
  reason: 'resolved' | 'timeout' | 'manual_cancel' | 'session_aborted' | 'stale';
  approved?: boolean;
};

type AskUserNeededEvent = {
  type: 'ask_user_needed';
  requestId: string;
  questions: Array<{ question: string; options?: Array<{ label: string; description?: string }> }>;
};

type SessionExecutionState = 'idle' | 'running' | 'recovering';

/* 常量与判定都搬到 executionWatchdogPolicy —— 见那里的注释: 上界检查必须在续期分支之前,
 * 挪到后面就永远不触发, 且悄无声息。抽出来是为了能被单测锁住这个顺序。 */
type SessionExecutionTransitionReason =
  | 'send:start'
  | 'send:single-busy-reject'
  | 'send:queued-while-busy'
  | 'send:queue-miss-fallthrough'
  | 'send:recover-start'
  | 'send:accepted'
  | 'send:error'
  | 'event:session-status'
  | 'event:assistant-snapshot'
  | 'event:run-result'
  | 'event:error'
  | 'interrupt'
  | 'sse-reconnect-pre-resume'
  | 'sse-reconnect-no-payload'
  | 'authority:run-state-changed'
  | 'authority:reconcile'
  | 'authority:heartbeat-timeout'
  | 'reconcile:unavailable';

/** 超过这么久没收到任何权威信号 (变更或心跳) 就认为 push 通道可疑, 转 pull 对账。
 *  L0 心跳是 5s, 给 3 个周期的宽容度 — 偶发 GC / 事件积压不会误触发。 */
const RUN_STATE_AUTHORITY_TIMEOUT_MS = 16_000;
/** 对账最小间隔 — 防止活跃事件把对账打成高频轮询 (每个 token 都触发一次)。 */
const RUN_STATE_RECONCILE_MIN_INTERVAL_MS = 1500;

/** 代表"agent 真在干活"的事件类型 —— 中断后还收到这些, 说明 abort 没生效。
 *  故意不含 status / metrics / heartbeat 这类: 它们在收尾阶段也会零星出现,
 *  拿它们判"还在跑"会把成功的中断误判成失败。 */
const ACTIVITY_EVENT_TYPES = new Set([
  'token', 'thinking', 'reasoning', 'tool_call', 'tool_call_start',
]);
/** 中断后多久之内的活动不算数 —— 给 in-flight 事件排空的时间。
 *  abort 发出时管线里还飘着若干已生成的 token, 它们跟"abort 没生效"是两回事。 */
const INTERRUPT_ACTIVITY_GRACE_MS = 2_500;

/** 消息附件里的图 (data URL) → 排队插话要的形状; 没有就 undefined */
function injectImagesFromAttachments(
  attachments: unknown,
): Array<{ mediaType: string; data: string; name?: string }> | undefined {
  if (!Array.isArray(attachments)) return undefined;
  const out: Array<{ mediaType: string; data: string; name?: string }> = [];
  for (const a of attachments as Array<{ type?: string; data?: string; name?: string }>) {
    if (a?.type !== 'image' || typeof a.data !== 'string') continue;
    const m = /^data:([^;,]+);base64,(.*)$/s.exec(a.data);
    if (m) out.push({ mediaType: m[1], data: m[2], name: a.name });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * AgentBridge — 纯 UI 客户端，所有 runtime 操作通过 NeoxClient SDK 委托给 server
 */
export class AgentBridge extends EventEmitter {
  private static readonly liveBridges = new Set<AgentBridge>();
  private workspacePath: string | null = null;
  /** 最近一轮实际使用的 providerId — 只给错误文案分流用 (见 extractErrorMessage)。 */
  private lastProviderId: string | null = null;
  /** 每个会话最近一轮用的 providerId —— 数订阅会话用, BYOK 会话不计入套餐上限 */
  private sessionProviders = new Map<string, string>();
  private actionLog: ActionLogService;
  private userLanguage: 'zh' | 'en' = 'zh';
  private platformServices = createElectronServices();
  private eventForwarder: RuntimeEventForwarder;
  private currentSessionId: string | null = null;
  private lastMemorySnapshots: Map<string, { tokensUsed: number; contextWindow: number; breakdown?: any }> = new Map();
  private sessionExecutionStates: Map<string, SessionExecutionState> = new Map();

  private sandboxStatus: Map<string, boolean> = new Map();
  private approvalFallbackTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  // SDK — 进程内 runtime
  private client: NeoxClient | null = null;
  /** 取 runtime bridge 本体的闭包 — worker 模式下它是 RPC Proxy, 见 getRuntimeBridge。 */
  private bridgeGetter: (() => Record<string, any>) | null = null;
  private adapter: any | null = null;
  /** 在飞的压缩: sessionId → {跑在哪个 adapter 上, promise}。切工作区换 runtime 时据此决定旧 adapter 能不能立刻拆 */
  private inFlightCompactions = new Map<string, { adapter: any; done: Promise<void> }>();
  /** 已被新 runtime 顶替、但还有压缩没跑完的旧 adapter —— 压缩全部结束再 dispose */
  private retiringAdapters = new Set<any>();
  private clientReadyPromise: Promise<void> | null = null;
  private lastInitError: string | null = null;
  private currentConnectionWorkDir: string | null = null;
  private lastChatPayloads: Map<string, ChatRequestPayload> = new Map();

  private lastRunResultText: Map<string, string> = new Map();
  private runResultWaiters: Map<string, Array<(text: string) => void>> = new Map();

  /** run_result 到达时兑现等待者 */
  private resolveRunResult(sessionId: string, text: string): void {
    this.lastRunResultText.set(sessionId, text);
    const waiters = this.runResultWaiters.get(sessionId);
    if (!waiters?.length) return;
    this.runResultWaiters.delete(sessionId);
    for (const w of waiters) {
      try { w(text); } catch { /* 单个等待者抛错不影响其余 */ }
    }
  }

  /** 等这个会话的下一个 run_result (不管这一轮是谁起的 —— 界面 / 手机 / 主进程投的巡检)。
   *  要在起这一轮**之前**调, 否则快的那一轮会先结束。超时给空串。 */
  public awaitNextRunResult(sessionId: string, timeoutMs: number): Promise<string> {
    this.lastRunResultText.delete(sessionId);
    return this.waitForRunResult(sessionId, timeoutMs);
  }

  /** 等本轮 run_result; 超时返回已知的最后文本 (可能是空串) —— 绝不无限等 */
  private waitForRunResult(sessionId: string, timeoutMs: number): Promise<string> {
    return new Promise<string>(resolve => {
      let done = false;
      const finish = (text: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(text);
      };
      const timer = setTimeout(() => {
        const list = this.runResultWaiters.get(sessionId);
        if (list) {
          const i = list.indexOf(finish);
          if (i >= 0) list.splice(i, 1);
        }
        finish(this.lastRunResultText.get(sessionId) ?? '');
      }, timeoutMs);
      const list = this.runResultWaiters.get(sessionId) ?? [];
      list.push(finish);
      this.runResultWaiters.set(sessionId, list);
    });
  }
  /** 本轮首次武装看门狗的时刻 (续期不刷新) —— 算单轮总时长用, 见 EXECUTION_HARD_CEILING_MS */
  private executionWatchdogArmedAt: Map<string, number> = new Map();
  /** 已就某种阻塞原因提醒过的 session:reason —— L0 每 5s 重播电平, 不去重会刷屏 */
  private blockedNotified: Set<string> = new Set();
  /** 已就"单轮跑太久"告知过用户的会话 —— 一轮只提醒一次, 不刷屏 */
  private longRunNotified: Set<string> = new Set();
  private executionWatchdogs: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private sessionLastActivityAt: Map<string, number> = new Map();
  /* 最后一次收到 L0 权威信号 (run_state_changed, 含心跳) 的时刻 — 判 push 通道死活。 */
  private lastAuthoritySignalAt = 0;
  /* 对账节流 + in-flight 去重: 高频活跃事件不该打出高频 RPC, 也不该并发发起多次对账。 */
  private lastReconcileAt = 0;
  private reconcileInFlight: Promise<void> | null = null;
  private reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  private authorityMonitorTimer: ReturnType<typeof setInterval> | null = null;
  /** sessionId → 用户点停止的时刻。见 interruptSuppression.ts。 */
  private interruptRequestedAt: Map<string, number> = new Map();
  private pendingInterrupts = new Map<string, Promise<{ ok: true; sessionId: string }>>();
  private limitBlockedSends /* 被订阅会话上限拦下、没进 runtime 的消息 */ = new Map<string, Pick<ChatRequestPayload, 'prompt' | 'metadata'>>();
  private sendGenerations = new Map<string, number>();
  /** 中断之后又收到过内容产出的会话 —— 说明 abort 没生效, agent 还在真跑。 */
  private sawActivityAfterInterrupt: Set<string> = new Set();

  constructor() {
    super();
    AgentBridge.liveBridges.add(this);
    this.actionLog = new ActionLogService({ source: 'ui', agentName: 'Neox UI' });
    this.userLanguage = configService.getLanguagePreference();
    this.eventForwarder = new RuntimeEventForwarder({
      emitStream: (event) => this.emitStream(event),
      tokenUsage: this.platformServices.tokenUsage,
    });

    setTerminalExecutor(requestTerminalExecution);
    setDiagnosticsExecutor(requestEditorDiagnostics);
    /* PDF 跟上面两个不同: 它不是"到渲染进程的中转", 主进程自己开隐藏窗口就能打印。
     * 但 runtime 默认跑在 worker, 那边 require('electron') 拿不到 BrowserWindow,
     * 所以照样要两处都注册。 */
    setPdfExporter(renderHtmlToPdfFile);
    setHostCapabilities({
      diagnostics: (options) => requestEditorDiagnostics(options as { paths?: string[]; limit?: number }),
      terminal: (options) => requestTerminalExecution(options as Parameters<typeof requestTerminalExecution>[0]),
      htmlToPdf: (options) => renderHtmlToPdfFile(options as Parameters<typeof renderHtmlToPdfFile>[0]),
      /* agent 的 Chrome 归 runtime 持有 (core hostedChrome), 但「带不带日常登录」要弹窗问用户,
       * 对话框只有主进程能弹 —— 同样两处都注册 (进程内直跑 / worker 反向调) */
      dailyLoginsChoice: () => resolveDailyLoginsChoice(),
    });
    setDailyLoginsConsentResolver(() => resolveDailyLoginsChoice());
    // [silenced] console.log('[AgentBridge] Terminal executor registered');
  }

  /**
   * 等待 SDK client 就绪（进程内 runtime，无 HTTP 连接竞态）
   */
  public async getClientAsync(): Promise<NeoxClient | null> {
    while (this.clientReadyPromise) {
      await this.clientReadyPromise;
    }
    if (this.client && this.currentConnectionWorkDir === this.workspacePath) {
      return this.client;
    }
    if (!this.workspacePath) {
      return null;
    }
    await this.connectRuntime(this.workspacePath);
    while (this.clientReadyPromise) {
      await this.clientReadyPromise;
    }
    return this.client;
  }

  public async ensureAlive(_reason: string): Promise<void> {
    if (!this.workspacePath) return;
    if (!this.client) {
      await this.connectRuntime(this.workspacePath);
    }
  }

  /* ─── 历史恢复已下沉到 server (neox-core/src/runtime/agentRuntimeHost.ts):
   *      hostFactory 在 host 构造前 sessionSync.loadHistory() 一次性把 SQLite 历史
   *      灌进 ShortTermMemory; runTask 入口还有 self-heal 兜底。
   *      desktop 端不再做"恢复"动作, 只负责传新 prompt + 显示. ─── */

  private getSessionExecutionState(sessionId: string): SessionExecutionState {
    return this.sessionExecutionStates.get(sessionId) ?? 'idle';
  }

  private transitionSessionExecutionState(
    sessionId: string,
    next: SessionExecutionState,
    reason: SessionExecutionTransitionReason,
    options?: { allowNoop?: boolean },
  ): void {
    const prev = this.getSessionExecutionState(sessionId);

    const askedAt = this.interruptRequestedAt.get(sessionId);
    if (shouldSuppressRunningAfterInterrupt({
      next, reason, interruptedAt: askedAt,
      sawActivityAfterInterrupt: this.sawActivityAfterInterrupt.has(sessionId),
      now: Date.now(),
    })) return;
    if (askedAt !== undefined && (next === 'running' || next === 'recovering')
      && reason !== 'send:start' && reason !== 'send:accepted') {
      /* 没被抑制住却又是 running = 超窗了, abort 没生效。停止抑制并留痕:
       * agent 其实还在跑, 瞒着用户比卡住更糟。 */
      console.warn(`[AgentBridge] ${sessionId.slice(0, 16)} 中断后 ${Math.round((Date.now() - askedAt) / 1000)}s 仍是 running — abort 可能没生效, 恢复如实显示`);
      this.interruptRequestedAt.delete(sessionId);
    }
    if (next === 'idle' && reason !== 'interrupt') this.interruptRequestedAt.delete(sessionId);

    const isAuthoritative = reason === 'authority:run-state-changed' || reason === 'authority:reconcile';
    if (prev === next) {
      if (!isAuthoritative) {
        if (!options?.allowNoop) {
          console.warn(`[AgentBridge] session-state noop: ${sessionId} ${prev} -> ${next} (${reason})`);
        }
        return;
      }
      /* 权威 noop — 不重复 arm 看门狗 (那会不断把 180s 计时重置), 只重播电平。 */
      this.emitStream({
        type: 'session_execution_state',
        sessionId,
        state: next,
        reason,
        authoritative: true,
        timestamp: Date.now(),
      } as any);
      return;
    }

    this.sessionExecutionStates.set(sessionId, next);
    this.emitStream({
      type: 'session_execution_state',
      sessionId,
      state: next,
      reason,
      timestamp: Date.now(),
    } as any);
    if (next === 'running' || next === 'recovering') {
      this.armExecutionWatchdog(sessionId);
    } else if (next === 'idle') {
      this.clearExecutionWatchdog(sessionId);
      /* 单轮计时随收敛复位 —— 不复位的话下一轮会带着上一轮的起点算总时长,
       * 一开跑就误报"已运行 N 分钟"。 */
      this.resetExecutionRunClock(sessionId);
      this.clearBlockedNotified(sessionId);
    }
    this.syncAuthorityMonitor();
  }

  private syncAuthorityMonitor(): void {
    const hasRunning = [...this.sessionExecutionStates.values()].some((s) => s !== 'idle');
    if (hasRunning && !this.authorityMonitorTimer) {
      /* 起监控时把基准时间设成此刻, 否则刚开跑就被判超时 (lastAuthoritySignalAt 可能还是 0)。 */
      if (this.lastAuthoritySignalAt === 0) this.lastAuthoritySignalAt = Date.now();
      this.authorityMonitorTimer = setInterval(() => {
        const stillRunning = [...this.sessionExecutionStates.values()].some((s) => s !== 'idle');
        if (!stillRunning) {
          this.syncAuthorityMonitor();
          return;
        }
        const silentFor = Date.now() - this.lastAuthoritySignalAt;
        if (silentFor >= RUN_STATE_AUTHORITY_TIMEOUT_MS) {
          console.warn(`[AgentBridge] 权威通道静默 ${Math.round(silentFor / 1000)}s — 转 pull 对账`);
          void this.reconcileRunStates('authority-heartbeat-timeout');
        }
      }, RUN_STATE_AUTHORITY_TIMEOUT_MS / 2);
      (this.authorityMonitorTimer as any).unref?.();
    } else if (!hasRunning && this.authorityMonitorTimer) {
      clearInterval(this.authorityMonitorTimer);
      this.authorityMonitorTimer = null;
    }
  }

  /** 把所有非 idle 的会话收敛成终态 — runtime 断开/重连时调, 见 connectRuntime 里的说明。
   *  判据与 180s 看门狗一致 (error + run_result failed), 复用同一条已验证的 UI 收敛路径。 */
  private settleInFlightSessions(reason: string): void {
    const inFlight = [...this.sessionExecutionStates.entries()]
      .filter(([, state]) => state !== 'idle')
      .map(([sid]) => sid);
    if (inFlight.length === 0) return;
    console.warn(`[AgentBridge] settling ${inFlight.length} in-flight session(s) — ${reason}`);
    for (const sessionId of inFlight) {
      this.clearExecutionWatchdog(sessionId);
      this.emitStream({
        type: 'error',
        sessionId,
        error: '运行已中断 (后台服务重启或重连). 这一轮没有跑完, 点「重试」可以重发。',
        timestamp: Date.now(),
      } as any);
      this.emitStream({
        type: 'run_result',
        sessionId,
        output: '',
        iterations: 0,
        toolCalls: 0,
        durationMs: 0,
        totalTokens: 0,
        failed: true,
        interrupted: true,
        timestamp: Date.now(),
      } as any);
      this.transitionSessionExecutionState(sessionId, 'idle', 'event:run-result', { allowNoop: true });
    }
  }

  private clearExecutionWatchdog(sessionId: string): void {
    const timer = this.executionWatchdogs.get(sessionId);
    if (timer) clearTimeout(timer);
    this.executionWatchdogs.delete(sessionId);
  }

  /** 会话转 idle 时把单轮计时与"已告知长跑"标记一并复位 —— 否则下一轮会带着
   *  上一轮的起点算总时长, 一开跑就误报"已运行 N 分钟"。 */
  /** 会话重新开始执行 / 收敛时, 清掉该会话的阻塞提醒去重标记, 下次阻塞还能再提醒。 */
  private clearBlockedNotified(sessionId: string): void {
    for (const key of Array.from(this.blockedNotified)) {
      if (key.startsWith(sessionId + ':')) this.blockedNotified.delete(key);
    }
  }

  private resetExecutionRunClock(sessionId: string): void {
    this.executionWatchdogArmedAt.delete(sessionId);
    this.longRunNotified.delete(sessionId);
  }

  private armExecutionWatchdog(sessionId: string): void {
    this.clearExecutionWatchdog(sessionId);
    const startedAt = Date.now();
    this.sessionLastActivityAt.set(sessionId, startedAt);
    /* 本轮**第一次**武装看门狗的时刻 —— 续期不刷新它, 用来算单轮总时长。 */
    if (!this.executionWatchdogArmedAt.has(sessionId)) {
      this.executionWatchdogArmedAt.set(sessionId, startedAt);
    }
    const timer = setTimeout(async () => {
      const state = this.getSessionExecutionState(sessionId);
      if (state === 'idle') return;
      const lastActivity = this.sessionLastActivityAt.get(sessionId) || startedAt;
      const idleForMs = Date.now() - lastActivity;
      const armedAt = this.executionWatchdogArmedAt.get(sessionId) ?? startedAt;
      const totalMs = Date.now() - armedAt;

      const decision = evaluateExecutionWatchdog({
        idleForMs,
        totalMs,
        alreadyNotifiedLongRun: this.longRunNotified.has(sessionId),
      });
      if (decision.warnLongRun) {
        this.longRunNotified.add(sessionId);
        const mins = decision.longRunMinutes;
        console.warn(`[AgentBridge] ${sessionId.slice(0, 16)} 单轮已运行 ${mins} 分钟 — 超过软上界, 告知用户`);
        this.emitStream({
          type: 'status',
          sessionId,
          level: 'warning',
          message: `本轮已运行 ${mins} 分钟且仍在继续 — 若不符合预期可点停止后重发`,
          longRunMinutes: mins,
          timestamp: Date.now(),
        } as any);
      }

      // 只有 session 自己也长时间没有任何 SSE 事件时才兜底收敛；如果还有 token/tool/status，说明真在跑。
      if (decision.renewOnly) {
        this.armExecutionWatchdog(sessionId);
        return;
      }
      await this.reconcileRunStates('watchdog-pre-settle');
      if (this.getSessionExecutionState(sessionId) !== 'idle'
        && (await this.isRunningPerAuthority(sessionId))) {
        console.warn(`[AgentBridge] execution watchdog: ${sessionId.slice(0, 16)} 静默 ${Math.round(idleForMs / 1000)}s 但权威说仍在跑 — 继续观察`);
        this.armExecutionWatchdog(sessionId);
        return;
      }
      /* 对账已经把状态收敛掉了就别再补刀发错误卡 (用户那一轮可能是正常结束的)。 */
      if (this.getSessionExecutionState(sessionId) === 'idle') return;
      console.warn(`[AgentBridge] execution watchdog settling stale session ${sessionId} after ${Math.round(idleForMs / 1000)}s idle`);
      this.emitStream({
        type: 'error',
        sessionId,
        error: '运行超时 (180s 未收到事件). 可能是 BYOK provider 挂死 / 网络中断 / 代理阻断. 建议检查 服务商设置 或换个模型.',
        timestamp: Date.now(),
      } as any);
      this.emitStream({
        type: 'run_result',
        sessionId,
        output: '',
        iterations: 0,
        toolCalls: 0,
        durationMs: Date.now() - startedAt,
        totalTokens: 0,
        failed: true,
        interrupted: true,
        timestamp: Date.now(),
      } as any);
      this.transitionSessionExecutionState(sessionId, 'idle', 'event:run-result', { allowNoop: true });
    }, 180_000);
    (timer as any).unref?.();
    this.executionWatchdogs.set(sessionId, timer);
  }

  private updateSessionExecutionStateFromEvent(sessionId: string, eventData: any): void {
    const data = eventData;
    const eventType = data?.type;

    /* 子会话镜像: sessionId=子 agent, 这条线程不在 L0 sessionRunStates。
     * 拿它去对账只会 live-traffic-while-idle spam, 还可能把 composer 打回待机。
     * 事件本身照常 forward, 只是不参与主会话运行态机。 */
    if (data?.__subAgentMirror === true) return;

    /* ── L0 权威电平 — 唯一能直接决定运行态的输入 ────────────────────────────
     * server setRunStatus 每次变更都播, 并对非 idle 会话每 5s 重播同一电平 (心跳)。
     * 心跳的价值: 就算之前因为任何原因错过了那一次 running 边沿 (进程重启 / SSE 丢帧),
     * 最多一个心跳周期就自动追平 —— 这是"永久失配"这类 bug 的根治点。 */
    if (eventType === 'run_state_changed') {
      this.lastAuthoritySignalAt = Date.now();
      const status = typeof data.status === 'string' ? data.status : '';
      if (!status) return;
      const executing = typeof data.executing === 'boolean'
        ? data.executing
        : status === 'running';
      const running = executing;
      if (!running) {
        this.lastChatPayloads.delete(sessionId);
      }
      /* 不在执行但也不空闲 → 把卡住的原因如实告诉用户 (与 reconcile 路径一致) */
      const blockedBy = typeof data.blockedBy === 'string'
        ? data.blockedBy
        : (status === 'paused' ? 'pause'
          : status === 'awaiting_approval' ? 'approval'
            : status === 'awaiting_user' ? 'ask_user' : '');
      if (!executing && blockedBy && !this.blockedNotified.has(sessionId + ':' + blockedBy)) {
        this.blockedNotified.add(sessionId + ':' + blockedBy);
        this.emitSessionBlocked(sessionId, blockedBy);
      }
      if (executing) this.clearBlockedNotified(sessionId);
      this.transitionSessionExecutionState(
        sessionId,
        running ? 'running' : 'idle',
        'authority:run-state-changed',
        { allowNoop: true },
      );
      return;
    }

    /* 中断之后还在产出内容 = abort 没生效, agent 是真在跑 —— 解除抑制, 让 UI 如实显示。
     * (只认真正代表"干活"的事件: token/文本/工具/思考。status 之类的心跳类事件不算,
     *  否则 abort 成功但还有零星状态事件时会被误判成"还在跑"。) */
    const interruptedAtForActivity = this.interruptRequestedAt.get(sessionId);
    if (interruptedAtForActivity !== undefined
      && Date.now() - interruptedAtForActivity > INTERRUPT_ACTIVITY_GRACE_MS
      && ACTIVITY_EVENT_TYPES.has(String(eventType))
      && !this.sawActivityAfterInterrupt.has(sessionId)) {
      this.sawActivityAfterInterrupt.add(sessionId);
      console.warn(`[AgentBridge] ${sessionId.slice(0, 16)} 中断后仍在产出 (${eventType}) — abort 未生效, 恢复如实显示运行态`);
    }

    /* ── 以下全部是"疑似"信号 — 只触发对账, 绝不直接改状态 ──────────────────
     * 历史教训: 这里每多一条"看到 X 就判 idle"的规则, 就多一种把还在跑的会话
     * 打成待机态的方式, 而且因为权威只播边沿, 打错了就是永久的。现在统一改成
     * "去问 L0", 问到什么算什么。 */

    /* taskAgentId 防御保留: 子 agent 的终止事件连"疑似"都算不上, 主 agent 通常还在跑,
     * 对账也是白跑一趟, 直接忽略。 */
    if ((eventType === 'run_result' || eventType === 'error') && data?.taskAgentId) {
      return;
    }

    if (eventType === 'run_result') {
      this.lastChatPayloads.delete(sessionId);
      /* 本轮最终文本 —— currentTurnText 优先 (只含这一轮), output 兜底 */
      const turnText = typeof data.currentTurnText === 'string' && data.currentTurnText.length > 0
        ? data.currentTurnText
        : (typeof data.output === 'string' ? data.output : '');
      this.resolveRunResult(sessionId, turnText);
    }

    if (eventType === 'run_result' || eventType === 'error' || eventType === 'session_status') {
      /* 疑似结束 → 立刻对账。正常情况下 L0 的 run_state_changed(idle) 会先到或紧随其后,
       * 对账只是确认一遍; 真正救命的是"L0 说还在跑"的情况 —— 比如队列里还有插话、
       * 或者这条 error 只是本轮里一次非致命失败, 旧实现会在这里误判 idle。 */
      this.scheduleRunStateReconcile(`event:${eventType}`);
      return;
    }

    /* 活跃事件 (token / tool_call / status …) 与本地态矛盾 → 对账。
     * 本地说 idle 却还在源源不断收到该 session 的事件, 说明镜像已经失配。
     * 注意这里不是"看到事件就判 running" —— 那是又一次本地推断; 是去问权威。 */
    if (this.getSessionExecutionState(sessionId) === 'idle') {
      this.scheduleRunStateReconcile('live-traffic-while-idle');
    }
  }

  /* ─── 对账器 (pull 兜底) ───────────────────────────────────────────────────
   *  节流 + 合并 in-flight: 高频活跃事件只会合并成一次 RPC。进程内 (LocalNeoxClient)
   *  这就是一次 Map 直读, 远程 daemon 才是一次 HTTP GET。 */
  private scheduleRunStateReconcile(reason: string): void {
    const sinceLast = Date.now() - this.lastReconcileAt;
    if (sinceLast >= RUN_STATE_RECONCILE_MIN_INTERVAL_MS) {
      void this.reconcileRunStates(reason);
      return;
    }
    /* 冷却期内 — 排一次尾随对账, 保证"最后一次矛盾"也一定被处理到, 而不是被节流吃掉。 */
    if (this.reconcileTimer) return;
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null;
      void this.reconcileRunStates(`${reason}:trailing`);
    }, RUN_STATE_RECONCILE_MIN_INTERVAL_MS - sinceLast);
    (this.reconcileTimer as any).unref?.();
  }

  /** 拉 L0 全量非 idle 快照, 与本地镜像逐条比对, 有差异一律以 L0 为准并广播给 renderer。
   *  失败时**保持现状**: 拿不到权威就不动, 绝不"拿不到就当空闲" —— 那正是历史 bug 的形状。 */
  async reconcileRunStates(reason: string): Promise<void> {
    if (this.reconcileInFlight) return this.reconcileInFlight;
    this.reconcileInFlight = (async () => {
      this.lastReconcileAt = Date.now();
      const client = this.client;
      if (!client || typeof (client as any).getRunStates !== 'function') return;
      let snapshots: Array<{ sessionId: string; running: boolean }> = [];
      try {
        /* 本地认为在跑的会话必须点名查 —— 它们不在 L0 的非 idle 表里时, 恰恰说明
         * 本地多显示了一个运行态, 这是要收敛的方向。 */
        const locallyRunning = [...this.sessionExecutionStates.entries()]
          .filter(([, s]) => s !== 'idle')
          .map(([sid]) => sid);
        snapshots = await (client as any).getRunStates(locallyRunning);
      } catch (err: any) {
        console.warn(`[AgentBridge] run-state reconcile failed (${reason}): ${err?.message ?? err} — 保持现状不动`);
        return;
      }
      this.lastAuthoritySignalAt = Date.now();

      /* 同 isRunningPerAuthority: 对账也必须看 executing。
       * 用 running 的话, paused / awaiting_* 会被当成"在跑"而永不收敛。 */
      const authoritative = new Map<string, boolean>();
      const blockedReasons = new Map<string, string>();
      for (const snap of snapshots ?? []) {
        if (!snap?.sessionId) continue;
        const s = snap as { sessionId: string; running?: boolean; executing?: boolean; blockedBy?: string };
        authoritative.set(s.sessionId, typeof s.executing === 'boolean' ? s.executing : s.running === true);
        if (s.blockedBy) blockedReasons.set(s.sessionId, s.blockedBy);
      }
      /* 方向一: L0 说在跑, 本地说没跑 → 抬回 running (救"界面卡在待机态但 runtime 在跑")。 */
      for (const [sessionId, running] of authoritative) {
        if (!running) continue;
        if (this.getSessionExecutionState(sessionId) === 'idle') {
          console.warn(`[AgentBridge] reconcile(${reason}): ${sessionId.slice(0, 16)} idle → running (authority)`);
          this.transitionSessionExecutionState(sessionId, 'running', 'authority:reconcile', { allowNoop: true });
        }
      }
      /* 方向二: 本地说在跑, L0 没列进非 idle 且点名查也说不在跑 → 收敛 idle
       * (救"停止按钮消失不了 / 一直转圈")。 */
      for (const [sessionId, state] of this.sessionExecutionStates) {
        if (state === 'idle') continue;
        if (authoritative.get(sessionId) === true) continue;
        const blocked = blockedReasons.get(sessionId);
        console.warn(`[AgentBridge] reconcile(${reason}): ${sessionId.slice(0, 16)} ${state} → idle (authority${blocked ? `, blockedBy=${blocked}` : ''})`);
        this.transitionSessionExecutionState(sessionId, 'idle', 'authority:reconcile', { allowNoop: true });
        /* 卡住的原因必须传下去 —— 不能只是悄悄收敛成 idle。
         * 会话可能是"暂停中/等审批/等你回答", 这三种都不是"结束了"。
         * 只收敛不说明, 用户视角就是"它自己不动了也不告诉我为什么", Agent 也无从换方案。 */
        if (blocked) this.emitSessionBlocked(sessionId, blocked);
      }
    })().finally(() => {
      this.reconcileInFlight = null;
    });
    return this.reconcileInFlight;
  }

  /** 会话"不空闲但也没在执行"时, 把卡住的原因如实播给 renderer。
   *
   *  为什么必须有这条: 收敛成 idle 解决了"停不下来", 但如果只收敛不说明,
   *  用户看到的是"它自己不动了, 也不告诉我为什么"。三种阻塞态各自需要不同的动作
   *  (继续 / 去审批 / 回答问题), 不告诉就等于让人猜。 */
  private emitSessionBlocked(sessionId: string, blockedBy: string): void {
    const label = blockedBy === 'pause' ? '已暂停 — 发送消息或点继续即可恢复'
      : blockedBy === 'approval' ? '等待权限审批 — 请在审批卡上确认'
        : blockedBy === 'ask_user' ? '等待你回答 — 请在提问卡上作答'
          : `已阻塞 (${blockedBy})`;
    this.emitStream({
      type: 'status',
      sessionId,
      level: 'warning',
      message: label,
      blockedBy,
      timestamp: Date.now(),
    } as any);
  }

  /** 单条精确取证 — watchdog 收敛前用。拿不到权威时返回 true (保守: 宁可继续观察,
   *  也不要在没有证据的情况下把可能还在跑的会话打成待机态)。 */
  private async isRunningPerAuthority(sessionId: string): Promise<boolean> {
    const client: any = this.client;
    if (!client || typeof client.getRunState !== 'function') return false;
    try {
      const snap = await client.getRunState(sessionId);
      if (typeof snap?.executing === 'boolean') return snap.executing;
      return snap?.running === true;
    } catch (err: any) {
      console.warn(`[AgentBridge] getRunState(${sessionId.slice(0, 16)}) failed: ${err?.message ?? err} — 保守视为仍在跑`);
      return true;
    }
  }

  async getExecutionStates(probeSessionIds?: string[]): Promise<Array<{ sessionId: string; running: boolean }>> {
    await this.reconcileRunStates('renderer-pull');
    const out = new Map<string, boolean>();
    for (const [sessionId, state] of this.sessionExecutionStates.entries()) {
      out.set(sessionId, state !== 'idle');
    }
    const missing = (probeSessionIds ?? []).filter((sid) => sid && !out.has(sid));
    if (missing.length) {
      const client = this.client;
      if (client && typeof (client as any).getRunStates === 'function') {
        try {
          const snaps: Array<{ sessionId: string; running?: boolean; executing?: boolean; known?: boolean }> =
            await (client as any).getRunStates(missing);
          for (const s of snaps ?? []) {
            if (!s?.sessionId || out.has(s.sessionId)) continue;
            /* known=false 意思是"这台 server 压根不认识它" —— 例如 cloud transport 会话
             * 根本不走本地 runtime。那种 idle 是"我不知道", 不是"它没在跑", 不能作答,
             * 否则会把云端正在跑的会话在本地强行收敛掉。 */
            if (s.known === false) continue;
            out.set(s.sessionId, typeof s.executing === 'boolean' ? s.executing : s.running === true);
          }
        } catch (err: any) {
          /* 拿不到权威就**不回答** —— 让 renderer 保持现状, 绝不"查不到就当空闲"。 */
          console.warn(`[AgentBridge] probe run-state failed: ${err?.message ?? err} — 这些会话不作答`);
        }
      }
    }
    return [...out.entries()].map(([sessionId, running]) => ({ sessionId, running }));
  }

  private markSequenceResetHintsForActiveSessions(reason: string): void {
    const candidates = new Set<string>();
    for (const [sessionId, state] of this.sessionExecutionStates.entries()) {
      if (state !== 'idle') {
        candidates.add(sessionId);
      }
    }
    if (this.currentSessionId) {
      candidates.add(this.currentSessionId);
    }
    if (candidates.size === 0) {
      return;
    }
    for (const sessionId of candidates) {
      this.eventForwarder.markSessionSequenceResetHint(sessionId);
    }
    console.warn(`[AgentBridge] Marked sequence reset hints for ${candidates.size} session(s): ${reason}`);
  }

  /**
   * 连接 server 并订阅 SSE 事件流
   */
  private async connectRuntime(workDir: string): Promise<void> {
    while (this.clientReadyPromise) {
      await this.clientReadyPromise;
    }
    if (this.currentConnectionWorkDir === workDir && this.client) {
      return;
    }

    let resolveReady!: () => void;
    this.clientReadyPromise = new Promise((resolve) => { resolveReady = resolve; });

    try {
      // 释放旧 adapter
      if (this.adapter) {
        this.settleInFlightSessions('runtime-reconnect');
        this.retireAdapter(this.adapter);
        this.adapter = null;
      }
      this.client = null;

      type RuntimeAdapterLike = { onEvent: Function; connect: Function; dispose: Function; getBridge?: Function; [k: string]: any };
      type BuiltRuntime = { adapter: RuntimeAdapterLike; getBridge: () => any };

      const preferWorker = process.env.NEOX_DESKTOP_INPROCESS_RUNTIME !== '1';
      const sessionTrackers = new Map<string, import('./runtimeEventForwarder.js').RuntimeEventTracker>();

      const makeLocal = (): BuiltRuntime => {
        console.log('[AgentBridge] Initializing in-process runtime (LocalRuntimeAdapter)');
        const la = new LocalRuntimeAdapter(workDir, tokenDirPath());
        return { adapter: la, getBridge: () => la.getBridge() };
      };

      const built: BuiltRuntime = await (async (): Promise<BuiltRuntime> => {
        if (!preferWorker) return makeLocal();
        try {
          /* device fp 必须由宿主算好传进去 —— worker 是独立 globalThis, 主进程
           * setNeoxDeviceFp 对它无效, 而服务端 devicebind 要求非空 X-Device-FP
           * (CLI 那边排查了 7 层才定位到这条, 别再踩)。 */
          let deviceFp = '';
          try { deviceFp = (await getDeviceFingerprint())?.fpHash ?? ''; } catch { /* 非致命 */ }
          const wa = new WorkerRuntimeAdapter(
            workDir,
            tokenDirPath(),
            deviceFp,
            /* worker 构造器由宿主内联 —— 打包器只认**本包**里的 new Worker(new URL(...)),
             * 跟 indexingCpuPool 同款 (那条路径在打包版里已验证过)。 */
            (workerData) => new NodeWorker(
              new URL('../workers/runtimeWorkerEntry.js', import.meta.url),
              { workerData },
            ),
            /* 隔离档由 NEOX_RUNTIME_ISOLATION 决定 (默认 worker) */
            undefined,
            /* 进程隔离时 fork 的入口 —— 必须是**本包打出来的**那份, 跟上面 worker 用的是同一个文件。
             * 不传的话适配器会去 fork neox-core dist 里的入口, 打包版里那个路径不存在。 */
            fileURLToPath(new URL('../workers/runtimeWorkerEntry.js', import.meta.url)),
          );
          console.log('[AgentBridge] Initializing runtime on worker thread (WorkerRuntimeAdapter)');
          return { adapter: wa, getBridge: () => wa.getBridge() };
        } catch (workerErr: any) {
          console.warn('[AgentBridge] worker runtime 构造失败, 回落进程内:', workerErr?.message ?? workerErr);
          return makeLocal();
        }
      })();

      let adapter: RuntimeAdapterLike = built.adapter;
      let adapterBridgeGetter: () => any = built.getBridge;

      /* 具名而不是内联 —— worker 起不来要回落到 in-process adapter, 那时得把同一个
       * 监听器再挂一遍。内联的话回落后事件没人接, 界面永远转圈 (静默失败)。 */
      const onRuntimeEvent = (eventData: any, rawTracker: any) => {
        const sessionId = eventData?.sessionId;
        if (!sessionId) {
          console.error('[AgentBridge] 丢弃无 sessionId 的事件 — 上游必须带会话归属, 不再回落 currentSessionId', {
            type: eventData?.type,
            keys: eventData && typeof eventData === 'object' ? Object.keys(eventData).slice(0, 12) : null,
          });
          return;
        }

        let tracker = sessionTrackers.get(sessionId);
        if (!tracker) {
          tracker = { contextUsed: 0, startTime: Date.now(), provider: '', model: '' };
          sessionTrackers.set(sessionId, tracker);
        }
        if (rawTracker) {
          if (rawTracker.contextUsed > 0) tracker.contextUsed = rawTracker.contextUsed;
          if (rawTracker.provider) tracker.provider = rawTracker.provider;
          if (rawTracker.model) tracker.model = rawTracker.model;
        }

        this.sessionLastActivityAt.set(sessionId, Date.now());
        this.updateSessionExecutionStateFromEvent(sessionId, eventData);

        if (eventData?.type === 'approval_needed') {
          const { requestId } = eventData;
          this.eventForwarder.forward(sessionId, eventData, tracker);
          const existingTimer = this.approvalFallbackTimers.get(requestId);
          if (existingTimer) { clearTimeout(existingTimer); this.approvalFallbackTimers.delete(requestId); }
          return;
        }

        if (eventData?.type === 'approval_cancelled') {
          const { requestId } = eventData;
          const fallbackTimer = this.approvalFallbackTimers.get(requestId);
          if (fallbackTimer) { clearTimeout(fallbackTimer); this.approvalFallbackTimers.delete(requestId); }
          this.eventForwarder.forward(sessionId, eventData, tracker);
          return;
        }

        if (eventData?.type === 'ask_user_needed') {
          this.eventForwarder.forward(sessionId, eventData, tracker);
          return;
        }

        if (eventData?.type === 'worker_complete' || eventData?.type === 'worker_start') {
          console.log(`[AgentBridge] 🔍 DIAG: type=${eventData.type} agentId=${eventData.agentId} sessionId=${eventData.sessionId || sessionId} success=${eventData.success}`);
        }

        this.eventForwarder.forward(sessionId, eventData, tracker);
      };
      adapter.onEvent(onRuntimeEvent);

      try {
        await adapter.connect();
      } catch (connectErr: any) {
        /* worker 可能到 spawn / ready 才失败 (entry 找不到、原生模块加载不了…)。
         * 回落 in-process —— 用户宁可少一层隔离, 也不能面对一个连不上 runtime 的 app。
         * 这正是当年 daemon 方案最致命的那一类失败, 区别在于这里**有得可退**。 */
        if (adapter instanceof WorkerRuntimeAdapter) {
          console.warn('[AgentBridge] worker runtime 起不来, 回落进程内:', connectErr?.message ?? connectErr);
          try { adapter.dispose(); } catch { /* ignore */ }
          const local = makeLocal();
          adapter = local.adapter;
          adapterBridgeGetter = local.getBridge;
          adapter.onEvent(onRuntimeEvent);
          await adapter.connect();
        } else {
          throw connectErr;
        }
      }
      this.adapter = adapter;
      this.client = new LocalNeoxClient(adapterBridgeGetter);
      this.bridgeGetter = adapterBridgeGetter;
      this.currentConnectionWorkDir = workDir;
      console.log('[AgentBridge] Runtime ready for', workDir, '(adapter:', adapter.constructor.name + ')');
      void this.reconcileRunStates('runtime-connected');
    } catch (error: any) {
      const rawMsg = error?.message || String(error);
      console.error('[AgentBridge] Runtime initialization failed:', error?.stack || rawMsg);
      this.lastInitError = this.humanizeInitError(rawMsg);
      this.client = null;
      this.adapter = null;
      this.currentConnectionWorkDir = null;
    } finally {
      this.clientReadyPromise = null;
      resolveReady();
    }
  }

  private humanizeInitError(raw: string): string {
    if (/网关密钥未签发|CredentialProvider.*无.*key|NEOX_ROUTING_MISSING_GATEWAY_KEY/i.test(raw)) {
      return '你还没有登录，请点击左下角头像完成登录后即可开始使用 ✨';
    }
    if (/gatewayBase|NEOX_ROUTING_MISSING_GATEWAY_BASE|routing.*损坏/i.test(raw)) {
      return '登录状态异常，请点击左下角头像重新登录即可恢复。';
    }
    if (/better-sqlite3|SQLITE|database.*locked|database.*corrupt/i.test(raw)) {
      return '本地数据出现异常，正在自动修复…请重启应用即可恢复正常。';
    }
    if (/node-pty|native.*module|\.node.*not found|MODULE_NOT_FOUND/i.test(raw)) {
      return '应用组件加载异常，请前往官网重新下载安装最新版本。';
    }
    if (/EACCES|EPERM|permission denied/i.test(raw)) {
      return '应用没有足够的文件读写权限，请尝试重新安装应用到默认位置。';
    }
    if (/ENOSPC|disk.*full|no space/i.test(raw)) {
      return '你的磁盘空间已满，请清理一些文件后重试。';
    }
    if (/ENOENT.*config|config.*not found/i.test(raw)) {
      return '首次使用需要初始化，请重启应用即可自动完成。';
    }
    if (/timeout|ETIMEDOUT|ECONNREFUSED/i.test(raw)) {
      return '网络连接异常，请检查你的网络后重试。';
    }
    return '遇到了一点问题，请重启应用重试。如果问题持续，请联系客服获取帮助。';
  }

  public setWorkspace(workspaceDir: string) {
    const resolvedPath = path.resolve(workspaceDir);
    this.workspacePath = resolvedPath;
    process.env.NEOX_WORKDIR = resolvedPath;
    void this.actionLog.setWorkspace(resolvedPath);

    // 立即启动 runtime — 不再懒初始化，UI 启动时就可以 setApprovalMode 等
    void this.connectRuntime(resolvedPath).catch((err) => {
      console.error('[AgentBridge] Eager runtime connect failed:', err?.message);
    });
  }

  public getWorkspace(): string | null {
    return this.workspacePath;
  }

  public getClient(): NeoxClient | null {
    return this.client;
  }

  /**
   * 拿到 runtime bridge 本体 —— 给那些**必须落到 runtime 那一侧**的操作用。
   *
   * 典型是进程清场: runtime 跑在 worker thread 之后, 进程表在 worker 里, Electron 主
   * 进程 import 的那个 processManager 是空壳。直接调它 = 成功地杀了 0 个进程, 而且完全
   * 静默。走这个 bridge 时, worker 模式下 getBridge() 返回的是 RPC Proxy, in-process
   * 模式下是本体, 两种模式同一份调用代码。
   */
  public getRuntimeBridge(): Record<string, any> | null {
    try { return this.bridgeGetter?.() ?? null; } catch { return null; }
  }

  public getActionLog(): ActionLogService {
    return this.actionLog;
  }

  public getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  public setCurrentSessionId(sessionId: string | null): void {
    this.currentSessionId = sessionId || null;
  }

  /** agent 实际连接的工作目录 (= cwd)。新建会话 workspacePath 为空时据此自动关联到正确项目, 不再误挂"未关联"。 */
  public getWorkspacePath(): string | null {
    return this.workspacePath;
  }

  public setLastMemorySnapshot(sessionId: string, snapshot: { tokensUsed: number; contextWindow: number; breakdown?: any }): void {
    this.lastMemorySnapshots.set(sessionId, snapshot);
  }

  public getLastMemorySnapshot(sessionId?: string): { tokensUsed: number; contextWindow: number; breakdown?: any } | null {
    const sid = sessionId || this.currentSessionId;
    if (!sid) return null;
    return this.lastMemorySnapshots.get(sid) || null;
  }

  public updateSessionHistory(_sessionId: string, _messages: ChatMessage[]): void {
    /* no-op — 见类顶注释: 原实现只 set 从不 get, 纯内存泄漏位. 调用方无需改动. */
  }

  // ==================== Session / Host 管理 (via SDK) ====================

  public getSandboxStatus(sessionId: string): boolean {
    return this.sandboxStatus.get(sessionId) ?? false;
  }

  public async getContextHealth(sessionId: string): Promise<any> {
    const client = await this.getClientAsync();
    if (!client) return null;
    try {
      return await client.getContextHealth(sessionId);
    } catch (error) {
      console.error('[AgentBridge] Failed to get context health:', error);
      return null;
    }
  }

  public async setSandboxMode(sessionId: string, enabled: boolean, _modelId?: string): Promise<void> {
    this.sandboxStatus.set(sessionId, enabled);
    const client = await this.getClientAsync();
    if (!client) return;
    try {
      await client.setSandboxMode(sessionId, enabled);
    } catch (error) {
      if (error instanceof Error && error.message.includes('No provider configured')) return;
      // [silenced] console.warn('[AgentBridge] Failed to set sandbox mode', error);
    }
  }

  public async getApprovalMode(sessionId: string): Promise<'auto' | 'manual' | 'dangerous'> {
    try {
      const client = await this.getClientAsync();
      if (!client) return 'auto';
      const res = await client.getApprovalMode(sessionId);
      const mode = res?.mode;
      return (mode === 'auto' || mode === 'manual' || mode === 'dangerous') ? mode : 'auto';
    } catch (err: any) {
      console.warn('[AgentBridge] getApprovalMode failed:', err?.message);
      return 'auto';
    }
  }

  /** 设置 → 权限: 「总是允许」清单 / 撤销。Agent 进程没起来时返空、撤销抛错让界面提示。 */
  public async listAlwaysAllow(): Promise<Array<{ toolName: string; timestamp: number }>> {
    try {
      const client = await this.getClientAsync();
      return client ? await client.listAlwaysAllow() : [];
    } catch (err: any) {
      console.warn('[AgentBridge] listAlwaysAllow failed:', err?.message);
      return [];
    }
  }

  public async revokeAlwaysAllow(toolName: string): Promise<void> {
    const client = await this.getClientAsync();
    if (!client) throw new Error('agent server not ready');
    await client.revokeAlwaysAllow(toolName);
  }

  public async setApprovalMode(
    sessionId: string,
    mode: 'auto' | 'manual' | 'dangerous',
    _modelId?: string,
    options?: {
      scope?: 'global' | 'agent';
      scopeKey?: string;
      inherit?: boolean;
      dangerousConfirmation?: {
        acknowledgeNoApproval: true;
        acknowledgeHighRiskExecution: true;
      };
    },
  ): Promise<void> {
    if (mode !== 'auto' && mode !== 'manual' && mode !== 'dangerous') {
      throw new Error(`Invalid approval mode: ${String(mode)}. Expected auto | manual | dangerous.`);
    }
    const client = await this.getClientAsync();
    if (!client) {
      console.warn('[AgentBridge] setApprovalMode: runtime not ready yet, will apply on first chat');
      return;
    }
    await client.setApprovalMode(sessionId, mode, options);
  }

  public interruptSession(sessionId: string): Promise<{ ok: true; sessionId: string }> {
    const pending = this.pendingInterrupts.get(sessionId);
    if (pending) return pending;
    this.sendGenerations.set(sessionId, (this.sendGenerations.get(sessionId) ?? 0) + 1);
    //   双写: console.warn (终端启动可见) + neoxLogger.warn (落盘到 ~/.neox/logs/neox-app-*.log,
    //   只要 toggle 开了就能事后查). 这是诊断"我没点为啥被打断"的唯一线索, 不能靠
    //   终端 stderr 那种丢得快的渠道.
    const stack = new Error('interrupt-caller').stack?.split('\n').slice(1, 10).join('\n') || '(no stack)';
    console.warn('[INTERRUPT_TRIGGER] agentBridge.interruptSession()', { sessionId }, '\n' + stack);
    neoxLogger.warn('INTERRUPT_TRIGGER', 'agentBridge.interruptSession()', { sessionId, stack });
    this.interruptRequestedAt.set(sessionId, Date.now());
    this.sawActivityAfterInterrupt.delete(sessionId);
    this.transitionSessionExecutionState(sessionId, 'idle', 'interrupt', { allowNoop: true });
    const operation = this.getClientAsync().then(async client => {
      if (!client) throw new Error('Runtime not ready');
      await client.abort(sessionId);
      return { ok: true as const, sessionId };
    });
    this.pendingInterrupts.set(sessionId, operation);
    void operation.finally(() => {
      if (this.pendingInterrupts.get(sessionId) === operation) this.pendingInterrupts.delete(sessionId);
    }).catch(error => console.warn('[AgentBridge] Failed to interrupt session', error));
    return operation;
  }

  /** 叠加层「停止」: 中断所有在跑会话, 并立刻掐 computer_run。 */
  public interruptRunningSessions(): string[] {
    const ids: string[] = [];
    for (const [id, state] of this.sessionExecutionStates) {
      if (state !== 'idle') ids.push(id);
    }
    for (const id of ids) void this.interruptSession(id).catch(() => undefined);
    try { this.adapter?.notifyOsControl?.('abort'); } catch { /* ignore */ }
    return ids;
  }

  public async pauseSession(sessionId: string): Promise<{ mainPaused: boolean; workersPaused: number }> {
    const client = await this.getClientAsync();
    if (!client) return { mainPaused: false, workersPaused: 0 };
    try {
      return await client.pauseAll(sessionId);
    } catch (e) {
      // [silenced] console.warn('[AgentBridge] Failed to pause session', e);
      return { mainPaused: false, workersPaused: 0 };
    }
  }

  public async resumeSession(sessionId: string): Promise<{ mainResumed: boolean; workersResumed: number }> {
    const client = await this.getClientAsync();
    if (!client) return { mainResumed: false, workersResumed: 0 };
    try {
      // [silenced] console.log('[AgentBridge] ▶ Resume requested for session:', sessionId);
      return await client.resumeAll(sessionId);
    } catch (e) {
      // [silenced] console.warn('[AgentBridge] Failed to resume session', e);
      return { mainResumed: false, workersResumed: 0 };
    }
  }

  public async pauseProcess(pid: string): Promise<{ paused: boolean }> {
    const client = await this.getClientAsync();
    if (!client) return { paused: false };
    try {
      return await client.pauseProcess(pid);
    } catch (e) {
      // [silenced] console.warn('[AgentBridge] Failed to pause process', e);
      return { paused: false };
    }
  }

  public async resumeProcess(pid: string): Promise<{ resumed: boolean }> {
    const client = await this.getClientAsync();
    if (!client) return { resumed: false };
    try {
      return await client.resumeProcess(pid);
    } catch (e) {
      // [silenced] console.warn('[AgentBridge] Failed to resume process', e);
      return { resumed: false };
    }
  }

  public async replyPermission(requestId: string, approved: boolean, remember?: boolean): Promise<void> {
    const fallbackTimer = this.approvalFallbackTimers.get(requestId);
    if (fallbackTimer) {
      clearTimeout(fallbackTimer);
      this.approvalFallbackTimers.delete(requestId);
    }
    const client = await this.getClientAsync();
    if (!client) return;
    try {
      // [silenced] console.log(`[AgentBridge] Replying permission: requestId=${requestId}, approved=${approved}`);
      await client.replyPermission(requestId, approved, undefined, remember);
    } catch (error) {
      // [silenced] console.warn('[AgentBridge] Failed to reply permission', error);
    }
  }

  public async cancelPermission(
    requestId: string,
    reason?: 'resolved' | 'timeout' | 'manual_cancel' | 'session_aborted' | 'stale',
  ): Promise<void> {
    const fallbackTimer = this.approvalFallbackTimers.get(requestId);
    if (fallbackTimer) {
      clearTimeout(fallbackTimer);
      this.approvalFallbackTimers.delete(requestId);
    }
    const client = await this.getClientAsync();
    if (!client) return;
    try {
      await client.cancelPermission(requestId, reason);
    } catch (error) {
      // [silenced] console.warn('[AgentBridge] Failed to cancel permission', error);
    }
  }

  // ==================== Chat (via SDK) ====================

  public async sendMessage(payload: ChatRequestPayload): Promise<ChatResponsePayload> {
    const sessionId = payload.sessionId || randomUUID();
    const stopping = this.pendingInterrupts.get(sessionId);
    if (stopping) await stopping;
    const compacting = this.compactionOnRetiredRuntime(sessionId);
    if (compacting) await compacting;
    const startedAt = Date.now();
    const runMode = normalizeRunMode(configService.getRunMode());
    const currentState = this.getSessionExecutionState(sessionId);
    const isRecovery = payload.isRetry === true || payload.isContinue === true;
    if (isRecovery && !payload.sessionId) {
      throw new Error('Cannot recover without an existing session');
    }
    if (isRecovery && currentState !== 'idle') {
      throw new Error('Session is still running; recovery cannot be queued as a user message');
    }

    /* 显式校验 prompt — 禁止 undefined.slice / 空转生成.
     * 历史误传 `content` 字段时给明确错误, 不再落到 runtime 崩栈. */
    const rawPrompt = typeof payload.prompt === 'string'
      ? payload.prompt
      : typeof (payload as { content?: unknown }).content === 'string'
        ? null /* content 是错误字段名 */
        : payload.prompt;
    const hasAttachments = Array.isArray(payload.metadata?.attachments)
      && payload.metadata!.attachments!.length > 0;
    if (rawPrompt === null) {
      const msg = '发送失败：消息字段应为 prompt（收到了 content）。请升级客户端或修正调用方。';
      this.emitStream({ type: 'error', sessionId, error: msg, timestamp: Date.now() } as any);
      return {
        sessionId, finalText: msg, tokens: 0, contextUsed: 0, startedAt, finishedAt: Date.now(),
      };
    }
    const promptText = typeof rawPrompt === 'string' ? rawPrompt.trim() : '';
    if (!promptText && !hasAttachments && !isRecovery) {
      const msg = '发送失败：消息内容为空。请输入内容后再发送。';
      this.emitStream({ type: 'error', sessionId, error: msg, timestamp: Date.now() } as any);
      return {
        sessionId, finalText: msg, tokens: 0, contextUsed: 0, startedAt, finishedAt: Date.now(),
      };
    }
    /* 规范化后写回, 下游一律读 payload.prompt */
    (payload as ChatRequestPayload).prompt = isRecovery ? '' : typeof rawPrompt === 'string' ? rawPrompt : promptText;

    if (currentState !== 'idle') {
      const queueGeneration = this.sendGenerations.get(sessionId);
      const queueImages = injectImagesFromAttachments(payload.metadata?.attachments);
      try {
        let position = await this.injectMessage(sessionId, promptText, queueImages);
        const waitUntil = Date.now() + 30_000;
        while (position <= 0 && Date.now() < waitUntil) {
          await new Promise((r) => setTimeout(r, 300));
          if (this.sendGenerations.get(sessionId) !== queueGeneration) {
            return { sessionId, finalText: '', tokens: 0, contextUsed: 0, startedAt, finishedAt: Date.now() };
          }
          if (this.getSessionExecutionState(sessionId) === 'idle') return this.sendMessage(payload);
          position = await this.injectMessage(sessionId, promptText, queueImages).catch(() => 0);
        }
        if (this.sendGenerations.get(sessionId) !== queueGeneration) {
          return { sessionId, finalText: '', tokens: 0, contextUsed: 0, startedAt, finishedAt: Date.now() };
        }
        // A stopped host also rejects injection. Never turn that rejection into a new run.
        if (position <= 0) {
          throw new Error('Message was not queued; the session may be stopping');
        }
        this.transitionSessionExecutionState(sessionId, currentState, 'send:queued-while-busy', { allowNoop: true });
        this.emitStream({
          type: 'status',
          sessionId,
          level: 'info',
          message: '已排队 — 当前回合结束后立即处理',
          queued: true,
          timestamp: Date.now(),
        } as any);
        const lastContextUsed = this.lastMemorySnapshots.get(sessionId)?.tokensUsed || 0;
        return {
          sessionId,
          finalText: '',
          queued: true,
          queuePosition: position,
          tokens: 0,
          contextUsed: lastContextUsed,
          startedAt,
          finishedAt: Date.now(),
        } as any;
      } catch (queueErr: any) {
        if (this.sendGenerations.get(sessionId) !== queueGeneration) {
          return { sessionId, finalText: '', tokens: 0, contextUsed: 0, startedAt, finishedAt: Date.now() };
        }
        const why = queueErr?.message ? String(queueErr.message) : String(queueErr);
        console.warn(`[AgentBridge] busy-queue failed for ${sessionId.slice(0, 16)}: ${why}`);
        this.transitionSessionExecutionState(sessionId, currentState, 'send:single-busy-reject', { allowNoop: true });
        this.emitStream({
          type: 'status',
          sessionId,
          level: 'warning',
          message: `当前会话仍在执行，且排队失败（${why}）。请稍后重发或先中断当前任务。`,
        });
        const lastContextUsed = this.lastMemorySnapshots.get(sessionId)?.tokensUsed || 0;
        return {
          sessionId,
          finalText: `⏳ 当前会话仍在执行，且排队失败（${why}）。请稍后重发或先中断当前任务。`,
          tokens: 0,
          contextUsed: lastContextUsed,
          startedAt,
          finishedAt: Date.now(),
        };
      }
    }

    /* Work 任务文件夹: 这一轮的工作目录换成任务自己的文件夹 (见 workTaskDir.ts)。
     * 它在工作 home 里面, 不算换工作区 —— 下面的 setWorkspace 不能因此重连 runtime。 */
    /* 上一轮模型给了更好的文件夹名但没来得及改 (见 taskDirNaming.ts) —— 趁这一轮还没开始落盘,
     * 改名是安全的: 下面的 ensureWorkTaskDir 读到的就是新路径。 */
    if (payload.sessionId) flushTaskDirRenames(payload.sessionId);
    const taskDir = payload.sessionId ? ensureWorkTaskDir(payload.sessionId, promptText) : null;
    if (taskDir) payload = { ...payload, workspacePath: taskDir };

    if (payload.workspacePath && !sameWorkspace(payload.workspacePath, this.workspacePath)
      && !(taskDir && this.workspacePath && isInsideDir(taskDir, this.workspacePath))) {
      this.setWorkspace(payload.workspacePath);
    }

    this.currentSessionId = sessionId;
    const generation = (this.sendGenerations.get(sessionId) ?? 0) + 1;
    this.sendGenerations.set(sessionId, generation);
    const isCurrentSend = () => this.sendGenerations.get(sessionId) === generation;
    this.interruptRequestedAt.delete(sessionId);
    this.sawActivityAfterInterrupt.delete(sessionId);
    this.transitionSessionExecutionState(sessionId, 'running', 'send:start', { allowNoop: false });
    if (currentState === 'idle') {
      this.eventForwarder.resetSession(sessionId);
    }

    let providerId: string | undefined;
    let modelName: string | undefined;
    if (payload.modelId) {
      const colonIdx = payload.modelId.indexOf(':');
      if (colonIdx > 0) {
        providerId = payload.modelId.slice(0, colonIdx);
        modelName = payload.modelId.slice(colonIdx + 1);
      } else {
        // 然后 agenticRuntime 静默 fallback 到 server 启动时的默认模型
        modelName = payload.modelId;
      }
    } else {
    }
    // [silenced] console.log('[AgentBridge] sendMessage via SDK:', { sessionId, runMode, providerId, modelName, rawModelId: payload.modelId });

    if (providerId) this.lastProviderId = providerId;

    if (isNeoxCloudProviderId(providerId)) {
      const limit = readPlanMaxParallelSessions();
      if (limit !== null && AgentBridge.countRunningCloudSessions(sessionId) >= limit) {
        if (!isRecovery) this.limitBlockedSends.set(sessionId, { prompt: payload.prompt, metadata: payload.metadata });
        const msg = `同时运行的订阅会话已达套餐上限（${limit} 个）。等其他会话跑完或停掉一个后再发送；使用自有 API Key 不受此限制。`;
        this.emitStream({ type: 'error', sessionId, error: msg, timestamp: Date.now() } as any);
        return { sessionId, finalText: msg, tokens: 0, contextUsed: 0, startedAt, finishedAt: Date.now() };
      }
      const blocked = this.limitBlockedSends.get(sessionId);
      this.limitBlockedSends.delete(sessionId);
      if (blocked && isRecovery) {
        Object.assign(payload, { prompt: blocked.prompt, metadata: blocked.metadata, isRetry: false, isContinue: false });
      }
    }
    if (providerId) this.sessionProviders.set(sessionId, providerId);

    let client = await this.getClientAsync();
    if (!isCurrentSend()) {
      return { sessionId, finalText: '', tokens: 0, contextUsed: 0, startedAt, finishedAt: Date.now() };
    }
    if (!client) {
      const userMessage = !this.workspacePath
        ? '请先打开一个项目文件夹，点击左侧「+ 打开项目」即可开始。'
        : this.lastInitError || '遇到了一点问题，请重启应用重试。';
      console.error('[AgentBridge] sendMessage: client is null.', { workspacePath: this.workspacePath, hasAdapter: !!this.adapter, lastInitError: this.lastInitError });
      this.transitionSessionExecutionState(sessionId, 'idle', 'send:error', { allowNoop: true });
      return {
        sessionId,
        finalText: userMessage,
        tokens: 0, contextUsed: 0, startedAt, finishedAt: Date.now(),
      };
    }

    /* GPT 参数兼容路径。
     * 重要: 不再从 configService.getReasoningEffort() 读取默认值, 因为它的 fallback 是 'high'。
     * 新模型菜单已经通过 payload.metadata.effortLevel 做 per-model/per-turn 透传；这里如果继续
     * 注入全局 high, 会覆盖用户在菜单里选的 minimal/low/medium/xhigh, 表现成“只有 high 生效”。
     * 仅保留显式环境变量/旧设置面板值, 避免无配置时强行写 high。 */
    const explicitReasoningEffort = process.env.NEOX_REASONING_EFFORT || process.env.CD_REASONING_EFFORT;
    const modelCfg = configService.getModelConfig();
    const modelConfig = {
      reasoningEffort: explicitReasoningEffort || undefined,
      reasoningSummary: modelCfg?.reasoning_summary || undefined,
      verbosity: modelCfg?.verbosity || undefined,
      serviceTier: modelCfg?.service_tier || undefined,
    };
    // [silenced] console.log('[AgentBridge] modelConfig →', modelConfig);

    //    desktop 端不再注入 — 见上方"历史恢复已下沉到 server"注释.

    this.lastChatPayloads.set(sessionId, payload);

    const sendChat = async (targetClient: NeoxClient) => targetClient.chat(sessionId, payload.prompt, {
      mode: runMode,
      providerId,
      modelName,
      attachments: payload.metadata?.attachments,
      isAutoRouted: payload.metadata?.isAutoRouted,
      routeConfig: payload.metadata?.routeConfig,
      effortLevel: payload.metadata?.effortLevel,
      modelConfig,
      /* 会话级工作区绑定 — renderer 每条消息带 workspacePath (会话所属项目根),
       * server 端优先用它建 host/跑工具, 不再依赖全局 workDir 的"切工作区同步"
       * (多项目并存/重启漏同步会让 agent 在 Neox 自身目录里跑 npm start 等命令). */
      workspacePath: (payload as any).workspacePath,
      workspaceRoots: (payload as any).workspaceRoots,
      userMessageSource: (payload as any).userMessageSource,
      userMessageId: (payload as any).userMessageId,
      isRetry: (payload as any).isRetry,
      /* 「继续」= 从断掉的半截往下接着写 (跟重试是两回事), 同样逐字段转发, 漏了就退化成重试 */
      isContinue: (payload as any).isContinue,
      agentMode: payload.agentMode,
      /* 聊天模式 (+ 菜单切) — 精简 prompt、不带工具; 同样逐字段转发 */
      chatMode: payload.chatMode,
    } as any);

    try {
      await sendChat(client);
      if (!isCurrentSend()) {
        return { sessionId, finalText: '', tokens: 0, contextUsed: 0, startedAt, finishedAt: Date.now() };
      }
      // HTTP chat accepted 只表示 server 已接收任务，不代表 agent loop 已完成。
      // 不能在这里切 idle；真正完成由 SSE session_status=idle / run_result 负责。
      this.transitionSessionExecutionState(sessionId, 'running', 'send:accepted', { allowNoop: true });

      /* chat() 是 fire-and-accept: HTTP 已接收 ≠ agent 跑完。默认立刻返回 (界面靠 SSE 渲染,
       * 阻塞几分钟等一轮跑完是错的)。需要拿到本轮正文的调用方 —— 自动化 / SDK / 冒烟脚本 ——
       * 传 awaitCompletion 就能等 run_result, 不必再从空串里猜。
       * accepted:true 是给所有调用方的明确信号: 空 finalText 是"还没跑完", 不是"回答为空"。 */
      const awaitMs = (payload as any).awaitCompletion
        ? (typeof (payload as any).awaitCompletion === 'number' ? (payload as any).awaitCompletion : 300_000)
        : 0;
      if (awaitMs > 0) {
        this.lastRunResultText.delete(sessionId);
        const text = await this.waitForRunResult(sessionId, awaitMs);
        return {
          sessionId, finalText: text, accepted: true, tokens: 0,
          contextUsed: this.lastMemorySnapshots.get(sessionId)?.tokensUsed || 0,
          startedAt, finishedAt: Date.now(),
        } as any;
      }

      return {
        sessionId, finalText: '', accepted: true, tokens: 0, contextUsed: 0, startedAt, finishedAt: Date.now(),
      } as any;
    } catch (error: any) {
      if (!isCurrentSend()) {
        return { sessionId, finalText: '', tokens: 0, contextUsed: 0, startedAt, finishedAt: Date.now() };
      }
      console.error('[AgentBridge] Runtime chat error:', error);
      const errorMessage = this.extractErrorMessage(error);
      this.transitionSessionExecutionState(sessionId, 'idle', 'send:error', { allowNoop: true });
      this.emitStream({ type: 'error', sessionId, error: errorMessage, timestamp: Date.now() } as any);
      this.emitStream({
        type: 'run_result',
        sessionId,
        output: '',
        iterations: 0,
        toolCalls: 0,
        durationMs: Date.now() - startedAt,
        totalTokens: 0,
        failed: true,
        interrupted: false,
        timestamp: Date.now(),
      } as any);
      return {
        sessionId, finalText: `Error: Error: ${errorMessage}`,
        tokens: 0, contextUsed: 0, startedAt, finishedAt: Date.now(),
      };
    }
  }

  public onRunModeChanged(mode: AgentRunMode): void {
    const client = this.client;
    if (!client || this.currentConnectionWorkDir !== this.workspacePath) {
      return;
    }
    void client.setRunMode(mode).catch(e => {
      console.error('[AgentBridge] Failed to set run mode on server:', e);
    });
  }

  public setLanguage(language: 'zh' | 'en'): void {
    this.userLanguage = language;
  }

  // ==================== Session 管理 (via SDK) ====================

  public clearSession(sessionId: string) {
    this.sandboxStatus.delete(sessionId);
    this.lastMemorySnapshots.delete(sessionId);
    this.sessionExecutionStates.delete(sessionId);
    this.clearExecutionWatchdog(sessionId);
    this.sessionLastActivityAt.delete(sessionId);
    void this.getClientAsync().then(client => {
      client?.clearSession(sessionId).catch(e => {
        // [silenced] console.warn('[AgentBridge] Failed to clear session on server', e);
      });
    });
    // [silenced] console.log('[AgentBridge] Cleared session:', sessionId);
  }

  /** 对话回退: 让运行时忘掉这个会话的记忆 (下一轮从已裁过的 SQLite 重建), **不**归档进长期记忆。
   *  与 clearSession 的区别就在"不归档" —— 归档会把撤掉的那几轮塞进项目记忆, 模型下一轮又读回来。 */
  public forgetSession(sessionId: string) {
    this.lastMemorySnapshots.delete(sessionId);
    void this.getClientAsync().then(client => {
      client?.forgetSession(sessionId).catch(e => {
        console.warn('[AgentBridge] forgetSession failed on runtime:', e?.message ?? e);
      });
    });
  }

  public clearAllSessions() {
    this.approvalFallbackTimers.forEach((timer) => clearTimeout(timer));
    this.approvalFallbackTimers.clear();
    this.sandboxStatus.clear();
    this.lastMemorySnapshots.clear();
    this.executionWatchdogs.forEach((timer) => clearTimeout(timer));
    this.executionWatchdogs.clear();
    this.sessionLastActivityAt.clear();
    this.sessionExecutionStates.clear();
    this.interruptRequestedAt.clear();
    this.sawActivityAfterInterrupt.clear();
    this.syncAuthorityMonitor();
    // Server 端没有 clearAll API，逐个清理不现实，仅清理本地状态
    // [silenced] console.log('[AgentBridge] Cleared all local session state');
  }

  public async compactSession(sessionId: string, modelId?: string): Promise<void> {
    const client = await this.getClientAsync();
    if (!client) throw new Error('Server not connected');
    const owner = this.adapter;
    const run = client.compactSession(sessionId, modelId);
    const done = run.then(() => undefined, () => undefined);
    this.inFlightCompactions.set(sessionId, { adapter: owner, done });
    try {
      await run;
    } finally {
      if (this.inFlightCompactions.get(sessionId)?.done === done) this.inFlightCompactions.delete(sessionId);
      this.disposeRetiredIfIdle(owner);
    }
  }

  private retireAdapter(adapter: any): void {
    const busy = [...this.inFlightCompactions.values()].some((c) => c.adapter === adapter);
    if (!busy) {
      adapter.dispose();
      return;
    }
    console.warn('[AgentBridge] 旧 runtime 上还有压缩在跑, 等它结束再拆');
    this.retiringAdapters.add(adapter);
  }

  private disposeRetiredIfIdle(adapter: any): void {
    if (!adapter || !this.retiringAdapters.has(adapter)) return;
    if ([...this.inFlightCompactions.values()].some((c) => c.adapter === adapter)) return;
    this.retiringAdapters.delete(adapter);
    try { adapter.dispose(); } catch { /* ignore */ }
    console.log('[AgentBridge] 旧 runtime 上的压缩已结束, 已拆除');
  }

  /** 这个会话正在一个已被顶替的旧 runtime 上压缩 → 返回它的 promise。
   *  这时往新 runtime 发消息, 新 runtime 读到的是压缩前的历史, 压缩结果写库时又排在这轮消息之后 —— 要先等压完。 */
  private compactionOnRetiredRuntime(sessionId: string): Promise<void> | null {
    const c = this.inFlightCompactions.get(sessionId);
    return c && c.adapter !== this.adapter ? c.done : null;
  }

  public async setAgentMode(sessionId: string, mode: string): Promise<string> {
    const client = await this.getClientAsync();
    if (!client) throw new Error('Server not connected');
    return (await (client as any).setAgentMode?.(sessionId, mode)) ?? 'code';
  }

  /** Jev 草稿预判 —— 尽力而为: 没连上 / 没开 Jev 都静默跳过, 发送路径不依赖它。 */
  public async jevPrefetch(text: string): Promise<void> {
    const client = await this.getClientAsync();
    await (client as any)?.jevPrefetch?.(text);
  }

  public async getAgentMode(sessionId: string): Promise<string> {
    const client = await this.getClientAsync();
    if (!client) return 'code';
    return (await (client as any).getAgentMode?.(sessionId)) ?? 'code';
  }

  /** 运行中向 session 注入用户消息 (排队, 合适的 iteration gap 自然处理) */
  /** @returns 队列位置; **0 = 没排上** (服务端没有在跑的 host)。调用方必须看返回值 —— 
   *  这条链上曾经每一层都是 void + `?.`, 于是"调用成功但消息不送达"。 */
  public async injectMessage(
    sessionId: string,
    message: string,
    images?: Array<{ mediaType: string; data: string; name?: string }>,
    when?: 'next-step' | 'turn-end',
  ): Promise<number> {
    const client = await this.getClientAsync();
    if (!client) throw new Error('Server not connected');
    const r = await client.injectMessage(sessionId, message, images, when);
    return typeof r === 'number' ? r : 0;
  }

  /** 第二次回车 = 立即转向。跟 grantTargetConsent 同理必须经 bridge 走到跑 agent 的那条线程。
   *  @returns 是否真的打断了在途模型输出 (工具执行中 / 没在跑 → false) */
  public async steerSession(sessionId: string): Promise<boolean> {
    const client = await this.getClientAsync();
    if (!client) return false;
    try {
      const b: any = (client as any).getBridge?.() ?? client;
      return (await b?.steerSession?.(sessionId)) === true;
    } catch (err: any) {
      console.warn('[AgentBridge] steerSession failed:', err?.message ?? err);
      return false;
    }
  }

  /** 删会话: 撤掉它在 runtime 线程上挂的监控 / 未到点唤醒 (那两个登记簿只在 worker 里, 主进程直接调等于没调) */
  public async releaseSessionWatchers(sessionId: string): Promise<void> {
    try {
      const client = await this.getClientAsync();
      const b: any = (client as any)?.getBridge?.() ?? client;
      await b?.releaseSessionWatchers?.(sessionId);
    } catch { /* runtime 没起来就没有可撤的 */ }
  }

  /** 界面药丸: 这个会话在跑的监控 / 停掉一个 —— 同上, 登记簿在 runtime 线程 */
  public async listMonitors(sessionId: string): Promise<unknown[]> {
    try {
      const client = await this.getClientAsync();
      const b: any = (client as any)?.getBridge?.() ?? client;
      const r = await b?.listMonitors?.(sessionId);
      return Array.isArray(r) ? r : [];
    } catch { return []; }
  }

  public async stopMonitor(sessionId: string, id: string): Promise<boolean> {
    try {
      const client = await this.getClientAsync();
      const b: any = (client as any)?.getBridge?.() ?? client;
      return (await b?.stopMonitor?.(sessionId, id)) === true;
    } catch { return false; }
  }

  public async grantTargetConsent(sessionId: string): Promise<void> {
    const client = await this.getClientAsync();
    if (!client) return;
    try {
      const b: any = (client as any).getBridge?.() ?? client;
      await b?.grantTargetConsent?.(sessionId);
    } catch (err: any) {
      console.warn('[AgentBridge] grantTargetConsent failed:', err?.message ?? err);
    }
  }

  public async rememberTargetUserText(sessionId: string, text: string): Promise<void> {
    const client = await this.getClientAsync();
    if (!client) return;
    try {
      const b: any = (client as any).getBridge?.() ?? client;
      await b?.rememberTargetUserText?.(sessionId, text);
    } catch (err: any) {
      console.warn('[AgentBridge] rememberTargetUserText failed:', err?.message ?? err);
    }
  }

  /** 诊断: 这条 session 在 runtime 线程上到底有没有授权 (排查"目标激活失败"第一步查它) */
  public async hasTargetConsent(sessionId: string): Promise<boolean> {
    const client = await this.getClientAsync();
    if (!client) return false;
    try {
      const b: any = (client as any).getBridge?.() ?? client;
      return (await b?.hasTargetConsent?.(sessionId)) === true;
    } catch { return false; }
  }

  /** 看板上把一条需求改派给某个成员 —— 必须打到跑 agent 的那条线程 (worker),
   *  主进程改自己那份 teamPlanStore 副本等于没改 (worker 有独立模块注册表)。 */
  public async assignTeamRequirement(
    sessionId: string,
    requirementId: string,
    memberId: string | null,
  ): Promise<Record<string, unknown> | null> {
    const client = await this.getClientAsync();
    if (!client) return null;
    try {
      const b: any = (client as any).getBridge?.() ?? client;
      return (await b?.assignTeamRequirement?.(sessionId, requirementId, memberId)) ?? null;
    } catch (err: any) {
      console.warn('[AgentBridge] assignTeamRequirement failed:', err?.message ?? err);
      return null;
    }
  }

  /** 退出团队模式 —— 清掉规划态+执行态 (worker 那份才是真的) */
  public async teamDismiss(sessionId: string, force?: boolean): Promise<{ ok: boolean; reason?: string; runningTasks?: string[] } | null> {
    const client = await this.getClientAsync();
    if (!client) return null;
    try {
      const b: any = (client as any).getBridge?.() ?? client;
      return (await b?.teamDismiss?.(sessionId, force)) ?? null;
    } catch (err: any) {
      console.warn('[AgentBridge] teamDismiss failed:', err?.message ?? err);
      return null;
    }
  }

  /** 执行期改方案 (重派/跳过/改派) —— 同样必须打到 worker: 主进程那份 teamExecStore 是副本,
   *  改了正在跑的调度器读不到 (同一个坑咬过五次)。 */
  public async teamExecCommand(
    sessionId: string,
    cmd: 'retry' | 'skip' | 'reassign',
    taskId: string,
    arg?: string,
  ): Promise<Record<string, unknown> | null> {
    const client = await this.getClientAsync();
    if (!client) return null;
    try {
      const b: any = (client as any).getBridge?.() ?? client;
      return (await b?.teamExecCommand?.(sessionId, cmd, taskId, arg)) ?? null;
    } catch (err: any) {
      console.warn('[AgentBridge] teamExecCommand failed:', err?.message ?? err);
      return null;
    }
  }

  /** 会话预算 get / set / clear —— 预算账本在 worker 里, 主进程只转发 */
  public async budgetCommand(sessionId: string, cmd: 'get' | 'set' | 'clear', config?: unknown): Promise<unknown> {
    const client = await this.getClientAsync();
    if (!client) return null;
    try {
      const b: any = (client as any).getBridge?.() ?? client;
      return (await b?.budgetCommand?.(sessionId, cmd, config)) ?? null;
    } catch (err: any) {
      console.warn('[AgentBridge] budgetCommand failed:', err?.message ?? err);
      return null;
    }
  }

  public async targetCommand(
    sessionId: string,
    cmd: 'pause' | 'continue' | 'stop' | 'off' | 'refine',
    arg?: string,
  ): Promise<{ live: boolean; ok: boolean; status?: string; error?: string }> {
    const client = await this.getClientAsync();
    if (!client) return { live: false, ok: false, error: 'runtime not connected' };
    try {
      const b: any = (client as any).getBridge?.() ?? client;
      const r = await b?.targetCommand?.(sessionId, cmd, arg);
      return r ?? { live: false, ok: false };
    } catch (err: any) {
      console.warn('[AgentBridge] targetCommand failed:', err?.message ?? err);
      return { live: false, ok: false, error: String(err?.message ?? err) };
    }
  }

  /** 排队插话没排上的真实原因 (无 host / host 没在跑 / 键不匹配) —— 只诊断, 不改状态 */
  public async describeInjectTarget(sessionId: string): Promise<{ hasHost: boolean; isRunning: boolean; hostSessionIds: string[] } | null> {
    const client = await this.getClientAsync();
    if (!client) return null;
    try {
      const b: any = (client as any).getBridge?.() ?? client;
      const r = await b?.describeInjectTarget?.(sessionId);
      return r ?? null;
    } catch { return null; }
  }

  /** 撤回排队消息, 返回其文本 (拉回输入框编辑)。text = 撤指定那条, 摘不到 = 已被消费 → null */
  public async removeLastPendingMessage(sessionId: string, text?: string): Promise<string | null> {
    const client = await this.getClientAsync();
    if (!client) return null;
    return client.removeLastPendingMessage(sessionId, text);
  }

  public createLeaderTeam(goal: string): any {
    const sessionId = this.currentSessionId || 'assistant';
    return this.getClientAsync().then(client => {
      if (!client) throw new Error('Server not connected');
      return client.createLeaderTeam(sessionId, goal);
    });
  }

  public leaderRecruitMember(teamId: string, payload: { role: string; task: string; providerId?: string; model?: string }): any {
    const sessionId = this.currentSessionId || 'assistant';
    return this.getClientAsync().then(client => {
      if (!client) throw new Error('Server not connected');
      return client.leaderRecruitMember(sessionId, teamId, payload);
    });
  }

  public leaderRequestCapability(teamId: string, capability: string, reason: string): any {
    const sessionId = this.currentSessionId || 'assistant';
    return this.getClientAsync().then(client => {
      if (!client) throw new Error('Server not connected');
      return client.leaderRequestCapability(sessionId, teamId, capability, reason);
    });
  }

  public getStewardRuntimeSnapshot(): any {
    const sessionId = this.currentSessionId || 'assistant';
    return this.getClientAsync().then(async client => {
      if (!client) return null;
      try {
        return await client.getStewardRuntimeSnapshot(sessionId);
      } catch (error: any) {
        const message = String(error?.message || error || '');
        if (/ECONNREFUSED|fetch failed|Server not connected/i.test(message)) {
          return null;
        }
        throw error;
      }
    });
  }

  public async cancelCommitment(commitmentId: string): Promise<{ success: boolean }> {
    const client = await this.getClientAsync();
    if (!client) return { success: false };
    try {
      const sessionId = this.currentSessionId || 'assistant';
      return await client.cancelCommitment(sessionId, commitmentId);
    } catch (error) {
      console.error('[AgentBridge] Failed to cancel commitment:', error);
      return { success: false };
    }
  }

  public getKernelDiagnostics(): any {
    return this.getClientAsync().then(async client => {
      if (!client) return null;
      try {
        return await client.getKernelDiagnostics();
      } catch {
        return null;
      }
    });
  }

  // ==================== Checkpoint (via SDK) ====================

  public async startCheckpointWatching(sessionId: string): Promise<string | null> {
    const client = await this.getClientAsync();
    if (!client) return null;
    try {
      return await client.startCheckpointWatching(sessionId);
    } catch (error) {
      console.error('[AgentBridge] Failed to start checkpoint watching:', error);
      return null;
    }
  }

  public async stopCheckpointWatching(): Promise<void> {
    const client = await this.getClientAsync();
    if (!client) return;
    try {
      await client.stopCheckpointWatching();
    } catch (error) {
      console.error('[AgentBridge] Failed to stop checkpoint watching:', error);
    }
  }

  public async createCheckpoint(sessionId: string, label?: string): Promise<any> {
    const client = await this.getClientAsync();
    if (!client) return null;
    try {
      return await client.createCheckpoint(sessionId, label);
    } catch (error) {
      console.error('[AgentBridge] Failed to create checkpoint:', error);
      return null;
    }
  }

  public async rollbackToCheckpoint(checkpointId: string): Promise<{
    success: boolean; restored: string[]; errors: string[]; reapplyCheckpointId?: string;
  }> {
    const client = await this.getClientAsync();
    if (!client) return { success: false, restored: [], errors: ['Server not connected'] };
    try {
      return await client.rollbackToCheckpoint(checkpointId);
    } catch (error) {
      console.error('[AgentBridge] Failed to rollback:', error);
      return { success: false, restored: [], errors: [String(error)] };
    }
  }

  public async rollbackSingleFile(filePath: string): Promise<{ success: boolean; error?: string }> {
    const client = await this.getClientAsync();
    if (!client) return { success: false, error: 'Server not connected' };
    try {
      return await client.rollbackSingleFile(filePath);
    } catch (error) {
      console.error('[AgentBridge] Failed to rollback single file:', error);
      return { success: false, error: String(error) };
    }
  }

  public async reapplySingleFile(filePath: string): Promise<{ success: boolean; error?: string }> {
    const client = await this.getClientAsync();
    if (!client) return { success: false, error: 'Server not connected' };
    try {
      return await client.reapplySingleFile(filePath);
    } catch (error) {
      console.error('[AgentBridge] Failed to reapply single file:', error);
      return { success: false, error: String(error) };
    }
  }

  /* ── RollbackService 入口 (EDIT-01) ───────────────────────────────────────
   * 撤销 / 恢复的实现只在 core 里有一份, 桌面这里只做转发。 */
  public async revertFile(
    filePath: string,
    options?: { guardCommit?: string; force?: boolean },
  ): Promise<{ success: boolean; error?: string; skipped?: boolean; reason?: string }> {
    const client = await this.getClientAsync();
    if (!client) return { success: false, error: 'Server not connected' };
    try {
      return await client.rollbackSingleFile(filePath, options);
    } catch (error) {
      console.error('[AgentBridge] Failed to revert file:', error);
      return { success: false, error: String(error) };
    }
  }

  public async reapplyFile(filePath: string): Promise<{ success: boolean; error?: string }> {
    return this.reapplySingleFile(filePath);
  }

  public async revertHunk(input: {
    filePath: string;
    oldString?: string;
    newString?: string;
    startLine?: number;
  }): Promise<{ success: boolean; error?: string }> {
    const client = await this.getClientAsync();
    if (!client) return { success: false, error: 'Server not connected' };
    try {
      return await client.revertHunk(input);
    } catch (error) {
      console.error('[AgentBridge] Failed to revert hunk:', error);
      return { success: false, error: String(error) };
    }
  }

  public async rollbackTurn(
    commit: string,
    options?: { files?: string[]; force?: boolean; guardCommit?: string },
  ): Promise<any> {
    const client = await this.getClientAsync();
    if (!client) return { commit, restored: [], skipped: [], failed: [{ path: '*', error: 'Server not connected' }] };
    try {
      return await client.revertTurn(commit, options);
    } catch (error) {
      console.error('[AgentBridge] Failed to roll back turn:', error);
      return { commit, restored: [], skipped: [], failed: [{ path: '*', error: String(error) }] };
    }
  }

  public async getCheckpoints(limit?: number, sessionId?: string): Promise<any[]> {
    const client = await this.getClientAsync();
    if (!client) return [];
    try {
      return await client.getCheckpoints(limit, sessionId);
    } catch (error) {
      console.error('[AgentBridge] Failed to get checkpoints:', error);
      return [];
    }
  }

  public async getCurrentChangeStats(): Promise<{ created: number; modified: number; deleted: number; directories: number; total: number }> {
    const client = await this.getClientAsync();
    if (!client) return { created: 0, modified: 0, deleted: 0, directories: 0, total: 0 };
    try {
      return await client.getCheckpointStats();
    } catch (error) {
      console.error('[AgentBridge] Failed to get change stats:', error);
      return { created: 0, modified: 0, deleted: 0, directories: 0, total: 0 };
    }
  }

  public async getCurrentChanges(): Promise<any[]> {
    const client = await this.getClientAsync();
    if (!client) return [];
    try {
      return await client.getCheckpointChanges();
    } catch (error) {
      console.error('[AgentBridge] Failed to get changes:', error);
      return [];
    }
  }

  public setCheckpointEnabled(enabled: boolean): void {
    void this.getClientAsync().then(client => {
      client?.setCheckpointEnabled(enabled).catch(e => {
        // [silenced] console.warn('[AgentBridge] Failed to set checkpoint enabled', e);
      });
    });
    // [silenced] console.log('[AgentBridge] Checkpoint enabled:', enabled);
  }

  public async isCheckpointEnabled(): Promise<boolean> {
    const client = await this.getClientAsync();
    if (!client) return true;
    try {
      return await client.isCheckpointEnabled();
    } catch {
      return true;
    }
  }

  public async cleanupCheckpoints(): Promise<void> {
    const client = await this.getClientAsync();
    if (!client) return;
    try {
      await client.cleanupCheckpoints();
      // [silenced] console.log('[AgentBridge] Cleaned up checkpoints');
    } catch (error) {
      console.error('[AgentBridge] Failed to cleanup checkpoints:', error);
    }
  }

  // ==================== Error helpers ====================

  private extractErrorMessage(error: any): string {
    if (error.response) {
      const status = error.response.status;
      const data = error.response.data;
      const requestId = this.extractRequestId(error.response.headers);
      const apiMessage = this.extractApiErrorMessage(data);
      const withRequestId = (message: string) => (requestId ? `${message} (request-id: ${requestId})` : message);
      const detailedMessage = apiMessage ? withRequestId(apiMessage) : null;

      if (status === 401) return detailedMessage ?? withRequestId(this.authFailureHint());
      if (status === 429) return detailedMessage ?? withRequestId('Rate limit exceeded. Please try again later.');
      if (status === 400) return detailedMessage ?? withRequestId('Invalid request. Please adjust your input and try again.');
      if (typeof data === 'string') return withRequestId(`API Error (${status}): ${data}`);
      if (detailedMessage) return detailedMessage;
      return withRequestId(`API Error: ${status}`);
    }
    if (error.code === 'ECONNREFUSED') return '无法连接到服务，请检查网络后重试。';
    if (error.code === 'ETIMEDOUT') return '响应超时，请稍后重试。';
    if (error.name === 'NeoxRoutingError') {
      if (/密钥未签发|无.*key/i.test(error.message)) return '请先登录后再使用此模型。点击左下角头像即可登录 ✨';
      if (/gatewayBase|损坏/i.test(error.message)) return '登录状态异常，请重新登录。';
      if (/不路由/i.test(error.message)) return '当前模型暂不可用，请切换其他模型试试。';
      return error.message;
    }
    if (/fetch failed|ENOTFOUND/i.test(error.message)) return '网络异常，请检查网络连接后重试。';
    if (/quota|余额|balance|insufficient/i.test(error.message)) return '使用额度已用完，请前往账户页面充值或切换其他模型。';
    if (this.looksLikeAuthFailure(error.message)) return this.authFailureHint();
    if (/\b403\b|forbidden|denied/i.test(error.message)) return '没有权限使用此功能，请确认账户状态。';
    if (/500|502|503|internal.*error|service.*unavailable/i.test(error.message)) return '服务暂时不可用，请稍后重试。';
    return error.message || '出了点小问题，请重试。';
  }

  private looksLikeAuthFailure(message: string): boolean {
    if (/\b401\b/.test(message)) return true;
    if (/\bunauthorized\b/i.test(message)) return true;
    if (/authentication\s+(failed|error|required)/i.test(message)) return true;
    if (/invalid[_\s-]?api[_\s-]?key/i.test(message)) return true;
    return false;
  }

  private authFailureHint(): string {
    const pid = this.lastProviderId;
    /* provider 未知时给中性文案: 宁可说得笼统, 也别把 BYOK 用户指去登录页。 */
    if (!pid) return '鉴权失败。若使用订阅模型请重新登录；若使用自配服务商，请检查 API Key。';
    if (isNeoxCloudProviderId(pid)) return '登录已过期，请重新登录。';
    return `服务商「${pid}」的 API Key 无效或已过期，请到 服务商设置 里更新。`;
  }

  private extractApiErrorMessage(data: any): string | null {
    if (!data) return null;
    if (typeof data === 'string') return data;
    if (typeof data === 'object') {
      if (typeof data.error === 'string') return data.error;
      if (data.error?.message) return data.error.message;
      if (data.message) return data.message;
    }
    return null;
  }

  private extractRequestId(headers?: Record<string, any>): string | undefined {
    if (!headers) return undefined;
    for (const key of ['x-request-id', 'x-oneapi-request-id', 'cf-ray']) {
      const value = headers[key];
      if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    }
    return undefined;
  }

  private emitStream(event: StreamEvent) {
    super.emit('stream', event as Parameters<AgentBridgeEvents['stream']>[0]);
  }

  // ==================== Lifecycle ====================

  /** 这个 scope 里还有没有会话在跑 —— 切 workspace 时用来决定"能不能拆"。
   *  同步读本地 Map: 这些条目正是本 bridge 自己写的, 它在跑的活它一定知道。 */
  public isSessionRunning(sessionId: string): boolean {
    const state = this.sessionExecutionStates.get(sessionId);
    return !!state && state !== 'idle';
  }

  public hasRunningSessions(): boolean {
    for (const state of this.sessionExecutionStates.values()) {
      if (state !== 'idle') return true;
    }
    /* 压缩不走 sessionExecutionStates, 但同样不能被拆: 切到别的工作区时 ProjectManager 靠这里
     * 决定旧 scope 保活还是 dispose, 漏了它 → 几百 K 的会话压到一半报 "adapter disposed"。 */
    return this.inFlightCompactions.size > 0;
  }

  /** 整个桌面端正在跑的订阅会话数 (不含自己), 按 id 去重: 同一会话可能在几个工作区 runtime 里都非 idle (10-23 一个数成 3 个) */
  private static countRunningCloudSessions(exceptSessionId: string): number {
    const running = new Set<string>();
    for (const b of AgentBridge.liveBridges) {
      for (const [sid, state] of b.sessionExecutionStates) {
        if (sid === exceptSessionId || state === 'idle') continue;
        /* 按量会话同样走网关、同样算在网关的会话数里 */
        if (isNeoxCloudProviderId(b.sessionProviders.get(sid))) running.add(sid);
      }
    }
    return running.size;
  }

  /**
   * agent 的 Chrome (归 runtime 持有, 见 core hostedChrome) 的状态 / 启动 / 关闭 / 聚焦。
   * 外置 Chrome 卡片和 browser-tool IPC 都走这里, 不再由主进程另起一个 Chrome。
   */
  public async browserControl(
    op: 'status' | 'ensure' | 'shutdown' | 'focus',
    opts: { workspacePath?: string } = {},
  ): Promise<{ ok: boolean; running: boolean; browser: string; error?: string }> {
    if (op !== 'status') await this.getClientAsync();
    const rb = this.getRuntimeBridge();
    if (!rb?.browserControl) return { ok: op === 'status', running: false, browser: 'chrome', error: op === 'status' ? undefined : 'runtime not ready' };
    return rb.browserControl(op, opts);
  }

  /** 应用退出: 每个 runtime 把自己的 Chrome 优雅关掉 (保存会话, 下次同 profile 恢复标签)。
   *  进程内直跑的 runtime 拿到的是 bridge 本体, 关的就是主进程那一份, 同一段代码。 */
  public static async shutdownAllBrowsers(timeoutMs = 5_000): Promise<void> {
    const jobs = [...AgentBridge.liveBridges].map((b) => {
      const rb = b.getRuntimeBridge();
      return rb?.browserControl ? Promise.resolve(rb.browserControl('shutdown')).catch(() => {}) : Promise.resolve();
    });
    await Promise.race([Promise.all(jobs), new Promise((r) => setTimeout(r, timeoutMs))]);
  }

  public dispose(): void {
    AgentBridge.liveBridges.delete(this);
    for (const retired of this.retiringAdapters) { try { retired.dispose(); } catch { /* ignore */ } }
    this.retiringAdapters.clear();
    this.inFlightCompactions.clear();
    if (this.adapter) {
      const adapter = this.adapter;
      this.adapter = null;
      /* worker 里的 runtime 持有它自己的 Chrome: 先让它优雅关掉再拆线程 (最多等 3s),
       * 不然 worker 一 terminate, Chrome 可能变成没人管的孤儿窗口。进程内直跑的 Chrome 是
       * 主进程共享的那一份, 别的项目可能还在用, 由应用退出统一关。 */
      const rb = adapter instanceof WorkerRuntimeAdapter ? this.getRuntimeBridge() : null;
      if (rb?.browserControl) {
        void Promise.race([
          Promise.resolve(rb.browserControl('shutdown')).catch(() => {}),
          new Promise((r) => setTimeout(r, 3_000)),
        ]).finally(() => adapter.dispose());
      } else {
        adapter.dispose();
      }
    }
    this.client = null;
    this.executionWatchdogs.forEach((timer) => clearTimeout(timer));
    this.executionWatchdogs.clear();
    this.sessionLastActivityAt.clear();
    this.sessionExecutionStates.clear();
    this.interruptRequestedAt.clear();
    this.sawActivityAfterInterrupt.clear();
    /* 运行态对账/监控 timer 同样要拆干净, 否则 dispose 后还会往已经没有 client 的
     * bridge 上发对账 (走 catch 静默失败, 但白烧 CPU 且日志刷屏)。 */
    if (this.reconcileTimer) { clearTimeout(this.reconcileTimer); this.reconcileTimer = null; }
    if (this.authorityMonitorTimer) { clearInterval(this.authorityMonitorTimer); this.authorityMonitorTimer = null; }
  }

  public shutdownServer(): void {
    this.dispose();
  }

  public async forceRestartServer(): Promise<void> {
    this.dispose();
    this.currentConnectionWorkDir = null;
  }
}
