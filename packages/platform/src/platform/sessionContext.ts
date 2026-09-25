
import { getDatabase, NeoxDatabase } from './database.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { onUserIdChange } from '../utils/config.js';

export interface PersistedMessage {
  seq: number;
  role: 'user' | 'assistant' | 'system' | 'tool';
  /** 显示用的纯文字摘要; 复杂结构 (tool_calls / 数组 content) 走 raw 还原 */
  content: string;
  turnId: string;
  timestamp: number;
  /** 原始 Message JSON, 优先用它还原 memory; 缺失则 fallback 到 {role, content} */
  raw?: any;
}

/** appendMessage 触发的事件 — Mobile Bridge / 其他订阅者订这个推 WS / IPC. */
export interface SessionAppendEvent {
  sessionId: string;
  seq: number;
  role: PersistedMessage['role'];
  content: string;
  turnId: string;
  timestamp: number;
  /** 原始 Message JSON, 含 tool_calls / 多模态 content 等完整信息 */
  raw?: any;
}

export type SessionAppendListener = (event: SessionAppendEvent) => void;

/** 压缩快照行的 item_type.
 *
 *  不叫 'compacted' —— 那个值被 SessionItem 联合类型的 CompactedItem 占着 (SQLiteSession 走同一张表).
 *  一条快照 = 写入那一刻 LLM 上下文的完整副本; 原始 'message' 行一行不删.
 *  见 内部设计文档. */
export const COMPACTION_SNAPSHOT_ITEM_TYPE = 'compaction_snapshot';

/** compaction_snapshot 行的 item_data 形状. */
interface CompactionSnapshotData {
  v: 1;
  messages: Array<{
    role: PersistedMessage['role'];
    content: string;
    turnId: string;
    timestamp: number;
    raw?: any;
  }>;
  compactedAt: number;
  /** 压缩前的消息条数 — 仅供观测/审计, 不参与还原. */
  sourceCount: number;
}

export function messageDedupFingerprint(role: string, content: string, raw: any): string {
  const normalize = (s: string): string => s.replace(/\s+/g, '');
  if (role === 'tool') {
    const callId = raw?.tool_call_id;
    if (typeof callId === 'string' && callId) return `tool:${callId}`;
    return `tool:${normalize(content).slice(0, 200)}`;
  }
  if (role === 'assistant') {
    const calls = raw?.tool_calls;
    if (Array.isArray(calls) && calls.length > 0) {
      const ids = calls.map((c: any) => c?.id ?? '').join(',');
      return `calls:${ids}`;
    }
    const thinking = raw?.thinking ?? raw?.reasoning;
    if (typeof thinking === 'string' && thinking) {
      return `think:${normalize(thinking).slice(0, 200)}`;
    }
  }
  return `${role}:${normalize(content).slice(0, 200)}`;
}

/** 两条消息的 turnId 是否兼容 — 任一为空即兼容 (flushPersist 不带 turnId). */
export function turnIdsCompatible(a: string, b: string): boolean {
  if (!a || !b) return true;
  return a === b;
}

export class SessionContext {
  private static cache = new Map<string, SessionContext>();
  /** 内存里同时缓存多少个 session 的 context. 超出按最久未使用淘汰. */
  private static MAX_CACHED_SESSIONS = 8;
  /** 内存里保留多少条最近 message (防长 session 爆内存). 超过的从尾部丢弃但库不删. */
  private static MAX_CACHE = 500;
  /** 全局 append 事件订阅 — Mobile Bridge / 其他 process 内观察者用.
   *  注意: listener 必须 cheap + 异常安全 (一个 listener 抛不影响其他). */
  private static appendListeners = new Set<SessionAppendListener>();

  /** 订阅 appendMessage 事件 — 返 unsubscribe 函数 */
  static onAppend(listener: SessionAppendListener): () => void {
    SessionContext.appendListeners.add(listener);
    return () => SessionContext.appendListeners.delete(listener);
  }

  private items: PersistedMessage[] = [];
  private db: NeoxDatabase | null = null;
  private maxSeqHint = -1;

  /** 唯一构造入口. 同 sessionId 复用单例, 跨 runtime 共享 state. */
  static get(sessionId: string): SessionContext {
    if (!sessionId) {
      /* 空 sessionId: 返一次性纯内存 ctx, 不进 singleton 缓存,
       * 防止测试 / 异常路径污染共享池. */
      return new SessionContext('');
    }
    const cached = SessionContext.cache.get(sessionId);
    if (cached) {
      /* 命中也要挪到队尾 —— Map 按插入序迭代, delete+set 就是"标记为最近使用"。
       * 不挪的话最先创建的那个会先被淘汰, 哪怕它正是当前会话。 */
      SessionContext.cache.delete(sessionId);
      SessionContext.cache.set(sessionId, cached);
      return cached;
    }
    const ctx = new SessionContext(sessionId);
    SessionContext.cache.set(sessionId, ctx);
    /* 先放进去再淘汰, 保证刚要用的这个一定留得住 (哪怕上限是 1) */
    while (SessionContext.cache.size > SessionContext.MAX_CACHED_SESSIONS) {
      const oldest = SessionContext.cache.keys().next().value as string | undefined;
      if (oldest === undefined || oldest === sessionId) break;
      SessionContext.cache.delete(oldest);
    }
    return ctx;
  }

  /** 当前缓存了几个 session 的 context —— 给测试和内存排查用。 */
  static cachedSessionCount(): number {
    return SessionContext.cache.size;
  }

  /** 测试 / session 删除时调, 释放单例引用. 不传 sessionId 清整池. */
  static reset(sessionId?: string): void {
    if (sessionId) SessionContext.cache.delete(sessionId);
    else SessionContext.cache.clear();
  }

  private constructor(public readonly sessionId: string) {
    if (!sessionId) {
      /* 纯内存 ctx, 跳过 DB 初始化 */
      return;
    }
    try {
      this.db = getDatabase();
      this.load();
    } catch (err: any) {
      console.warn(`[SessionContext] init failed for ${sessionId}: ${err?.message}`);
      this.db = null;
    }
  }

  /** 读该 session 里 seq 最大的 compaction_snapshot 行.
   *  无快照 / 行损坏 → null (调用方退化成全量 message 读取, 不抛). */
  private static readLatestSnapshot(
    rawDb: any,
    sessionId: string,
  ): { seq: number; messages: PersistedMessage[] } | null {
    try {
      const row = rawDb.prepare(
        `SELECT seq, item_data FROM messages
          WHERE session_id = ? AND item_type = ?
          ORDER BY seq DESC LIMIT 1`
      ).get(sessionId, COMPACTION_SNAPSHOT_ITEM_TYPE) as
        { seq: number; item_data: string } | undefined;
      if (!row) return null;
      const data = JSON.parse(row.item_data) as CompactionSnapshotData;
      if (!data || !Array.isArray(data.messages)) {
        cliLogger.warn('SESSION_CTX', `snapshot seq=${row.seq} malformed for ${sessionId} — 退回全量历史`);
        return null;
      }
      const messages: PersistedMessage[] = [];
      for (const m of data.messages) {
        const role = m?.role;
        if (role !== 'user' && role !== 'assistant' && role !== 'system' && role !== 'tool') continue;
        messages.push({
          /* 快照内的消息不占独立行, seq 借快照行的 — 只用于排序/展示, 不参与 seq 分配. */
          seq: row.seq,
          role,
          content: typeof m.content === 'string' ? m.content : '',
          turnId: typeof m.turnId === 'string' ? m.turnId : '',
          timestamp: typeof m.timestamp === 'number' ? m.timestamp : data.compactedAt,
          raw: m.raw,
        });
      }
      return { seq: row.seq, messages };
    } catch (err: any) {
      cliLogger.warn('SESSION_CTX', `readLatestSnapshot failed for ${sessionId}: ${err?.message} — 退回全量历史`);
      return null;
    }
  }

  /** 一条 message 行 → PersistedMessage. 坏行返 null (调用方跳过). */
  private static rowToMessage(
    row: { seq: number; item_data: string; timestamp: number },
  ): PersistedMessage | null {
    try {
      const data = JSON.parse(row.item_data);
      const role = data?.role;
      if (role !== 'user' && role !== 'assistant' && role !== 'system' && role !== 'tool') return null;
      /* content 可能是 string / array / object — 统一存 string 摘要给观察用,
       * raw 存原始结构供 LLM 还原 (tool_calls / 多模态 image_url 等不能降维). */
      const content = typeof data?.content === 'string'
        ? data.content
        : (data?.content == null ? '' : JSON.stringify(data.content));
      return {
        seq: row.seq,
        role,
        content,
        turnId: typeof data?.turnId === 'string' ? data.turnId : '',
        timestamp: row.timestamp,
        raw: data,
      };
    } catch {
      return null; /* 坏 JSON 行 */
    }
  }

  /** 启动时一次性还原 LLM 投影.
   *
   *  投影 = 最新 compaction_snapshot + 该快照之后追加的 message 行.
   *  快照写入的那一刻它就是当时上下文的全部, 所以"快照里的"与"快照之后的"天然不重叠 —
   *  不需要区间对齐 / 指纹匹配 / 知道 kernel 压掉了哪几条.
   *  无快照 (存量库 / 从未压缩) → 退化成读全部 message 行, 与旧行为逐字节一致.
   *  见 内部设计文档. */
  private load(): void {
    if (!this.db) return;
    try {
      const rawDb = this.db.getRawDb();
      const snapshot = SessionContext.readLatestSnapshot(rawDb, this.sessionId);

      let restored: PersistedMessage[];
      if (snapshot) {
        /* 快照之后的增量 — 升序直读, 数量天然有界 (下次压缩会再落一个快照). */
        const tailRows = rawDb.prepare(
          `SELECT seq, item_data, timestamp FROM messages
            WHERE session_id = ? AND item_type = 'message' AND seq > ?
            ORDER BY seq ASC`
        ).all(this.sessionId, snapshot.seq) as Array<{
          seq: number; item_data: string; timestamp: number;
        }>;
        restored = [...snapshot.messages];
        for (const r of tailRows) {
          const m = SessionContext.rowToMessage(r);
          if (m) restored.push(m);
        }
        /* 快照本身可能就超 MAX_CACHE (压缩保护区 + 摘要), 统一在尾部截断. */
        if (restored.length > SessionContext.MAX_CACHE) {
          restored = restored.slice(-SessionContext.MAX_CACHE);
        }
      } else {
        /* DESC + LIMIT 取最近 N 条, 然后 reverse 恢复正序 — 老 session 几百条全读浪费. */
        const rows = rawDb.prepare(
          `SELECT seq, item_data, timestamp FROM messages
            WHERE session_id = ? AND item_type = 'message'
            ORDER BY seq DESC LIMIT ?`
        ).all(this.sessionId, SessionContext.MAX_CACHE) as Array<{
          seq: number; item_data: string; timestamp: number;
        }>;
        restored = [];
        for (const r of rows.reverse()) {
          const m = SessionContext.rowToMessage(r);
          if (m) restored.push(m);
        }
      }
      this.items = restored;
      /* maxSeqHint 取数据库 MAX(seq) 不限 item_type — 跟其它 writer (checkpoint / tool_call)
       * 共享 seq 池, 我们的 INSERT 续在它们之后 */
      const maxRow = this.db.getRawDb().prepare(
        'SELECT MAX(seq) AS m FROM messages WHERE session_id = ?'
      ).get(this.sessionId) as { m: number | null };
      this.maxSeqHint = maxRow.m ?? -1;
    } catch (err: any) {
      console.warn(`[SessionContext] load failed for ${this.sessionId}: ${err?.message}`);
    }
  }

  /** 追加 message — 原子事务分配 seq + INSERT messages, 同步内存 cache.
   *  返回真实落库的 seq, db 不可用 / 失败时返 -1 (内存仍 push 保证当前 turn LLM 看得到).
   *  raw 是原始 Message 对象 (含 tool_calls / tool_call_id / 数组 content),
   *  落库整对象, 重启后能完整还原 LLM 上下文. */
  appendMessage(
    role: PersistedMessage['role'],
    content: string,
    turnId: string,
    timestamp: number,
    raw?: any,
  ): number {
    let actualSeq = -1;
    /* 序列化时就把 role/content/turnId 嵌进 raw, 这样回读时 raw 自带全部字段, 不需要再合并. */
    const stored = {
      ...(raw && typeof raw === 'object' ? raw : {}),
      role,
      content: raw?.content ?? content,
      turnId,
    };
    if (this.db) {
      try {
        const rawDb = this.db.getRawDb();
        const fp = messageDedupFingerprint(role, content, stored);
        /* 指纹除 role 前缀外为空 (空 content 且无 tool/thinking 特征) → 不去重,
         * 防止两条无特征空消息误合并. */
        const fpHasBody = fp.length > fp.indexOf(':') + 1;
        let dedupHit = false;
        actualSeq = rawDb.transaction(() => {
          if (fpHasBody) {
            /* 窗口 30: flushPersist 是 debounce 批量补写, 与 forwarder 原行之间
             * 可能隔着同轮的多条 tool/thinking 行, 5 条窗口会漏. */
            const recent = rawDb.prepare(
              `SELECT seq, item_data, timestamp FROM messages
               WHERE session_id = ?
               ORDER BY seq DESC
               LIMIT 30`
            ).all(this.sessionId) as Array<{ seq: number; item_data: string; timestamp: number }>;
            for (const r of recent) {
              try {
                /* 双写间隔是秒级 (forwarder 即时 vs flushPersist debounce);
                 * 超 30s 的旧行不参与去重 — 防跨轮同文误合并 (CLI turnId 全空场景). */
                if (Math.abs(timestamp - r.timestamp) > 30_000) continue;
                const j = JSON.parse(r.item_data);
                if (j?.role !== role) continue;
                if (!turnIdsCompatible((j?.turnId ?? '') as string, turnId)) continue;
                const existingContent = typeof j?.content === 'string'
                  ? j.content
                  : (j?.content == null ? '' : JSON.stringify(j.content));
                if (messageDedupFingerprint(j.role, existingContent, j) === fp) {
                  /* 同条逻辑消息 — skip insert, 返已有 seq */
                  dedupHit = true;
                  return r.seq;
                }
              } catch { /* item_data 不是 JSON, 跳过 */ }
            }
          }
          const maxRow = rawDb.prepare(
            'SELECT MAX(seq) AS m FROM messages WHERE session_id = ?'
          ).get(this.sessionId) as { m: number | null };
          const nextSeq = (maxRow.m ?? -1) + 1;
          rawDb.prepare(
            'INSERT INTO messages (session_id, seq, item_type, item_data, timestamp) VALUES (?, ?, ?, ?, ?)'
          ).run(this.sessionId, nextSeq, 'message', JSON.stringify(stored), timestamp);
          return nextSeq;
        })();
        if (dedupHit) {
          cliLogger.debug('SESSION_CTX', `dedup hit ${role} seq=${actualSeq} session=${this.sessionId} — skip re-append/emit`);
          return actualSeq;
        }
        cliLogger.debug('SESSION_CTX', `appended ${role} seq=${actualSeq} session=${this.sessionId} contentLen=${content.length}`);
      } catch (err: any) {
        cliLogger.warn('SESSION_CTX', `append failed for ${this.sessionId} role=${role}: ${err?.message}`);
      }
    } else {
      cliLogger.warn('SESSION_CTX', `db null, skipping persist for ${this.sessionId} role=${role}`);
    }
    const memSeq = actualSeq >= 0 ? actualSeq : this.maxSeqHint + 1;
    this.items.push({ seq: memSeq, role, content, turnId, timestamp, raw: stored });
    this.maxSeqHint = Math.max(this.maxSeqHint, memSeq);
    /* 内存 trim — 持久化层不动, messages 表是真相, cache 只是 LLM 上下文用 */
    if (this.items.length > SessionContext.MAX_CACHE) {
      this.items = this.items.slice(-SessionContext.MAX_CACHE);
    }
    /* 触发 append 事件 — Mobile Bridge 等观察者用. 异常隔离 (一个 listener 抛不影响其他). */
    if (SessionContext.appendListeners.size > 0) {
      const ev: SessionAppendEvent = {
        sessionId: this.sessionId,
        seq: memSeq,
        role,
        content,
        turnId,
        timestamp,
        raw: stored,
      };
      for (const l of SessionContext.appendListeners) {
        try { l(ev); } catch (err: any) {
          cliLogger.warn('SESSION_CTX', `append listener failed: ${err?.message}`);
        }
      }
    }
    return actualSeq;
  }

  appendCompaction(
    messages: Array<{ role: PersistedMessage['role']; content: string; turnId?: string; timestamp?: number; raw?: any }>,
    meta?: { sourceCount?: number },
  ): void {
    const now = Date.now();
    const normalized = messages.map((m) => {
      const stored = {
        ...(m.raw && typeof m.raw === 'object' ? m.raw : {}),
        role: m.role,
        content: m.raw?.content ?? m.content,
        turnId: m.turnId ?? '',
      };
      const contentStr = typeof stored.content === 'string'
        ? stored.content
        : (stored.content == null ? '' : JSON.stringify(stored.content));
      return { role: m.role, content: contentStr, turnId: stored.turnId, timestamp: m.timestamp ?? now, stored };
    });

    let snapshotSeq = this.maxSeqHint + 1;
    if (this.db) {
      try {
        const rawDb = this.db.getRawDb();
        const payload: CompactionSnapshotData = {
          v: 1,
          messages: normalized.map((n) => ({
            role: n.role,
            content: n.content,
            turnId: n.turnId,
            timestamp: n.timestamp,
            raw: n.stored,
          })),
          compactedAt: now,
          sourceCount: meta?.sourceCount ?? this.items.length,
        };
        snapshotSeq = rawDb.transaction(() => {
          const maxRow = rawDb.prepare(
            'SELECT MAX(seq) AS m FROM messages WHERE session_id = ?'
          ).get(this.sessionId) as { m: number | null };
          const nextSeq = (maxRow.m ?? -1) + 1;
          rawDb.prepare(
            'INSERT INTO messages (session_id, seq, item_type, item_data, timestamp) VALUES (?, ?, ?, ?, ?)'
          ).run(this.sessionId, nextSeq, COMPACTION_SNAPSHOT_ITEM_TYPE, JSON.stringify(payload), now);
          return nextSeq;
        })();
        this.maxSeqHint = Math.max(this.maxSeqHint, snapshotSeq);
        cliLogger.info('SESSION_CTX',
          `appendCompaction: snapshot seq=${snapshotSeq} 含 ${normalized.length} 条 for ${this.sessionId} (原始行保留)`);
      } catch (err: any) {
        cliLogger.warn('SESSION_CTX', `appendCompaction failed for ${this.sessionId}: ${err?.message}`);
      }
    }
    /* 同步内存 cache — 与 load() 的快照投影同形 (快照内消息共用快照行的 seq)。 */
    this.items = normalized.map((n) => ({
      seq: snapshotSeq,
      role: n.role,
      content: n.content,
      turnId: n.turnId,
      timestamp: n.timestamp,
      raw: n.stored,
    })).slice(-SessionContext.MAX_CACHE);
  }

  getRawMessages(): PersistedMessage[] {
    if (!this.db) return [...this.items];
    try {
      const rows = this.db.getRawDb().prepare(
        `SELECT seq, item_data, timestamp FROM messages
          WHERE session_id = ? AND item_type = 'message'
          ORDER BY seq ASC`
      ).all(this.sessionId) as Array<{ seq: number; item_data: string; timestamp: number }>;
      const out: PersistedMessage[] = [];
      for (const r of rows) {
        const m = SessionContext.rowToMessage(r);
        if (m) out.push(m);
      }
      return out;
    } catch (err: any) {
      cliLogger.warn('SESSION_CTX', `getRawMessages failed for ${this.sessionId}: ${err?.message}`);
      return [...this.items];
    }
  }

  getRawMessagesPage(beforeSeq: number, limit: number): PersistedMessage[] {
    if (!this.db) return [];
    const safeLimit = Math.max(1, Math.min(1000, Math.trunc(limit)));
    try {
      const rows = this.db.getRawDb().prepare(
        `SELECT seq, item_data, timestamp FROM messages
          WHERE session_id = ? AND item_type = 'message' AND seq < ?
          ORDER BY seq DESC LIMIT ?`
      ).all(this.sessionId, beforeSeq, safeLimit) as Array<{ seq: number; item_data: string; timestamp: number }>;
      const out: PersistedMessage[] = [];
      /* DESC 取完再翻过来 —— 要的是"最近 limit 条", 不是"最早 limit 条" */
      for (let i = rows.length - 1; i >= 0; i--) {
        const m = SessionContext.rowToMessage(rows[i]);
        if (m) out.push(m);
      }
      return out;
    } catch (err: any) {
      cliLogger.warn('SESSION_CTX', `getRawMessagesPage failed for ${this.sessionId}: ${err?.message}`);
      return [];
    }
  }

  pruneCompactedMessages(): number {
    if (!this.db) return 0;
    try {
      const rawDb = this.db.getRawDb();
      /* 倒数第二条快照 — 只有 ≥2 条快照时才存在可删的"过期一代"。 */
      const row = rawDb.prepare(
        `SELECT seq FROM messages
          WHERE session_id = ? AND item_type = ?
          ORDER BY seq DESC LIMIT 1 OFFSET 1`
      ).get(this.sessionId, COMPACTION_SNAPSHOT_ITEM_TYPE) as { seq: number } | undefined;
      if (!row) return 0;
      const res = rawDb.prepare(
        `DELETE FROM messages WHERE session_id = ? AND item_type = 'message' AND seq < ?`
      ).run(this.sessionId, row.seq) as { changes?: number };
      const removed = res?.changes ?? 0;
      if (removed > 0) {
        cliLogger.info('SESSION_CTX', `pruneCompactedMessages: 删除 ${removed} 条 seq<${row.seq} 的原始行 for ${this.sessionId}`);
      }
      return removed;
    } catch (err: any) {
      cliLogger.warn('SESSION_CTX', `pruneCompactedMessages failed for ${this.sessionId}: ${err?.message}`);
      return 0;
    }
  }

  /** 不可变快照, 调用方拿来遍历不会污染 store. */
  getAll(): readonly PersistedMessage[] {
    return this.items;
  }

  /** 当前 cache 条目数 */
  get size(): number {
    return this.items.length;
  }
}

/* P0: 用户切换时清掉 SessionContext 池 — 每个 ctx 都缓存了 this.db 引用,
 *   切人后那个 db 已经 close(), 再调 prepare 会炸. reset() 清空, 下次 get()
 *   会按新 user 的 DB 重建. */
onUserIdChange((next, prev) => {
  void next; void prev;
  SessionContext.reset();
});
