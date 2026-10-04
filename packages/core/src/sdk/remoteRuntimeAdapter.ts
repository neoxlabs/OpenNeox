/**
 * RemoteRuntimeAdapter — 通过 NeoxClient SDK 连接 server
 */

import { NeoxClient } from './client.js';
import type {
  RuntimeAdapter,
  RuntimeEventCallback,
  AdapterChatRequest,
  AdapterStatus,
} from './runtimeAdapter.js';
import type { ServerEvent } from '../server/eventBus.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { DEFAULT_RETRY_CONFIG } from '@neoxlabs/kernel/types/retryConfig.js';

type RuntimeErrorEvent = {
  type: 'error';
  message?: string;
  code?: string;
};

type AdapterError = Error & { code?: string };

/** Error code of a chat() whose server went away mid-turn: the run is gone, the turn is over. */
export const SERVER_EXITED = 'server_exited';

export class RemoteRuntimeAdapter implements RuntimeAdapter {
  private client: NeoxClient;
  private listeners = new Set<RuntimeEventCallback>();
  private subscription: { close: () => void } | null = null;
  /** 当前 SSE 订阅锁定的 sessionId. undefined = 通配 (boot 期, 收所有 session).
   *  chat() 前会 ensureSubscribedTo(真 sessionId) 把它切到当前会话. */
  private subscribedSessionId: string | undefined = undefined;
  private currentMode: string = 'agentic';
  private running = new Set<string>();
  /**
   * Pending chat() calls per session, oldest first. The server runs a session's turns one after
   * another and ends each with exactly one terminal event (run_result or error), but those events
   * carry no run id. "Enter to interrupt and send" starts a new chat() while the interrupted one is
   * still waiting, so without an owner check the interrupted run's run_result also completed the
   * new chat(): the CLI printed "Done" and went idle while the new run kept working unseen.
   * Each terminal event now goes to the oldest pending chat() of its session, and only to it.
   */
  private pendingChats = new Map<string, object[]>();
  private consumedTerminalEvents = new WeakSet<object>();
  /** Called each time the SSE stream drops and starts reconnecting. */
  private sseDropListeners = new Set<() => void>();
  /** fail() of every chat() still waiting; dispose() settles them instead of leaving them to time out. */
  private pendingFailers = new Set<(error: Error) => void>();
  /* A last-resort cap, not a pacing limit: agent turns that build, install and test routinely run
   * past 15 minutes, and cutting them off loses the turn. Stuck work is caught by the idle timer
   * and by per-tool deadlines instead. */
  private static readonly CHAT_TOTAL_TIMEOUT_MS = Number(process.env.NEOX_CHAT_COMPLETION_TIMEOUT_MS ?? '7200000');
  private static readonly CHAT_IDLE_TIMEOUT_MS = Number(
    process.env.NEOX_CHAT_IDLE_TIMEOUT_MS ?? String(DEFAULT_RETRY_CONFIG.streamIdleTimeoutMs),
  );

  constructor(baseUrl: string, token?: string) {
    this.client = new NeoxClient({ baseUrl, token });
  }

  /** SSE 事件分发 — connect / 重订阅共用. server 端按 channel(session:<id> 或 *) 过滤,
   *  这里把 envelope.data 转给所有 listener. */
  private dispatchServerEvent = (event: ServerEvent): void => {
    /* A terminal event that arrives while a newer chat() of the same session is already waiting
     * belongs to the run that chat() replaced. Mark it so UI listeners close out that run's output
     * without ending the turn the newer run is now driving. */
    if ((event.type === 'run_result' || event.type === 'error') && event.data && typeof event.data === 'object') {
      const waiting = this.pendingChats.get(event.sessionId);
      if (waiting && waiting.length > 1) (event.data as { superseded?: boolean }).superseded = true;
    }
    for (const cb of this.listeners) {
      try {
        cb(event.data, event.tracker ?? {
          contextUsed: 0,
          startTime: Date.now(),
          provider: '',
          model: '',
        });
      } catch (e) {
        cliLogger.error('REMOTE_ADAPTER', 'Event callback error', { error: e });
      }
    }
    // 跟踪运行状态 — 用 envelope.sessionId (data 里没有)
    if (event.type === 'run_result' || event.type === 'error') {
      this.running.delete(event.sessionId);
    }
  };

  /** 打开 (或重开) SSE 订阅, 锁定到 sessionId (undefined = 通配收全部). 幂等替换旧订阅. */
  private async openSubscription(sessionId?: string): Promise<void> {
    if (this.subscription) {
      try { this.subscription.close(); } catch { /* ignore */ }
      this.subscription = null;
    }
    this.subscribedSessionId = sessionId;
    this.subscription = await this.client.subscribe(this.dispatchServerEvent, sessionId, undefined, () => {
      for (const cb of this.sseDropListeners) cb();
    });
    cliLogger.info('REMOTE_ADAPTER', 'SSE subscribed', { sessionId: sessionId ?? '(all)' });
  }

  async connect(sessionId?: string): Promise<void> {
    await this.openSubscription(sessionId);
  }

  private async ensureSubscribedTo(sessionId: string): Promise<void> {
    if (this.subscription && this.subscribedSessionId === sessionId) return;
    await this.openSubscription(sessionId);
  }

  async chat(request: AdapterChatRequest): Promise<void> {
    this.running.add(request.sessionId);

    await this.ensureSubscribedTo(request.sessionId);

    const isSameSessionEvent = (event: any): boolean => {
      const sid = event?.sessionId;
      if (!sid) return true;
      return sid === request.sessionId;
    };

    const startedAt = Date.now();
    let idleTimer: NodeJS.Timeout | null = null;
    let totalTimer: NodeJS.Timeout | null = null;
    let settled = false;
    let cleanupFn: () => void = () => { };

    const ticket = {};
    const queue = this.pendingChats.get(request.sessionId) ?? [];
    queue.push(ticket);
    this.pendingChats.set(request.sessionId, queue);
    const leaveQueue = (): void => {
      const q = this.pendingChats.get(request.sessionId);
      if (!q) return;
      const i = q.indexOf(ticket);
      if (i >= 0) q.splice(i, 1);
      if (q.length === 0) this.pendingChats.delete(request.sessionId);
    };
    /** True when this terminal event belongs to this chat() (it is the oldest one still waiting). */
    const claimTerminal = (event: object): boolean => {
      if (this.consumedTerminalEvents.has(event)) return false;
      if (this.pendingChats.get(request.sessionId)?.[0] !== ticket) return false;
      this.consumedTerminalEvents.add(event);
      return true;
    };

    // 创建 Promise 等待 SSE 收到 run_result 或 error 事件
    const completionPromise = new Promise<void>((resolve, reject) => {
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanupFn();
        reject(error);
      };

      const succeed = (): void => {
        if (settled) return;
        settled = true;
        cleanupFn();
        resolve();
      };

      /* Giving up on the client side must also stop the run on the server; otherwise the run keeps
       * executing tools with nobody watching, and the next message starts a second run beside it. */
      const timeOut = (message: string): void => {
        if (settled) return;
        this.abort(request.sessionId);
        fail(new Error(message));
      };

      const refreshIdleTimer = (): void => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          const elapsed = Date.now() - startedAt;
          timeOut(`chat completion idle timeout after ${elapsed}ms (session=${request.sessionId})`);
        }, RemoteRuntimeAdapter.CHAT_IDLE_TIMEOUT_MS);
      };

      const onEvent: RuntimeEventCallback = (event, _tracker) => {
        if (!isSameSessionEvent(event)) {
          return;
        }

        refreshIdleTimer();

        if ((event.type === 'run_result' || event.type === 'error') && !claimTerminal(event as object)) {
          return;
        }
        if (event.type === 'run_result') {
          succeed();
        } else if (event.type === 'error') {
          const runtimeError = event as RuntimeErrorEvent;
          const err = new Error(runtimeError.message || 'Runtime error') as AdapterError;
          if (runtimeError.code) {
            err.code = runtimeError.code;
          }
          fail(err);
        }
      };

      /* The daemon can die mid-turn (killed by another process, crash). The SSE stream then drops
       * and reconnects forever, and the chat used to sit silent until the idle timer, then report
       * "chat completion idle timeout" — two minutes of nothing followed by a cryptic error, in a
       * CLI trial. A drop plus an unreachable /health means the run is gone with the process. The
       * turn ends here as interrupted; it is not re-sent (a crashed turn is over, the user decides
       * whether to continue). */
      let probing = false;
      const onSseDrop = (): void => {
        if (probing || settled) return;
        probing = true;
        void this.client.isHealthy().then((healthy) => {
          probing = false;
          if (healthy || settled) return;
          const err = new Error(`Neox server exited during the turn (session=${request.sessionId})`) as AdapterError;
          err.code = SERVER_EXITED;
          this.running.delete(request.sessionId);
          fail(err);
        });
      };
      this.sseDropListeners.add(onSseDrop);
      this.pendingFailers.add(fail);

      cleanupFn = () => {
        this.listeners.delete(onEvent);
        this.sseDropListeners.delete(onSseDrop);
        this.pendingFailers.delete(fail);
        leaveQueue();
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
        if (totalTimer) {
          clearTimeout(totalTimer);
          totalTimer = null;
        }
      };

      this.listeners.add(onEvent);

      totalTimer = setTimeout(() => {
        const elapsed = Date.now() - startedAt;
        timeOut(`chat completion timeout after ${elapsed}ms (session=${request.sessionId})`);
      }, RemoteRuntimeAdapter.CHAT_TOTAL_TIMEOUT_MS);
      refreshIdleTimer();
    });

    // 发起 HTTP 请求（server 立即返回 { status: 'started' }）
    try {
      await this.client.chat(request.sessionId, request.prompt, {
        mode: request.mode,
        attachments: request.attachments,
        providerId: request.providerId,
        modelName: request.modelName,
        isAutoRouted: request.isAutoRouted,
        routeConfig: request.routeConfig,
        effortLevel: request.effortLevel,
      });
    } catch (error) {
      if (!settled) {
        settled = true;
        cleanupFn();
      }
      throw error;
    }

    // 等待 SSE 事件流中的完成信号
    await completionPromise;
  }

  abort(sessionId: string): void {
    this.client.abort(sessionId).catch(e => {
      cliLogger.error('REMOTE_ADAPTER', 'Abort failed', { error: e });
    });
    this.running.delete(sessionId);
  }

  injectMessage(sessionId: string, message: string, images?: Array<{ mediaType: string; data: string; name?: string }>, when?: 'next-step' | 'turn-end'): void {
    this.client.injectMessage(sessionId, message, images, when).catch(e => {
      cliLogger.error('REMOTE_ADAPTER', 'Inject failed', { error: e });
    });
  }

  onEvent(callback: RuntimeEventCallback): void {
    this.listeners.add(callback);
  }

  offEvent(callback: RuntimeEventCallback): void {
    this.listeners.delete(callback);
  }

  setRunMode(mode: string): void {
    this.currentMode = mode;
    this.client.setRunMode(mode).catch(e => {
      cliLogger.error('REMOTE_ADAPTER', 'setRunMode failed', { error: e });
    });
  }

  getRunMode(): string {
    return this.currentMode;
  }

  getStatus(): AdapterStatus {
    return {
      isRunning: this.running.size > 0,
      mode: this.currentMode,
      activeSessions: [...this.running],
    };
  }

  dispose(): void {
    /* dispose() is how the CLI replaces a dead connection. A chat() still waiting on this adapter
     * would never hear from the new one, so end it now as a connection loss. */
    for (const fail of [...this.pendingFailers]) {
      const err = new Error('Connection to the Neox server was replaced during the turn') as AdapterError;
      err.code = SERVER_EXITED;
      fail(err);
    }
    this.subscription?.close();
    this.subscription = null;
    this.listeners.clear();
    this.running.clear();
  }
}
