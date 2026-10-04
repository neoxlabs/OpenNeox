
import type {
  Session,
  SessionManager as ISessionManager,
  SessionInfo,
  SessionMeta
} from '@neoxlabs/kernel/types/session.js';
import { SQLiteSession } from './sqlite-session.js';
import { generateSessionId } from '@neoxlabs/kernel/types/session.js';
import { getDatabase } from '@neoxlabs/platform/platform/database.js';
import { onUserIdChange } from '@neoxlabs/platform/utils/config.js';

// ============================================================================
// 配置
// ============================================================================

export interface SessionManagerOptions {
  /** 存储目录 (legacy, 仅用于兼容) */
  directory?: string;
  /** 默认 Agent 名称 */
  defaultAgentName?: string;
  /** 默认模型 */
  defaultModel?: string;
}

// ============================================================================
// SessionManager 实现
// ============================================================================

export class DefaultSessionManager implements ISessionManager {
  private options: SessionManagerOptions;
  private sessionCache: Map<string, Session> = new Map();
  private directory: string;

  constructor(options?: SessionManagerOptions) {
    this.options = options || {};
    // 保留 directory 属性供 legacy 代码引用
    this.directory = options?.directory || '';
    /* P1: 加入弱引用全局表 — onUserIdChange 在模块加载时一次性注册, 用户切换时
     *   遍历表清所有活实例的 sessionCache. 不能在 ctor 直接订阅: 该类是 short-lived
     *   工厂式实例化 (memory/index.ts 多处 new), 订阅永不解绑会泄漏 handler. */
    _liveManagers.add(new WeakRef(this));
  }

  // --------------------------------------------------------------------------
  // 核心方法
  // --------------------------------------------------------------------------

  async getSession(sessionId: string): Promise<Session> {
    // 检查缓存
    if (this.sessionCache.has(sessionId)) {
      return this.sessionCache.get(sessionId)!;
    }

    const session = new SQLiteSession(sessionId);
    this.sessionCache.set(sessionId, session);
    return session;
  }

  async listSessions(): Promise<SessionInfo[]> {
    const db = getDatabase();
    const rows = db.listSessions();

    return rows.map((row: any) => ({
      sessionId: row.id,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
      itemCount: db.getMessageCount(row.id),
      agentName: row.name,
    }));
  }

  async getMostRecent(): Promise<Session | null> {
    const db = getDatabase();
    const sessions = db.listSessions(); // 已按 updated_at DESC 排序
    if (sessions.length === 0) return null;
    return this.getSession(sessions[0].id);
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    this.sessionCache.delete(sessionId);
    try {
      getDatabase().deleteSession(sessionId);
      return true;
    } catch {
      return false;
    }
  }

  async searchSessions(query: string): Promise<SessionInfo[]> {
    const db = getDatabase();
    // 先按 session 元数据搜索
    const allSessions = await this.listSessions();
    const lowerQuery = query.toLowerCase();

    return allSessions.filter(session => {
      // 检查 sessionId
      if (session.sessionId.toLowerCase().includes(lowerQuery)) return true;
      // 检查 name
      if (session.agentName?.toLowerCase().includes(lowerQuery)) return true;
      // 检查消息内容（通过 SQL）
      const rawDb = db.getRawDb();
      const found = rawDb.prepare(
        "SELECT 1 FROM messages WHERE session_id = ? AND item_data LIKE ? LIMIT 1"
      ).get(session.sessionId, `%${query}%`);
      return !!found;
    });
  }

  // --------------------------------------------------------------------------
  // 扩展方法
  // --------------------------------------------------------------------------

  async createSession(options?: {
    agentName?: string;
    model?: string;
    sessionId?: string;
  }): Promise<Session> {
    const sessionId = options?.sessionId || generateSessionId();
    const db = getDatabase();

    // 确保 sessions 表有记录
    const existing = db.getSession(sessionId);
    if (!existing) {
      db.upsertSession({
        id: sessionId,
        name: options?.agentName || this.options.defaultAgentName || `Session ${sessionId}`,
        modelId: options?.model || this.options.defaultModel || 'unknown',
        workspacePath: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        totalTokens: 0,
        contextUsed: 0,
        fileRollbackCheckpointId: null,
        fileReapplyCheckpointId: null,
        fileRevertedMap: {},
        fileConfirmedMap: {},
      });
    }

    const session = new SQLiteSession(sessionId);

    // 自动创建 meta
    const meta: SessionMeta = {
      sessionId,
      createdAt: new Date().toISOString(),
      agentName: options?.agentName || this.options.defaultAgentName,
      model: options?.model || this.options.defaultModel,
    };
    await session.addItems([{ type: 'meta', data: meta }]);

    this.sessionCache.set(sessionId, session);
    return session;
  }

  async getOrCreateSession(sessionId?: string): Promise<Session> {
    if (sessionId) {
      return this.getSession(sessionId);
    }
    return this.createSession();
  }

  async continueOrCreate(): Promise<Session> {
    const recent = await this.getMostRecent();
    if (recent) return recent;
    return this.createSession();
  }

  async cleanupOldSessions(_maxAge: number = 30): Promise<number> {
    // Session history is user data. Never prune it automatically.
    // Keep this no-op method only for compatibility with older call sites.
    return 0;
  }

  getDirectory(): string {
    return this.directory;
  }

  async getSessionCount(): Promise<number> {
    const db = getDatabase();
    const sessions = db.listSessions();
    return sessions.length;
  }

  async exportSession(sessionId: string): Promise<string> {
    const session = await this.getSession(sessionId);
    const items = await session.getItems();
    const meta = await session.getMeta();

    return JSON.stringify({
      sessionId,
      meta,
      items,
      exportedAt: new Date().toISOString()
    }, null, 2);
  }
}

// 导出默认单例（可选）
let defaultManager: DefaultSessionManager | null = null;

export function getDefaultSessionManager(): DefaultSessionManager {
  if (!defaultManager) {
    defaultManager = new DefaultSessionManager();
  }
  return defaultManager;
}

/* 活实例弱引用表 — ctor 把 WeakRef 推进来, 用户切换时遍历清 sessionCache.
 * WeakRef 不阻止 GC, 死实例下次扫到 deref()===undefined 顺手剔除. */
const _liveManagers = new Set<WeakRef<DefaultSessionManager>>();

onUserIdChange((next, prev) => {
  void next; void prev;
  for (const ref of _liveManagers) {
    const mgr = ref.deref();
    if (!mgr) { _liveManagers.delete(ref); continue; }
    /* @ts-expect-error 跨私有边界清 cache — 这是用户隔离的护栏, 类内开 public API 不值得. */
    mgr.sessionCache.clear();
  }
});
