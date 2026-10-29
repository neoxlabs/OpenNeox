/**
 * DebuggerManager — 全局会话注册中心. 对应 IDEA 的 XDebuggerManager.
 *
 * 单例. 持所有活跃 DebugSession, 按 id 索引. 上层 UI / RunManager 拿到它就能
 * - start(config) 起一个新会话
 * - getActive() 看现在有几个会话
 * - 订阅 add/remove 来刷新 Debug 工具窗
 *
 * 不直接 spawn 进程 — 把 config 路由到对应 BackendFactory, 拿回 DebugSession
 * 注册进来.
 */

import type {
  DebugLaunchConfig,
  DebugSessionEvent,
  DebugSessionStatus,
} from '@neoxlabs/platform/shared/debug-types.js';
import type { DebugSession } from './DebugSession.js';

export type BackendFactory = (config: DebugLaunchConfig) => Promise<DebugSession>;

export type DebuggerManagerEvent =
  | { type: 'session-added'; session: DebugSession }
  | { type: 'session-removed'; sessionId: string }
  | { type: 'session-status-changed'; sessionId: string; status: DebugSessionStatus }
  | { type: 'session-event'; sessionId: string; event: DebugSessionEvent };

export type DebuggerManagerListener = (event: DebuggerManagerEvent) => void;

export class DebuggerManager {
  private readonly sessions = new Map<string, DebugSession>();
  private readonly listeners = new Set<DebuggerManagerListener>();
  private readonly backends = new Map<DebugLaunchConfig['kind'], BackendFactory>();

  registerBackend(kind: DebugLaunchConfig['kind'], factory: BackendFactory): void {
    this.backends.set(kind, factory);
  }

  async start(config: DebugLaunchConfig): Promise<DebugSession> {
    const factory = this.backends.get(config.kind);
    if (!factory) {
      throw new Error(`No debug backend registered for kind=${config.kind}`);
    }
    const session = await factory(config);
    this.sessions.set(session.id, session);

    const offEvent = session.onEvent((event) => {
      this.emit({ type: 'session-event', sessionId: session.id, event });
      if (event.type === 'terminated' || event.type === 'exited') {
        this.remove(session.id);
      }
    });

    // 把 dispose 挂在 session 上 — 简化一点直接覆盖 disconnect 不行, 用 close 钩子
    const origDisconnect = session.disconnect.bind(session);
    session.disconnect = async (terminate?: boolean) => {
      try {
        await origDisconnect(terminate);
      } finally {
        offEvent();
        this.remove(session.id);
      }
    };

    this.emit({ type: 'session-added', session });

    try {
      await session.start();
    } catch (err) {
      this.remove(session.id);
      throw err;
    }
    return session;
  }

  /** 直接用一个已经手工构造好的 session — 测试 / 特殊场景用 */
  attach(session: DebugSession): void {
    if (this.sessions.has(session.id)) return;
    this.sessions.set(session.id, session);
    this.emit({ type: 'session-added', session });
  }

  remove(sessionId: string): void {
    if (!this.sessions.delete(sessionId)) return;
    this.emit({ type: 'session-removed', sessionId });
  }

  get(sessionId: string): DebugSession | undefined {
    return this.sessions.get(sessionId);
  }

  getActive(): readonly DebugSession[] {
    return [...this.sessions.values()];
  }

  /** UI 想立刻知道某个 session 的最新状态时用 (有些后端只在变化时 push) */
  notifyStatusChanged(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.emit({ type: 'session-status-changed', sessionId, status: s.status() });
  }

  on(listener: DebuggerManagerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: DebuggerManagerEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (err) {
        console.error('[DebuggerManager] listener threw:', err);
      }
    }
  }
}
