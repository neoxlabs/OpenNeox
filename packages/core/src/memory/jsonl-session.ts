/**
 * SQLite Session 实现
 *
 * 使用 SQLite (session_items 表) 替代 JSONL 文件存储会话历史。
 * 完全兼容 Session 接口。保留 JSONLSession 的 API 签名。
 */

import os from 'os';
import type {
  Session,
  SessionItem,
  SessionMeta,
  TimestampedSessionItem,
  CheckpointItem,
  MessageItem
} from '@neoxlabs/kernel/types/session.js';
import type { Message } from '@neoxlabs/kernel/types/index.js';
import { generateSessionId } from '@neoxlabs/kernel/types/session.js';
import type { NeoxDatabase } from '@neoxlabs/platform/platform/database.js';

// ============================================================================
// 配置
// ============================================================================

export interface SQLiteSessionOptions {
  /** 会话 ID */
  sessionId: string;
  /** workspace path for isolation */
  workspacePath?: string;
  /** Agent 名称（用于元数据） */
  agentName?: string;
  /** 模型名称（用于元数据） */
  model?: string;
  /** 是否自动创建元数据 */
  autoCreateMeta?: boolean;
  /** Database instance (uses singleton if not provided) */
  db?: NeoxDatabase;
}

// Keep old interface name for compat
export type JSONLSessionOptions = SQLiteSessionOptions;

interface SessionItemRow {
  id: number;
  session_id: string;
  workspace_path: string;
  seq: number;
  item_type: string;
  item_data: string;
  ts: number;
}

// ============================================================================
// SQLiteSession (exported as JSONLSession for backward compat)
// ============================================================================

export class JSONLSession implements Session {
  readonly sessionId: string;
  private db: NeoxDatabase;
  private workspacePath: string;
  private options: SQLiteSessionOptions;
  private sequenceNumber: number = 0;
  private initialized: boolean = false;

  constructor(options: SQLiteSessionOptions | string) {
    if (typeof options === 'string') {
      options = { sessionId: options };
    }

    this.sessionId = options.sessionId;
    this.options = options;
    this.workspacePath = options.workspacePath || process.cwd();

    if (options.db) {
      this.db = options.db;
    } else {
      // Dynamic import to avoid circular deps at class level
      const { NeoxDatabase: DB } = require('@neoxlabs/platform/platform/database.js');
      this.db = new DB();
    }
  }

  private raw() {
    return this.db.getRawDb();
  }

  // --------------------------------------------------------------------------
  // 私有方法
  // --------------------------------------------------------------------------

  private ensureInitialized(): void {
    if (this.initialized) return;

    // Get max sequence number
    const row = this.raw().prepare(
      'SELECT MAX(seq) as max_seq FROM session_items WHERE session_id = ? AND workspace_path = ?'
    ).get(this.sessionId, this.workspacePath) as { max_seq: number | null } | undefined;

    if (row?.max_seq !== null && row?.max_seq !== undefined) {
      this.sequenceNumber = row.max_seq + 1;
    } else {
      // No items yet, create metadata
      if (this.options.autoCreateMeta !== false) {
        const meta: SessionMeta = {
          sessionId: this.sessionId,
          createdAt: new Date().toISOString(),
          agentName: this.options.agentName,
          model: this.options.model
        };
        this.appendItemSync({ type: 'meta', data: meta });
      }
    }

    this.initialized = true;
  }

  private appendItemSync(item: SessionItem): void {
    const ts = Date.now();
    const seq = this.sequenceNumber++;
    this.raw().prepare(`
      INSERT INTO session_items (session_id, workspace_path, seq, item_type, item_data, ts)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(this.sessionId, this.workspacePath, seq, item.type, JSON.stringify(item), ts);
  }

  private readAllItemsSync(): TimestampedSessionItem[] {
    const rows = this.raw().prepare(
      'SELECT * FROM session_items WHERE session_id = ? AND workspace_path = ? ORDER BY seq'
    ).all(this.sessionId, this.workspacePath) as SessionItemRow[];

    return rows.map(r => ({
      item: JSON.parse(r.item_data) as SessionItem,
      timestamp: r.ts,
      seq: r.seq,
    }));
  }

  // --------------------------------------------------------------------------
  // 公共接口实现
  // --------------------------------------------------------------------------

  async getItems(limit?: number): Promise<SessionItem[]> {
    this.ensureInitialized();

    if (limit !== undefined) {
      const rows = this.raw().prepare(
        'SELECT item_data FROM session_items WHERE session_id = ? AND workspace_path = ? ORDER BY seq DESC LIMIT ?'
      ).all(this.sessionId, this.workspacePath, limit) as { item_data: string }[];
      return rows.reverse().map(r => JSON.parse(r.item_data));
    }

    const rows = this.raw().prepare(
      'SELECT item_data FROM session_items WHERE session_id = ? AND workspace_path = ? ORDER BY seq'
    ).all(this.sessionId, this.workspacePath) as { item_data: string }[];
    return rows.map(r => JSON.parse(r.item_data));
  }

  async addItems(items: SessionItem[]): Promise<void> {
    if (items.length === 0) return;
    this.ensureInitialized();

    const stmt = this.raw().prepare(`
      INSERT INTO session_items (session_id, workspace_path, seq, item_type, item_data, ts)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const tx = this.raw().transaction(() => {
      for (const item of items) {
        const ts = Date.now();
        const seq = this.sequenceNumber++;
        stmt.run(this.sessionId, this.workspacePath, seq, item.type, JSON.stringify(item), ts);
      }
    });
    tx();
  }

  async popItem(): Promise<SessionItem | null> {
    this.ensureInitialized();

    const row = this.raw().prepare(
      'SELECT id, item_data FROM session_items WHERE session_id = ? AND workspace_path = ? ORDER BY seq DESC LIMIT 1'
    ).get(this.sessionId, this.workspacePath) as { id: number; item_data: string } | undefined;

    if (!row) return null;

    this.raw().prepare('DELETE FROM session_items WHERE id = ?').run(row.id);
    return JSON.parse(row.item_data);
  }

  async popItems(count: number): Promise<SessionItem[]> {
    if (count <= 0) return [];
    this.ensureInitialized();

    const rows = this.raw().prepare(
      'SELECT id, item_data FROM session_items WHERE session_id = ? AND workspace_path = ? ORDER BY seq DESC LIMIT ?'
    ).all(this.sessionId, this.workspacePath, count) as { id: number; item_data: string }[];

    if (rows.length === 0) return [];

    const ids = rows.map(r => r.id);
    const placeholders = ids.map(() => '?').join(', ');
    this.raw().prepare(`DELETE FROM session_items WHERE id IN (${placeholders})`).run(...ids);

    return rows.reverse().map(r => JSON.parse(r.item_data));
  }

  async createCheckpoint(name?: string, description?: string, fileCheckpointId?: string): Promise<string> {
    this.ensureInitialized();

    const checkpointId = `cp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const checkpoint: CheckpointItem = {
      type: 'checkpoint',
      data: { id: checkpointId, name, description, fileCheckpointId }
    };
    this.appendItemSync(checkpoint);
    return checkpointId;
  }

  async rollbackToCheckpoint(checkpointId: string): Promise<number> {
    this.ensureInitialized();

    // Find the checkpoint row
    const allItems = this.readAllItemsSync();
    const checkpointIndex = allItems.findIndex(
      ti => ti.item.type === 'checkpoint' &&
           (ti.item as CheckpointItem).data.id === checkpointId
    );

    if (checkpointIndex === -1) {
      throw new Error(`Checkpoint not found: ${checkpointId}`);
    }

    const keepSeq = allItems[checkpointIndex].seq;
    const result = this.raw().prepare(
      'DELETE FROM session_items WHERE session_id = ? AND workspace_path = ? AND seq > ?'
    ).run(this.sessionId, this.workspacePath, keepSeq);

    return result.changes;
  }

  async getCheckpoints(): Promise<Array<{ id: string; name?: string; timestamp: number }>> {
    this.ensureInitialized();

    const rows = this.raw().prepare(
      "SELECT item_data, ts FROM session_items WHERE session_id = ? AND workspace_path = ? AND item_type = 'checkpoint' ORDER BY seq"
    ).all(this.sessionId, this.workspacePath) as { item_data: string; ts: number }[];

    return rows.map(r => {
      const cp = JSON.parse(r.item_data) as CheckpointItem;
      return { id: cp.data.id, name: cp.data.name, timestamp: r.ts };
    });
  }

  async clearSession(): Promise<void> {
    this.raw().prepare(
      'DELETE FROM session_items WHERE session_id = ? AND workspace_path = ?'
    ).run(this.sessionId, this.workspacePath);
    this.sequenceNumber = 0;
    this.initialized = false;
  }

  async getMeta(): Promise<SessionMeta | null> {
    this.ensureInitialized();

    const row = this.raw().prepare(
      "SELECT item_data FROM session_items WHERE session_id = ? AND workspace_path = ? AND item_type = 'meta' ORDER BY seq LIMIT 1"
    ).get(this.sessionId, this.workspacePath) as { item_data: string } | undefined;

    if (!row) return null;
    const item = JSON.parse(row.item_data);
    return item.data as SessionMeta;
  }

  async getMessages(): Promise<Message[]> {
    this.ensureInitialized();

    const rows = this.raw().prepare(
      "SELECT item_data FROM session_items WHERE session_id = ? AND workspace_path = ? AND item_type = 'message' ORDER BY seq"
    ).all(this.sessionId, this.workspacePath) as { item_data: string }[];

    return rows.map(r => {
      const item = JSON.parse(r.item_data) as MessageItem;
      return item.data;
    });
  }

  async getItemCount(): Promise<number> {
    const row = this.raw().prepare(
      'SELECT COUNT(*) as cnt FROM session_items WHERE session_id = ? AND workspace_path = ?'
    ).get(this.sessionId, this.workspacePath) as { cnt: number };
    return row.cnt;
  }

  async getTimeline(): Promise<TimestampedSessionItem[]> {
    this.ensureInitialized();
    return this.readAllItemsSync();
  }

  async replaceTimeline(items: TimestampedSessionItem[]): Promise<void> {
    // Delete all items and reinsert
    this.raw().prepare(
      'DELETE FROM session_items WHERE session_id = ? AND workspace_path = ?'
    ).run(this.sessionId, this.workspacePath);

    const stmt = this.raw().prepare(`
      INSERT INTO session_items (session_id, workspace_path, seq, item_type, item_data, ts)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const tx = this.raw().transaction(() => {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        stmt.run(
          this.sessionId, this.workspacePath, i,
          item.item.type, JSON.stringify(item.item),
          item.timestamp ?? Date.now()
        );
      }
    });
    tx();

    this.sequenceNumber = items.length;
    this.initialized = true;
  }

  // --------------------------------------------------------------------------
  // 静态工具方法
  // --------------------------------------------------------------------------

  static async listSessions(directory?: string): Promise<string[]> {
    try {
      const { NeoxDatabase: DB } = require('@neoxlabs/platform/platform/database.js');
      const db = new DB() as NeoxDatabase;
      const rows = db.getRawDb().prepare(
        'SELECT DISTINCT session_id FROM session_items ORDER BY session_id'
      ).all() as { session_id: string }[];
      return rows.map(r => r.session_id);
    } catch {
      return [];
    }
  }

  static async getMostRecentId(directory?: string): Promise<string | null> {
    try {
      const { NeoxDatabase: DB } = require('@neoxlabs/platform/platform/database.js');
      const db = new DB() as NeoxDatabase;
      const row = db.getRawDb().prepare(
        'SELECT session_id FROM session_items ORDER BY ts DESC LIMIT 1'
      ).get() as { session_id: string } | undefined;
      return row?.session_id || null;
    } catch {
      return null;
    }
  }

  static async deleteSession(sessionId: string, directory?: string): Promise<boolean> {
    try {
      const { NeoxDatabase: DB } = require('@neoxlabs/platform/platform/database.js');
      const db = new DB() as NeoxDatabase;
      const result = db.getRawDb().prepare(
        'DELETE FROM session_items WHERE session_id = ?'
      ).run(sessionId);
      return result.changes > 0;
    } catch {
      return false;
    }
  }

  static async getSessionInfo(sessionId: string, directory?: string): Promise<{
    sessionId: string;
    filePath: string;
    size: number;
    createdAt: Date;
    updatedAt: Date;
  } | null> {
    try {
      const { NeoxDatabase: DB } = require('@neoxlabs/platform/platform/database.js');
      const db = new DB() as NeoxDatabase;
      const raw = db.getRawDb();
      const row = raw.prepare(
        'SELECT MIN(ts) as min_ts, MAX(ts) as max_ts, COUNT(*) as cnt FROM session_items WHERE session_id = ?'
      ).get(sessionId) as { min_ts: number | null; max_ts: number | null; cnt: number };

      if (!row || row.cnt === 0) return null;

      return {
        sessionId,
        filePath: `sqlite://session_items/${sessionId}`,
        size: row.cnt * 200, // approximate
        createdAt: new Date(row.min_ts!),
        updatedAt: new Date(row.max_ts!),
      };
    } catch {
      return null;
    }
  }

  static create(options?: Omit<SQLiteSessionOptions, 'sessionId'>): JSONLSession {
    return new JSONLSession({
      sessionId: generateSessionId(),
      ...options
    });
  }
}
