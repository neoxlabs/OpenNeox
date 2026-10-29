import type Database from 'better-sqlite3';
import { runImmediateTransaction } from './sqliteConcurrency.js';

type MsgStat = { sig: string; count: number; firstItemData: string | null };
export type SessionMessageStat = { sessionId: string; count: number; firstItemData: string | null };

export class SessionMessageStatsCache {
    /** 按会话缓存的消息统计。sig = `行数:MAX(id)` —— id 是 AUTOINCREMENT, 任何增删都会让它变,
     *  而库里没有原地 UPDATE messages 的写法, 所以 sig 不变 = 统计不变。 */
    private cache = new Map<string, MsgStat>();
    /** session_msg_stats 里已落盘的 sig —— 跟缓存比, 不同的才写回 (谁填的缓存都一样) */
    private persisted = new Map<string, string>();
    private loaded = false;
    private warming: Promise<void> | null = null;

    constructor(
        private readonly db: Database.Database,
        private readonly stmt: (sql: string) => Database.Statement,
    ) {}

    private ensureLoaded(): void {
        if (this.loaded) return;
        this.loaded = true;
        try {
            this.db.exec(`CREATE TABLE IF NOT EXISTS session_msg_stats (
                session_id TEXT PRIMARY KEY, sig TEXT NOT NULL, count INTEGER NOT NULL, first_item_data TEXT
            )`);
            const rows = this.stmt('SELECT session_id, sig, count, first_item_data FROM session_msg_stats').all() as
                Array<{ session_id: string; sig: string; count: number; first_item_data: string | null }>;
            for (const r of rows) {
                this.cache.set(r.session_id, { sig: r.sig, count: r.count, firstItemData: r.first_item_data });
                this.persisted.set(r.session_id, r.sig);
            }
        } catch { /* 落盘不可用: 只用内存缓存 */ }
    }

    private sigs(): Array<{ session_id: string; n: number; mx: number }> {
        return this.stmt(
            'SELECT session_id, COUNT(*) AS n, MAX(id) AS mx FROM messages GROUP BY session_id',
        ).all() as Array<{ session_id: string; n: number; mx: number }>;
    }

    /** 单个会话重算 (走 session_id 索引) */
    private compute(sid: string, sig: string): MsgStat {
        const r = this.stmt(`
            SELECT COUNT(*) AS cnt, MIN(seq) AS first_seq
            FROM messages
            WHERE session_id = ? AND item_type = 'message'
              AND json_extract(item_data, '$.role') IN ('user','assistant','system')
        `).get(sid) as { cnt: number; first_seq: number | null } | undefined;
        const cnt = r?.cnt ?? 0;
        const first = cnt > 0 && r?.first_seq != null
            ? ((this.stmt('SELECT item_data FROM messages WHERE session_id = ? AND seq = ?')
                .get(sid, r.first_seq) as { item_data: string } | undefined)?.item_data ?? null)
            : null;
        return { sig, count: cnt, firstItemData: first };
    }

    private persist(alive: Set<string>): void {
        const changed: string[] = [];
        for (const [sid, v] of this.cache) if (this.persisted.get(sid) !== v.sig) changed.push(sid);
        const removed = [...this.persisted.keys()].filter((sid) => !alive.has(sid));
        if (changed.length === 0 && removed.length === 0) return;
        try {
            const put = this.stmt('INSERT OR REPLACE INTO session_msg_stats (session_id, sig, count, first_item_data) VALUES (?, ?, ?, ?)');
            const del = this.stmt('DELETE FROM session_msg_stats WHERE session_id = ?');
            runImmediateTransaction(this.db, () => {
                for (const sid of changed) {
                    const v = this.cache.get(sid)!;
                    put.run(sid, v.sig, v.count, v.firstItemData);
                }
                for (const sid of removed) del.run(sid);
            }, { label: 'database.persistMessageStats' });
            for (const sid of changed) this.persisted.set(sid, this.cache.get(sid)!.sig);
            for (const sid of removed) this.persisted.delete(sid);
        } catch { /* 落盘失败: 下次启动重算 */ }
    }

    /** 异步预热: 把 sig 变了的会话分片重算, 每片之间让出事件循环。
     *  升级后第一次启动 (统计表还是空的) 要把每个会话都算一遍 —— 整表扫一次是 2.5s 的同步冻结,
     *  这里拆成每片几十毫秒, 主进程照常响应。调用方 await 它之后再调同步的 get,
     *  后者就只剩命中缓存。并发调用合并成同一次。 */
    warm(perSlice = 6): Promise<void> {
        if (this.warming) return this.warming;
        this.warming = (async () => {
            this.ensureLoaded();
            const misses = this.sigs().filter((r) => this.cache.get(r.session_id)?.sig !== `${r.n}:${r.mx}`);
            for (let i = 0; i < misses.length; i++) {
                if (i > 0 && i % perSlice === 0) await new Promise<void>((r) => setImmediate(r));
                const { session_id: sid, n, mx } = misses[i];
                try { this.cache.set(sid, this.compute(sid, `${n}:${mx}`)); } catch { /* 库被关 / 单会话坏: 交给同步路径 */ }
            }
        })().finally(() => { this.warming = null; });
        return this.warming;
    }

    /** 口径与 timelineEntryToChatMessage 一致: item_type='message' 且 role ∈ 三态。 */
    get(): SessionMessageStat[] {
        this.ensureLoaded();
        const sigs = this.sigs();

        /* 没走异步预热的调用方 (手机桥等) 碰上冷缓存: 未命中多时整表 GROUP BY 一次填满,
         * 比逐个会话随机读快。桌面侧栏走 sessionStore, 会先 await warm。 */
        const misses = sigs.filter((r) => this.cache.get(r.session_id)?.sig !== `${r.n}:${r.mx}`);
        if (misses.length > 20) {
            const bulk = this.stmt(`
                SELECT s.session_id AS session_id, s.cnt AS cnt, m.item_data AS item_data
                FROM (
                    SELECT session_id, COUNT(*) AS cnt, MIN(seq) AS first_seq
                    FROM messages
                    WHERE item_type = 'message'
                      AND json_extract(item_data, '$.role') IN ('user','assistant','system')
                    GROUP BY session_id
                ) s
                LEFT JOIN messages m ON m.session_id = s.session_id AND m.seq = s.first_seq
            `).all() as Array<{ session_id: string; cnt: number; item_data: string | null }>;
            const bySid = new Map(bulk.map((r) => [r.session_id, r]));
            for (const { session_id: sid, n, mx } of sigs) {
                const r = bySid.get(sid);
                this.cache.set(sid, { sig: `${n}:${mx}`, count: r?.cnt ?? 0, firstItemData: r?.item_data ?? null });
            }
        }

        const alive = new Set<string>();
        const out: SessionMessageStat[] = [];
        for (const { session_id: sid, n, mx } of sigs) {
            alive.add(sid);
            const sig = `${n}:${mx}`;
            let hit = this.cache.get(sid);
            if (!hit || hit.sig !== sig) {
                hit = this.compute(sid, sig);
                this.cache.set(sid, hit);
            }
            /* 与原 GROUP BY 口径一致: 没有聊天消息的会话不出行 */
            if (hit.count > 0) out.push({ sessionId: sid, count: hit.count, firstItemData: hit.firstItemData });
        }
        for (const sid of this.cache.keys()) if (!alive.has(sid)) this.cache.delete(sid);
        this.persist(alive);
        return out;
    }
}
