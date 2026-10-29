import type { Session, ChatMessage } from '../../shared/ipc.js';
import { storageService } from '../../../platform-electron/storageService.js';
import { sessionStore } from '@neoxlabs/core/platform/sessionStore.js';
import { getDatabase } from '@neoxlabs/platform/platform/database.js';
import { SQLiteSession } from '@neoxlabs/core/memory/sqlite-session.js';
import type { AgentBridge } from './agentBridge.js';

export interface UpdateSessionContextUsedOptions {
  persist?: boolean;
  contextWindow?: number;
  force?: boolean;
  breakdown?: { systemTokens: number; messageTokens: number; toolTokens: number };
  latestRequestUsage?: {
    model?: string;
    inputTokens: number;
    billableInputTokens?: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    totalTokens: number;
    breakdown?: { systemTokens: number; messageTokens: number; toolTokens: number };
  } | null;
  /** 会话累积用量快照(forwarder 逐轮累加) — 落 sessions.session_usage, 跨重启恢复 */
  sessionUsage?: import('../../shared/ipc.js').SessionCacheUsage | null;
}

export interface SessionStateServices {
  sessionsCache: Map<string, Session>;
  getSessionOrThrow: (sessionId: string) => Promise<Session>;
  persistSession: (session: Session) => Promise<Session>;
  updateSessionContextUsed: (
    sessionId: string,
    contextUsed: number,
    options?: UpdateSessionContextUsedOptions,
  ) => Promise<void>;
  getSqliteSession: (sessionId: string) => SQLiteSession;
  refreshSession: (sessionId: string) => Promise<Session>;
}

/**
 * 由 caller 提供: 根据 session (workspacePath) 找到对应的 AgentBridge.
 * 没找到 (项目没开) → undefined, 由本 service 决定 noop.
 *
 * 用 lookup 函数而不是直接传 ProjectManager, 避免循环依赖
 * (main.ts 的 projectManager 构造顺序问题).
 */
export type BridgeForSessionLookup = (session: Session) => AgentBridge | undefined;

export function createSessionStateServices(getBridgeForSession: BridgeForSessionLookup): SessionStateServices {
  const sessionsCache = new Map<string, Session>();

  function pushHistoryToScope(session: Session, messages: ChatMessage[]): void {
    const bridge = getBridgeForSession(session);
    if (bridge) {
      bridge.updateSessionHistory(session.id, messages);
    }
  }

  async function getSessionOrThrow(sessionId: string): Promise<Session> {
    let session: Session | null | undefined = sessionsCache.get(sessionId);
    if (!session) {
      session = await sessionStore.loadSession(sessionId);
      if (!session) {
        throw new Error('Session not found');
      }
      sessionsCache.set(sessionId, session);
    }
    return session;
  }

  async function persistSession(session: Session): Promise<Session> {
    session.updatedAt = Date.now();
    try {
      const dbSession = getDatabase().getSession(session.id);
      if (dbSession && dbSession.contextUsed > 0 && (!session.contextUsed || session.contextUsed <= 0)) {
        session.contextUsed = dbSession.contextUsed;
      }
      if (dbSession && dbSession.contextWindow && !session.contextWindow) {
        session.contextWindow = dbSession.contextWindow;
      }
      if (dbSession && typeof dbSession.name === 'string' && dbSession.name && dbSession.name !== session.name) {
        session.name = dbSession.name;
      }
    } catch { /* ignore */ }
    sessionsCache.set(session.id, session);
    await sessionStore.saveSessionMetadata(session);
    if (session.workspacePath) {
      await storageService.updateWorkspaceLastSession(session.workspacePath, session.id);
    }
    pushHistoryToScope(session, session.messages);
    return session;
  }

  async function updateSessionContextUsed(
    sessionId: string,
    contextUsed: number,
    options: UpdateSessionContextUsedOptions = {},
  ): Promise<void> {
    const hasSupplementalUpdates = Boolean(options.breakdown) || Boolean(options.contextWindow && options.contextWindow > 0);
    // contextUsed=0 时仍允许更新 contextWindow 等补充字段
    if ((!contextUsed || contextUsed <= 0) && !hasSupplementalUpdates) return;

    let session: Session | null | undefined = sessionsCache.get(sessionId);
    if (!session) {
      session = await sessionStore.loadSession(sessionId);
      if (!session) return;
      sessionsCache.set(sessionId, session);
    }
    if (!options.force && contextUsed <= session.contextUsed && !hasSupplementalUpdates) return;

    session.contextUsed = options.force ? contextUsed : Math.max(session.contextUsed || 0, contextUsed);
    if (options.contextWindow && options.contextWindow > 0) {
      session.contextWindow = options.contextWindow;
    }
    if (options.breakdown) {
      session.contextBreakdown = options.breakdown;
    }
    if (options.latestRequestUsage) {
      session.latestRequestUsage = options.latestRequestUsage;
    }
    if (options.sessionUsage) {
      session.sessionUsage = options.sessionUsage;
    }

    sessionsCache.set(session.id, session);

    if (options.persist) {
      try {
        /* 写 in-memory max 过的值 (session.contextUsed), 不是原始入参 — 防止
         * supplemental-only 调用 (e.g. memory_snapshot 只带 contextWindow, 入参 0)
         * 把 DB 的 context_used 列降级. compaction 主动收缩走 force:true. */
        getDatabase().updateSessionContextUsed(
          sessionId,
          options.force ? contextUsed : session.contextUsed,
          options.contextWindow,
          options.breakdown,
          options.latestRequestUsage,
          options.sessionUsage,
        );
      } catch (e: any) {
        console.error('[updateSessionContextUsed] persist failed:', e.message);
      }
    }
  }

  function recalcSessionStats(session: Session): void {
    session.totalTokens = session.messages.reduce((sum, msg) => sum + (msg.tokens || 0), 0);
    /* contextUsed 不是 lifetime total。压缩后它应降到 finalTokens, 不能因为重新统计
     * messages token 或旧 totalTokens 又被 Math.max 抬回压缩前高水位。 */
    if (!session.contextUsed || session.contextUsed <= 0) {
      session.contextUsed = session.totalTokens;
    }
  }

  function getSqliteSession(sessionId: string): SQLiteSession {
    return new SQLiteSession(sessionId);
  }

  async function refreshSession(sessionId: string): Promise<Session> {
    const session = await sessionStore.loadSession(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }
    session.updatedAt = Date.now();
    recalcSessionStats(session);
    await sessionStore.saveSessionMetadata(session);
    if (session.workspacePath) {
      await storageService.updateWorkspaceLastSession(session.workspacePath, session.id);
    }
    sessionsCache.set(sessionId, session);
    pushHistoryToScope(session, session.messages);
    return session;
  }

  return {
    sessionsCache,
    getSessionOrThrow,
    persistSession,
    updateSessionContextUsed,
    getSqliteSession,
    refreshSession,
  };
}
