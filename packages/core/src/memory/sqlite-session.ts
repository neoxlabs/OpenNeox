
import type {
    Session,
    SessionItem,
    SessionMeta,
    TimestampedSessionItem,
    CheckpointItem,
    MessageItem,
} from '@neoxlabs/kernel/types/session.js';
import type { Message } from '@neoxlabs/kernel/types/index.js';
import { getDatabase } from '@neoxlabs/platform/platform/database.js';

// ============================================================================
// SQLiteSession 实现
// ============================================================================

export class SQLiteSession implements Session {
    readonly sessionId: string;
    private initialized: boolean = false;

    constructor(sessionId: string) {
        this.sessionId = sessionId;
    }

    // --------------------------------------------------------------------------
    // 初始化
    // --------------------------------------------------------------------------

    private ensureInitialized(): void {
        if (this.initialized) return;
        this.initialized = true;
        try {
            const db = getDatabase();
            if (!db.getSession(this.sessionId)) {
                const now = Date.now();
                db.upsertSession({
                    id: this.sessionId,
                    name: this.sessionId,
                    modelId: '',
                    workspacePath: '',
                    createdAt: now,
                    updatedAt: now,
                    totalTokens: 0,
                    contextUsed: 0,
                });
            }
        } catch {
            /* upsert 失败 (磁盘/schema 异常) 不阻塞业务路径, 让后续 addItems 自然抛真错误. */
        }
    }

    // --------------------------------------------------------------------------
    // 核心接口实现
    // --------------------------------------------------------------------------

    async getItems(limit?: number): Promise<SessionItem[]> {
        this.ensureInitialized();
        const db = getDatabase();
        const rows = db.getMessages(this.sessionId, limit);
        return rows.map((r: any) => ({
            type: r.itemType,
            data: r.itemData,
        } as SessionItem));
    }

    async addItems(items: SessionItem[]): Promise<void> {
        if (items.length === 0) return;
        this.ensureInitialized();
        const db = getDatabase();
        /* 原子分配 seq + 批量 INSERT, 跟 ConversationLedger.append 共用同一个 seq 池.
         * better-sqlite3 transaction 同进程串行, 跨实例无 race. INSERT (非 OR REPLACE)
         * 出 UNIQUE 冲突时直接 throw, 暴露 bug 不静默吞掉. */
        const raw = db.getRawDb();
        const tx = raw.transaction(() => {
            const maxRow = raw.prepare(
                'SELECT MAX(seq) AS maxSeq FROM messages WHERE session_id = ?'
            ).get(this.sessionId) as { maxSeq: number | null };
            let nextSeq = (maxRow.maxSeq ?? -1) + 1;
            const insert = raw.prepare(
                'INSERT INTO messages (session_id, seq, item_type, item_data, timestamp) VALUES (?, ?, ?, ?, ?)'
            );
            const now = Date.now();
            for (const item of items) {
                insert.run(this.sessionId, nextSeq++, item.type, JSON.stringify(item.data), now);
            }
        });
        tx();
    }

    async popItem(): Promise<SessionItem | null> {
        this.ensureInitialized();
        const db = getDatabase();
        const last = db.getLastMessage(this.sessionId);
        if (!last) return null;

        db.deleteMessage(this.sessionId, last.seq);

        return {
            type: last.itemType,
            data: last.itemData,
        } as SessionItem;
    }

    async popItems(count: number): Promise<SessionItem[]> {
        if (count <= 0) return [];
        this.ensureInitialized();

        const db = getDatabase();
        const items = db.getLastMessages(this.sessionId, count);
        if (items.length === 0) return [];

        // 删除这些条目 — seq 不需要刷新, 下次 addItems 会重新 SELECT MAX
        db.deleteLastMessages(this.sessionId, count);

        return items.map((r: any) => ({
            type: r.itemType,
            data: r.itemData,
        } as SessionItem));
    }

    async createCheckpoint(name?: string, description?: string, fileCheckpointId?: string): Promise<string> {
        this.ensureInitialized();

        const checkpointId = `cp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const checkpoint: CheckpointItem = {
            type: 'checkpoint',
            data: { id: checkpointId, name, description, fileCheckpointId },
        };

        await this.addItems([checkpoint]);
        return checkpointId;
    }

    /**
     * 从「倒数第 k 条用户消息」起截断 —— 「编辑并重发」的模型侧那一半.
     * 返回删掉的条数; -1 表示没找到第 k 条用户消息 (调用方必须中止, 不能接着发)。
     * 语义与去向见 platform/database.ts 的 deleteFromNthLastUserMessage。
     */
    async truncateFromNthLastUserMessage(k: number): Promise<number> {
        this.ensureInitialized();
        const db = getDatabase();
        const removed = db.deleteFromNthLastUserMessage(this.sessionId, k);
        /* 裁完必须让下次 addItems 重新 SELECT MAX(seq) —— 与 clearSession 同理 */
        if (removed > 0) this.initialized = false;
        return removed;
    }

    async rollbackToCheckpoint(checkpointId: string): Promise<number> {
        this.ensureInitialized();
        const db = getDatabase();
        return db.rollbackToCheckpoint(this.sessionId, checkpointId);
    }

    async getCheckpoints(): Promise<Array<{ id: string; name?: string; timestamp: number }>> {
        this.ensureInitialized();
        const db = getDatabase();
        return db.getCheckpoints(this.sessionId);
    }

    async clearSession(): Promise<void> {
        const db = getDatabase();
        db.clearMessages(this.sessionId);
        this.initialized = false;
    }

    async getMeta(): Promise<SessionMeta | null> {
        this.ensureInitialized();
        const db = getDatabase();
        return db.getSessionMeta(this.sessionId);
    }

    async getMessages(): Promise<Message[]> {
        this.ensureInitialized();
        const db = getDatabase();
        const rows = db.getMessagesByType(this.sessionId, 'message');
        return rows.map((r: any) => r.itemData as Message);
    }

    async getItemCount(): Promise<number> {
        const db = getDatabase();
        return db.getMessageCount(this.sessionId);
    }

    async getTimeline(): Promise<TimestampedSessionItem[]> {
        this.ensureInitialized();
        const db = getDatabase();
        const rows = db.getMessages(this.sessionId);
        return rows.map((r: any) => ({
            item: { type: r.itemType, data: r.itemData } as SessionItem,
            timestamp: r.timestamp,
            seq: r.seq,
        }));
    }

    async replaceTimeline(items: TimestampedSessionItem[]): Promise<void> {
        const db = getDatabase();

        // 清空再批量插入
        db.clearMessages(this.sessionId);

        if (items.length > 0) {
            const normalized = items.map((item, index) => ({
                seq: index,
                itemType: item.item.type,
                itemData: item.item.data,
                timestamp: item.timestamp ?? Date.now(),
            }));
            db.insertMessagesBatch(this.sessionId, normalized);
        }

        this.initialized = true;
    }
}
