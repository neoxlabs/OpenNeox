
import type { Session as UISession, ChatMessage, SavedTimelineEntry } from '@neoxlabs/platform/shared/ipc.js';
import type { Message } from '@neoxlabs/kernel/types/index.js';
import type { TimestampedSessionItem } from '@neoxlabs/kernel/types/session.js';
import { messageToSessionItem } from '@neoxlabs/kernel/types/session.js';
import { DefaultSessionManager } from '../memory/session-manager.js';
import { SQLiteSession } from '../memory/sqlite-session.js';
import { getTextFromContent } from '@neoxlabs/kernel/utils/messageUtils.js';
import { getDatabase } from '@neoxlabs/platform/platform/database.js';
import { loadConfig } from '@neoxlabs/platform/utils/config.js';
import { normalizeAgentMode } from '@neoxlabs/platform/runtime/agentMode.js';

function estimateTokensFromText(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function estimateTokensFromMessages(messages: ChatMessage[]): number {
  return messages.reduce((sum, msg) => {
    if (typeof msg.tokens === 'number') {
      return sum + msg.tokens;
    }
    return sum + estimateTokensFromText(msg.text || '');
  }, 0);
}

function toMessageContentText(content: Message['content']): string {
  if (content === null || typeof content === 'string') {
    return content || '';
  }
  return getTextFromContent(content);
}

function chatMessageToMessage(message: ChatMessage): Message {
  return {
    role: message.role,
    content: message.text || '',
  };
}

function timelineEntryToChatMessage(entry: TimestampedSessionItem, sessionId: string): ChatMessage | null {
  if (entry.item.type !== 'message') return null;
  const data = entry.item.data as Message;
  if (data.role !== 'user' && data.role !== 'assistant' && data.role !== 'system') {
    return null;
  }
  return {
    id: `msg_${sessionId}_${entry.seq}`,
    role: data.role,
    text: toMessageContentText(data.content),
    timestamp: entry.timestamp,
    sequence: entry.seq,
  };
}

/** childSessionId → 归属提示。只服务于占位行, 见 rememberSubAgentParent 的说明。 */
const subAgentParentHints = new Map<string, { parentSessionId: string; workspacePath: string }>();
const SUB_AGENT_HINT_MAX = 200;

/** 诊断/测试用 —— 占位行会拿它来填 parent_session_id 与 workspace_path。 */
export function peekSubAgentParentHint(
  childSessionId: string,
): { parentSessionId: string; workspacePath: string } | undefined {
  return subAgentParentHints.get(childSessionId);
}

export class SessionStore {
  private sessionManager: DefaultSessionManager;

  constructor(options?: { sessionManager?: DefaultSessionManager }) {
    this.sessionManager = options?.sessionManager ?? new DefaultSessionManager();
  }

  getSessionManager(): DefaultSessionManager {
    return this.sessionManager;
  }

  // ==================== Build Session from DB ====================

  private async buildSession(sessionId: string): Promise<UISession> {
    const db = getDatabase();
    const dbSession = db.getSession(sessionId);

    // 从 SQLiteSession 获取消息历史
    const sqliteSession = new SQLiteSession(sessionId);
    const timeline = await sqliteSession.getTimeline();
    const messages = timeline
      .map((entry) => timelineEntryToChatMessage(entry, sessionId))
      .filter((entry): entry is ChatMessage => !!entry);

    if (dbSession) {
      const savedTimeline = db.getTimeline(sessionId);
      /* contextUsed 是"当前上下文窗口用量", totalTokens 是会话累计/消息估算值。
       * 压缩后 contextUsed 会下降, 不能再用 totalTokens 高水位把它抬回去。 */
      const effectiveContextUsed = dbSession.contextUsed || dbSession.latestRequestUsage?.totalTokens || dbSession.totalTokens || 0;
      return {
        id: sessionId,
        name: dbSession.name,
        modelId: dbSession.modelId,
        agentMode: dbSession.agentMode ?? null,
        workspacePath: dbSession.workspacePath,
        messages,
        createdAt: dbSession.createdAt,
        updatedAt: dbSession.updatedAt,
        totalTokens: dbSession.totalTokens,
        contextUsed: effectiveContextUsed,
        contextWindow: dbSession.contextWindow,
        timeline: savedTimeline.length > 0 ? savedTimeline : undefined,
        contextBreakdown: dbSession.contextBreakdown,
        latestRequestUsage: dbSession.latestRequestUsage,
        sessionUsage: dbSession.sessionUsage ?? null,
        fileRollbackCheckpointId: dbSession.fileRollbackCheckpointId,
        fileReapplyCheckpointId: dbSession.fileReapplyCheckpointId,
        fileRevertedMap: dbSession.fileRevertedMap ?? {},
        fileConfirmedMap: dbSession.fileConfirmedMap ?? {},
        parentSessionId: (dbSession as any).parentSessionId ?? null,
        kind: (dbSession as any).kind === 'image' ? 'image' : 'chat',
      };
    }

    // 没有 DB 记录，从消息估算
    const totalTokens = estimateTokensFromMessages(messages);
    return {
      id: sessionId,
      name: `Session ${sessionId}`,
      modelId: 'unknown',
      workspacePath: '',
      messages,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      totalTokens,
      contextUsed: totalTokens,
      latestRequestUsage: null,
      fileRollbackCheckpointId: null,
      fileReapplyCheckpointId: null,
      fileRevertedMap: {},
      fileConfirmedMap: {},
    };
  }

  // ==================== CRUD ====================

  async loadSession(sessionId: string): Promise<UISession | null> {
    const db = getDatabase();
    const dbSession = db.getSession(sessionId);
    if (!dbSession) return null;
    return await this.buildSession(sessionId);
  }

  async listSessions(workspacePath?: string): Promise<UISession[]> {
    const db = getDatabase();
    const dbSessions = db.listSessions(workspacePath);

    const sessions: UISession[] = [];
    for (const dbSession of dbSessions) {
      try {
        const session = await this.buildSession(dbSession.id);
        sessions.push(session);
      } catch {
        // 跳过损坏的 session
      }
    }
    return sessions;
  }

  async listSessionsLite(workspacePath?: string): Promise<UISession[]> {
    const rows = await this.listSessionsSlim(workspacePath);
    for (const r of rows) {
      const any = r as any;
      any.contextBreakdown = undefined;
      any.latestRequestUsage = undefined;
      any.sessionUsage = null;
    }
    return rows;
  }

  async listSessionsSlim(workspacePath?: string): Promise<UISession[]> {
    const db = getDatabase();
    const dbSessions = db.listSessions(workspacePath);
    const stats = new Map(db.getSessionMessageStats().map((s) => [s.sessionId, s]));

    const sessions: UISession[] = [];
    for (const dbSession of dbSessions) {
      try {
        const stat = stats.get(dbSession.id);
        let firstMessagePreview: string | undefined;
        if (stat?.firstItemData) {
          try {
            const data = JSON.parse(stat.firstItemData) as Message;
            const text = toMessageContentText(data.content);
            if (text) firstMessagePreview = text.slice(0, 200);
          } catch { /* 坏行 → 无预览 */ }
        }
        const effectiveContextUsed = dbSession.contextUsed || dbSession.latestRequestUsage?.totalTokens || dbSession.totalTokens || 0;
        sessions.push({
          id: dbSession.id,
          name: dbSession.name,
          modelId: dbSession.modelId,
          agentMode: dbSession.agentMode ?? null,
          workspacePath: dbSession.workspacePath,
          messages: [],
          messageCount: stat?.count ?? 0,
          firstMessagePreview,
          createdAt: dbSession.createdAt,
          updatedAt: dbSession.updatedAt,
          totalTokens: dbSession.totalTokens,
          contextUsed: effectiveContextUsed,
          contextWindow: dbSession.contextWindow,
          timeline: undefined,
          contextBreakdown: dbSession.contextBreakdown,
          latestRequestUsage: dbSession.latestRequestUsage,
          sessionUsage: dbSession.sessionUsage ?? null,
          fileRollbackCheckpointId: dbSession.fileRollbackCheckpointId,
          fileReapplyCheckpointId: dbSession.fileReapplyCheckpointId,
          fileRevertedMap: dbSession.fileRevertedMap ?? {},
          fileConfirmedMap: dbSession.fileConfirmedMap ?? {},
          parentSessionId: (dbSession as any).parentSessionId ?? null,
          kind: (dbSession as any).kind === 'image' ? 'image' : 'chat',
        } as UISession);
      } catch {
        // 跳过损坏的 session
      }
    }
    return sessions;
  }

  rememberSubAgentParent(childSessionId: string, parentSessionId: string, workspacePath?: string): void {
    if (!childSessionId || !parentSessionId) return;
    subAgentParentHints.set(childSessionId, { parentSessionId, workspacePath: workspacePath || '' });
    /* 只是给占位行兜底用的短命提示, 不是状态源 —— 留太多没意义, 超了就丢最早的。 */
    if (subAgentParentHints.size > SUB_AGENT_HINT_MAX) {
      const oldest = subAgentParentHints.keys().next().value;
      if (oldest) subAgentParentHints.delete(oldest);
    }
  }

  async createSession(options: {
    sessionId: string;
    workspacePath: string;
    modelId: string;
    name?: string;
    /** sub-agent session 用 — 指向发起它的主 session, sidebar 据此嵌套渲染 */
    parentSessionId?: string | null;
    /** sub-agent session 用 — 跑 agent 的 user message 内容. 给空时会建空会话 */
    initialUserMessage?: string;
    kind?: 'chat' | 'image';
    /** 显式模式 (mobile-bridge 透传). 缺省走 defaultAgentMode. 手机端老版本可能还发 'assistant', 归一成 work. */
    agentMode?: string;
  }): Promise<UISession> {
    const now = Date.now();
    const db = getDatabase();

    const name = options.name ?? `New Chat - ${new Date(now).toLocaleTimeString()}`;

    let agentMode: 'work' | 'code' | null = options.agentMode ? normalizeAgentMode(options.agentMode) : null;
    if (!agentMode && !options.parentSessionId) {
      try {
        agentMode = normalizeAgentMode((loadConfig() as { defaultAgentMode?: string }).defaultAgentMode);
      } catch { agentMode = 'code'; }
    }

    // 写入 SQLite sessions 表
    db.upsertSession({
      id: options.sessionId,
      name,
      modelId: options.modelId ?? '',
      workspacePath: options.workspacePath,
      createdAt: now,
      updatedAt: now,
      totalTokens: 0,
      contextUsed: 0,
      fileRollbackCheckpointId: null,
      fileReapplyCheckpointId: null,
      fileRevertedMap: {},
      fileConfirmedMap: {},
      parentSessionId: options.parentSessionId ?? null,
      kind: options.kind ?? 'chat',
    });
    if (agentMode) db.setSessionAgentMode(options.sessionId, agentMode);

    // 创建 SQLiteSession（会自动写 meta entry）
    await this.sessionManager.createSession({
      sessionId: options.sessionId,
      model: options.modelId,
      agentName: 'Neox UI',
    });

    /* sub-agent session 的发起 prompt — 双写:
     *   1. SQLiteSession messages 表 (给 LLM 复用 / API 兼容)
     *   2. timeline_entries 表 — AgentTimelineView 只读这张表, 不写 timeline 用户点开看不到任何内容.
     *  sub-agent 完成时 appendSubAgentResult 会再补一条 assistant timeline entry. */
    if (options.initialUserMessage) {
      try {
        const sqliteSession = new SQLiteSession(options.sessionId);
        await sqliteSession.addItems([{
          type: 'message',
          data: { role: 'user', content: options.initialUserMessage },
        } as any]);
        const now = Date.now();
        db.setTimeline(options.sessionId, [{
          id: `sub-prompt-${options.sessionId}`,
          type: 'user_message',
          title: 'User',
          detail: options.initialUserMessage,
          timestamp: now,
          sequence: 0,
        }]);
      } catch (err) {
        // 不阻塞主流程
        // eslint-disable-next-line no-console
        console.warn(`[sessionStore] failed to seed sub-agent prompt for ${options.sessionId}:`, err);
      }
    }

    return {
      id: options.sessionId,
      name,
      modelId: options.modelId,
      agentMode,
      workspacePath: options.workspacePath,
      messages: [],
      createdAt: now,
      updatedAt: now,
      totalTokens: 0,
      contextUsed: 0,
      fileRollbackCheckpointId: null,
      fileReapplyCheckpointId: null,
      fileRevertedMap: {},
      fileConfirmedMap: {},
      parentSessionId: options.parentSessionId ?? null,
      kind: options.kind ?? 'chat',
    };
  }

  async appendSubAgentTimelineEntry(sessionId: string, entry: {
    type: string;
    title: string;
    detail?: string;
    timestamp?: number;
    [key: string]: any;
  },
  existing?: { id: string; sequence: number }): Promise<{ id: string; sequence: number } | null> {
    const SUB_TIMELINE_CAP = Math.max(50, Number(process.env.NEOX_SUB_AGENT_TIMELINE_CAP) || 500);
    try {
      const db = getDatabase();
      this.ensureSubAgentSessionRow(db, sessionId);
      const slot = existing ?? (() => {
        const count = db.countTimeline(sessionId);
        return count >= SUB_TIMELINE_CAP
          ? null
          : { id: `sub-step-${sessionId}-${count}`, sequence: count };
      })();
      if (!slot) return null;
      db.upsertTimelineEntries(sessionId, [{
        ...entry,
        id: slot.id,
        timestamp: entry.timestamp ?? Date.now(),
        sequence: slot.sequence,
      }]);
      return slot;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[sessionStore] failed to append sub-agent timeline entry for ${sessionId}:`, err);
      return null;
    }
  }

  private ensureSubAgentSessionRow(db: ReturnType<typeof getDatabase>, sessionId: string): void {
    if (db.getSession(sessionId)) return;
    const hint = subAgentParentHints.get(sessionId);
    db.upsertSession({
      id: sessionId,
      name: `子 Agent ${sessionId.slice(0, 8)}`,
      ...(hint?.parentSessionId ? { parentSessionId: hint.parentSessionId } : {}),
      modelId: '',
      workspacePath: hint?.workspacePath || '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      totalTokens: 0,
      contextUsed: 0,
      contextWindow: 0,
    } as any);
  }

  /** sub-agent 结束 — 双写 message + timeline_entry. messages 表给 LLM, timeline 给 UI. */
  async appendSubAgentResult(sessionId: string, content: string): Promise<void> {
    try {
      this.ensureSubAgentSessionRow(getDatabase(), sessionId);
      const sqliteSession = new SQLiteSession(sessionId);
      await sqliteSession.addItems([{
        type: 'message',
        data: { role: 'assistant', content },
      } as any]);
      const db = getDatabase();
      const nextSeq = db.countTimeline(sessionId);
      db.upsertTimelineEntries(sessionId, [{
        id: `sub-result-${sessionId}-${Date.now()}`,
        type: 'assistant_message',
        title: 'Agent',
        /* 同 createSession 的 user_message: mapper 取 detail, content 字段会被忽略 */
        detail: content,
        timestamp: Date.now(),
        sequence: nextSeq,
      }]);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[sessionStore] failed to append sub-agent result for ${sessionId}:`, err);
    }
  }

  async saveSessionMetadata(session: UISession): Promise<void> {
    const db = getDatabase();
    db.upsertSession({
      id: session.id,
      name: session.name,
      modelId: session.modelId,
      workspacePath: session.workspacePath,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      totalTokens: session.totalTokens,
        contextUsed: session.contextUsed,
        contextWindow: session.contextWindow,
        fileRollbackCheckpointId: session.fileRollbackCheckpointId,
        fileReapplyCheckpointId: session.fileReapplyCheckpointId,
        fileRevertedMap: session.fileRevertedMap ?? {},
        fileConfirmedMap: session.fileConfirmedMap ?? {},
        contextBreakdown: session.contextBreakdown ?? null,
        latestRequestUsage: session.latestRequestUsage ?? null,
      });

    if (session.timeline) {
      db.setTimeline(session.id, session.timeline);
    }
  }

  async updateSessionMetadata(sessionId: string, updates: Record<string, any>): Promise<any> {
    const db = getDatabase();
    let existing = db.getSession(sessionId);

    if (!existing) {
      existing = {
        id: sessionId,
        name: `Session ${sessionId}`,
        modelId: 'unknown',
        workspacePath: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        totalTokens: 0,
        contextUsed: 0,
        fileRollbackCheckpointId: null,
        fileReapplyCheckpointId: null,
        fileRevertedMap: {},
        fileConfirmedMap: {},
      };
    }

    const next = { ...existing, ...updates, updatedAt: updates.updatedAt ?? Date.now() };
    db.upsertSession(next);

    if ('timeline' in updates) {
      if (updates.timeline) {
        db.setTimeline(sessionId, updates.timeline);
      } else {
        db.clearTimeline(sessionId);
      }
    }

    return next;
  }

  async deleteSession(sessionId: string): Promise<void> {
    // CASCADE 自动清理 messages + timeline_entries
    getDatabase().deleteSession(sessionId);
    // P1.2b: 应用层清 target_missions 行 — V7 去掉了外键 CASCADE, 需要手动 DELETE.
    //   走 dynamic import 避免 core → platform → tools 反向依赖 (targetModeTools 已引 platform/database).
    try {
      const mod = await import('../tools/targetModeTools.js');
      mod.deleteTargetForSession(sessionId);
    } catch { /* target 未装载不影响 session 删除主流程 */ }
    /* 标题聚合账本在 app_state 里, 不吃 sessions 的 CASCADE —— 不清就是永久垃圾 */
    try {
      const titleStore = await import('./sessionTitleStore.js');
      await titleStore.clearSessionTitleMeta(sessionId);
    } catch { /* 清账失败不影响删会话 */ }
    // 清理 session manager 缓存
    await this.sessionManager.deleteSession(sessionId);
  }

  async ensureMessagePair(sessionId: string, messages: ChatMessage[]): Promise<void> {
    if (messages.length === 0) return;
    const sqliteSession = new SQLiteSession(sessionId);
    const timeline = await sqliteSession.getTimeline();
    const messageEntries = timeline.filter((entry) => entry.item.type === 'message');
    const lastEntries = messageEntries.slice(-messages.length);
    const matches = lastEntries.length === messages.length && lastEntries.every((entry, index) => {
      const data = entry.item.type === 'message' ? (entry.item.data as Message) : null;
      if (!data) return false;
      const text = toMessageContentText(data.content);
      return data.role === messages[index].role && text === (messages[index].text || '');
    });
    if (matches) return;

    const items = messages.map((msg) => messageToSessionItem(chatMessageToMessage(msg)));
    await sqliteSession.addItems(items);
  }

  async setTimeline(sessionId: string, timeline: SavedTimelineEntry[]): Promise<void> {
    getDatabase().setTimeline(sessionId, timeline);
  }

  async clearTimeline(sessionId: string): Promise<void> {
    getDatabase().clearTimeline(sessionId);
  }
}

export const sessionStore = new SessionStore();
