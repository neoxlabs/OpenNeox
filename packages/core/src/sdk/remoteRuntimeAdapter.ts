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

export class RemoteRuntimeAdapter implements RuntimeAdapter {
  private client: NeoxClient;
  private listeners = new Set<RuntimeEventCallback>();
  private subscription: { close: () => void } | null = null;
  /** 当前 SSE 订阅锁定的 sessionId. undefined = 通配 (boot 期, 收所有 session).
   *  chat() 前会 ensureSubscribedTo(真 sessionId) 把它切到当前会话. */
  private subscribedSessionId: string | undefined = undefined;
  private currentMode: string = 'agentic';
  private running = new Set<string>();
  private static readonly CHAT_TOTAL_TIMEOUT_MS = Number(process.env.NEOX_CHAT_COMPLETION_TIMEOUT_MS ?? '900000');
  private static readonly CHAT_IDLE_TIMEOUT_MS = Number(
    process.env.NEOX_CHAT_IDLE_TIMEOUT_MS ?? String(DEFAULT_RETRY_CONFIG.streamIdleTimeoutMs),
  );

  constructor(baseUrl: string, token?: string) {
    this.client = new NeoxClient({ baseUrl, token });
  }

  /** SSE 事件分发 — connect / 重订阅共用. server 端按 channel(session:<id> 或 *) 过滤,
   *  这里把 envelope.data 转给所有 listener. */
  private dispatchServerEvent = (event: ServerEvent): void => {
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
    this.subscription = await this.client.subscribe(this.dispatchServerEvent, sessionId);
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

      const refreshIdleTimer = (): void => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          const elapsed = Date.now() - startedAt;
          fail(new Error(`chat completion idle timeout after ${elapsed}ms (session=${request.sessionId})`));
        }, RemoteRuntimeAdapter.CHAT_IDLE_TIMEOUT_MS);
      };

      const onEvent: RuntimeEventCallback = (event, _tracker) => {
        if (!isSameSessionEvent(event)) {
          return;
        }

        refreshIdleTimer();

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

      cleanupFn = () => {
        this.listeners.delete(onEvent);
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
        fail(new Error(`chat completion timeout after ${elapsed}ms (session=${request.sessionId})`));
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

  injectMessage(sessionId: string, message: string, images?: Array<{ mediaType: string; data: string; name?: string }>): void {
    this.client.injectMessage(sessionId, message, images).catch(e => {
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
    this.subscription?.close();
    this.subscription = null;
    this.listeners.clear();
    this.running.clear();
  }
}
