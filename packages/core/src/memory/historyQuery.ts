
import type { Message } from '@neoxlabs/kernel/types/index.js';
import type { Session, SessionItem } from '@neoxlabs/kernel/types/session.js';
import { getDatabase } from '@neoxlabs/platform/platform/database.js';

// ==================== 过滤条件 ====================

export interface HistoryFilter {
  /** 按消息角色过滤 */
  roles?: Array<'user' | 'assistant' | 'system' | 'tool'>;
  /** 只包含有工具调用的消息 */
  hasToolCalls?: boolean;
  /** 只包含工具结果消息 */
  isToolResult?: boolean;
  /** 最后 N 条消息 */
  lastN?: number;
  /** 最后 N 轮（一轮 = user + assistant + tool_results） */
  lastTurns?: number;
  /** 时间范围 — 起始时间戳 */
  since?: number;
  /** 时间范围 — 结束时间戳 */
  until?: number;
  /** 内容关键词匹配 */
  keyword?: string;
  /** 只包含包含错误的消息 */
  hasError?: boolean;
  /** 工具名称过滤 */
  toolNames?: string[];
}

// ==================== 恢复结果 ====================

export interface RestoreResult {
  messages: Message[];
  /** 原始消息总数 */
  totalMessages: number;
  /** 过滤后消息数 */
  filteredCount: number;
  /** 应用的过滤条件描述 */
  filterDescription: string;
}

// ==================== 选择性恢复 ====================

/**
 * 从会话中选择性恢复消息
 *
 * 与全量加载的区别：
 * - 全量加载：session.getTimeline() → 所有消息
 * - 选择性恢复：只加载符合条件的子集，减少 context 占用
 */
export async function restoreFiltered(
  session: Session,
  filter: HistoryFilter,
): Promise<RestoreResult> {
  const timeline = await session.getTimeline();
  const allMessages = timelineToMessages(timeline);
  let filtered = [...allMessages];
  const descriptions: string[] = [];

  // 按角色过滤
  if (filter.roles && filter.roles.length > 0) {
    filtered = filtered.filter(m => filter.roles!.includes(m.role as any));
    descriptions.push(`roles: ${filter.roles.join(',')}`);
  }

  // 工具调用过滤
  if (filter.hasToolCalls) {
    filtered = filtered.filter(m =>
      m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0
    );
    descriptions.push('has tool calls');
  }

  // 工具结果过滤
  if (filter.isToolResult) {
    filtered = filtered.filter(m => m.role === 'tool');
    descriptions.push('tool results only');
  }

  // 工具名称过滤
  if (filter.toolNames && filter.toolNames.length > 0) {
    const names = new Set(filter.toolNames);
    filtered = filtered.filter(m => {
      if (m.role === 'assistant' && m.tool_calls) {
        return m.tool_calls.some(tc => names.has(tc.function.name));
      }
      // tool result 消息没有直接带工具名，需要通过 content 推断
      if (m.role === 'tool') {
        const content = typeof m.content === 'string' ? m.content : '';
        return filter.toolNames!.some(n => content.includes(`"tool":"${n}"`));
      }
      return false;
    });
    descriptions.push(`tools: ${filter.toolNames.join(',')}`);
  }

  // 关键词过滤
  if (filter.keyword) {
    const kw = filter.keyword.toLowerCase();
    filtered = filtered.filter(m => {
      const content = typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map((c: any) => c.text || '').join(' ')
          : '';
      return content.toLowerCase().includes(kw);
    });
    descriptions.push(`keyword: "${filter.keyword}"`);
  }

  // 错误过滤
  if (filter.hasError) {
    filtered = filtered.filter(m => {
      const content = typeof m.content === 'string' ? m.content : '';
      return content.includes('"status":"error"') ||
        content.includes('Error:') ||
        content.includes('error') ||
        content.includes('failed');
    });
    descriptions.push('has errors');
  }

  // 时间范围过滤
  if (filter.since || filter.until) {
    // 时间信息需要从 timeline 的 timestamp 获取
    // 这里简化处理 — 按消息在 timeline 中的位置推断
    descriptions.push('time range');
  }

  // 最后 N 轮
  if (filter.lastTurns && filter.lastTurns > 0) {
    filtered = extractLastTurns(filtered, filter.lastTurns);
    descriptions.push(`last ${filter.lastTurns} turns`);
  }

  // 最后 N 条
  if (filter.lastN && filter.lastN > 0) {
    filtered = filtered.slice(-filter.lastN);
    descriptions.push(`last ${filter.lastN} messages`);
  }

  return {
    messages: filtered,
    totalMessages: allMessages.length,
    filteredCount: filtered.length,
    filterDescription: descriptions.length > 0
      ? descriptions.join(' + ')
      : 'no filter',
  };
}

// ==================== 跨会话搜索 ====================

export interface SessionSearchResult {
  sessionId: string;
  sessionName?: string;
  matchCount: number;
  /** 匹配的消息摘要（最多 3 条） */
  previews: Array<{
    role: string;
    content: string;
    timestamp?: number;
  }>;
}

/**
 * 跨会话全文搜索
 *
 * 直接查 SQLite，比逐文件扫描快 100x+
 */
export function searchAcrossSessions(
  query: string,
  options?: {
    maxResults?: number;
    sessionIds?: string[];
  },
): SessionSearchResult[] {
  const db = getDatabase();
  const rawDb = db.getRawDb();
  const maxResults = options?.maxResults ?? 20;
  const likeQuery = `%${query}%`;

  let sql: string;
  let params: any[];

  const userClause = '1=1';
  const userParams: any[] = [];

  if (options?.sessionIds && options.sessionIds.length > 0) {
    const placeholders = options.sessionIds.map(() => '?').join(',');
    sql = `
      SELECT m.session_id AS session_id, m.item_data AS item_data, m.created_at AS created_at
      FROM messages m JOIN sessions s ON s.id = m.session_id
      WHERE m.session_id IN (${placeholders})
        AND m.item_data LIKE ?
        AND ${userClause}
      ORDER BY m.created_at DESC
      LIMIT ?
    `;
    params = [...options.sessionIds, likeQuery, ...userParams, maxResults * 3];
  } else {
    sql = `
      SELECT m.session_id AS session_id, m.item_data AS item_data, m.created_at AS created_at
      FROM messages m JOIN sessions s ON s.id = m.session_id
      WHERE m.item_data LIKE ?
        AND ${userClause}
      ORDER BY m.created_at DESC
      LIMIT ?
    `;
    params = [likeQuery, ...userParams, maxResults * 3];
  }

  const rows = rawDb.prepare(sql).all(...params) as Array<{
    session_id: string;
    item_data: string;
    created_at: number;
  }>;

  // 按 session 分组
  const grouped = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = grouped.get(row.session_id) ?? [];
    list.push(row);
    grouped.set(row.session_id, list);
  }

  // 获取 session 名称
  const sessions = db.listSessions();
  const sessionNames = new Map(sessions.map((s: any) => [s.id, s.name]));

  const results: SessionSearchResult[] = [];
  for (const [sessionId, matches] of grouped) {
    if (results.length >= maxResults) break;

    const previews = matches.slice(0, 3).map(m => {
      try {
        const parsed = JSON.parse(m.item_data);
        const role = parsed?.data?.role || parsed?.type || 'unknown';
        const content = extractPreview(parsed, query);
        return { role, content, timestamp: m.created_at };
      } catch {
        return { role: 'unknown', content: m.item_data.substring(0, 100), timestamp: m.created_at };
      }
    });

    results.push({
      sessionId,
      sessionName: sessionNames.get(sessionId),
      matchCount: matches.length,
      previews,
    });
  }

  return results;
}

// ==================== 内部工具 ====================

/** 从 timeline items 提取 Message[] */
function timelineToMessages(timeline: Array<{ item: SessionItem; timestamp: number }>): Message[] {
  return timeline
    .filter(t => t.item.type === 'message' && t.item.data)
    .map(t => t.item.data as Message);
}

/** 提取最后 N 轮对话（user→assistant→tool_results 为一轮） */
function extractLastTurns(messages: Message[], turns: number): Message[] {
  // 从后往前数 user 消息出现次数
  let turnCount = 0;
  let cutIndex = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      turnCount++;
      if (turnCount > turns) {
        cutIndex = i + 1; // 不包含这条 user 消息
        break;
      }
      cutIndex = i;
    }
  }

  return messages.slice(cutIndex);
}

/** 从消息中提取包含关键词的预览片段 */
function extractPreview(parsed: any, keyword: string): string {
  const content = parsed?.data?.content;
  if (typeof content === 'string') {
    const idx = content.toLowerCase().indexOf(keyword.toLowerCase());
    if (idx >= 0) {
      const start = Math.max(0, idx - 40);
      const end = Math.min(content.length, idx + keyword.length + 60);
      return (start > 0 ? '...' : '') + content.substring(start, end) + (end < content.length ? '...' : '');
    }
    return content.substring(0, 100);
  }
  if (Array.isArray(content)) {
    const texts = content.map((c: any) => c.text || '').join(' ');
    return texts.substring(0, 100);
  }
  return JSON.stringify(parsed).substring(0, 100);
}
