import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NeoxDatabase } from '../database.js';


let dir: string | null = null;
const prevEnv: Record<string, string | undefined> = {};

afterEach(() => {
  for (const [k, v] of Object.entries(prevEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } dir = null; }
});

function open(): { db: NeoxDatabase; dbPath: string } {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-msgstats-'));
  for (const k of ['NEOX_DB_ENCRYPT', 'NEOX_HOME']) prevEnv[k] = process.env[k];
  process.env.NEOX_DB_ENCRYPT = '0';
  process.env.NEOX_HOME = dir;
  const dbPath = path.join(dir, 'neox.db');
  return { db: new NeoxDatabase(dbPath), dbPath };
}

function session(db: NeoxDatabase, id: string): void {
  db.upsertSession({ id, name: id, modelId: 'm', workspacePath: '/ws', createdAt: 1, updatedAt: 1, totalTokens: 0, contextUsed: 0 });
}

const msg = (role: string, content: string) => ({ role, content });
const byId = (rows: Array<{ sessionId: string; count: number; firstItemData: string | null }>) =>
  Object.fromEntries(rows.map((r) => [r.sessionId, { count: r.count, first: r.firstItemData ? JSON.parse(r.firstItemData).content : null }]));

describe('getSessionMessageStats 缓存', () => {
  it('增量: 新消息 / 非聊天行 / 删会话 都反映出来', () => {
    const { db } = open();
    session(db, 'a'); session(db, 'b');
    db.insertMessage('a', 1, 'message', msg('user', 'hi a'), 1);
    db.insertMessage('a', 2, 'message', msg('assistant', 'yo'), 2);
    db.insertMessage('b', 1, 'compaction_snapshot', { x: 1 }, 1);
    expect(byId(db.getSessionMessageStats())).toEqual({ a: { count: 2, first: 'hi a' } });

    db.insertMessage('b', 2, 'message', msg('user', 'hi b'), 3);
    db.insertMessage('a', 3, 'message', msg('tool', 'ignored'), 4);
    expect(byId(db.getSessionMessageStats())).toEqual({
      a: { count: 2, first: 'hi a' },
      b: { count: 1, first: 'hi b' },
    });

    db.deleteSession('a');
    expect(byId(db.getSessionMessageStats())).toEqual({ b: { count: 1, first: 'hi b' } });
    db.close();
  });

  it('落盘: 重开库后直接读回, 且之后的变更仍能察觉', () => {
    const { db, dbPath } = open();
    session(db, 'a');
    db.insertMessage('a', 1, 'message', msg('user', 'first'), 1);
    expect(byId(db.getSessionMessageStats())).toEqual({ a: { count: 1, first: 'first' } });
    db.close();

    const reopened = new NeoxDatabase(dbPath);
    const persisted = (reopened as any).db.prepare('SELECT COUNT(*) AS n FROM session_msg_stats').get().n;
    expect(persisted).toBe(1);
    expect(byId(reopened.getSessionMessageStats())).toEqual({ a: { count: 1, first: 'first' } });
    reopened.insertMessage('a', 2, 'message', msg('assistant', 'second'), 2);
    expect(byId(reopened.getSessionMessageStats())).toEqual({ a: { count: 2, first: 'first' } });
    reopened.close();
  });

  it('异步预热: 分片算完后同步调用全命中, 且结果落盘', async () => {
    const { db, dbPath } = open();
    for (let i = 0; i < 25; i++) {
      session(db, `s${i}`);
      db.insertMessage(`s${i}`, 1, 'message', msg('user', `q${i}`), 1);
    }
    await Promise.all([db.warmSessionMessageStats(4), db.warmSessionMessageStats(4)]);
    const cache = (db as any).msgStats.cache as Map<string, unknown>;
    expect(cache.size).toBe(25);
    expect(byId(db.getSessionMessageStats()).s7).toEqual({ count: 1, first: 'q7' });
    db.close();
    const reopened = new NeoxDatabase(dbPath);
    expect((reopened as any).db.prepare('SELECT COUNT(*) AS n FROM session_msg_stats').get().n).toBe(25);
    reopened.close();
  });

  it('冷缓存会话多 (走整表批量) 与逐个算结果一致', () => {
    const { db } = open();
    for (let i = 0; i < 30; i++) {
      session(db, `s${i}`);
      db.insertMessage(`s${i}`, 1, 'message', msg('user', `q${i}`), 1);
      if (i % 2) db.insertMessage(`s${i}`, 2, 'message', msg('assistant', `a${i}`), 2);
    }
    const stats = byId(db.getSessionMessageStats());
    expect(Object.keys(stats)).toHaveLength(30);
    expect(stats.s3).toEqual({ count: 2, first: 'q3' });
    expect(stats.s4).toEqual({ count: 1, first: 'q4' });
    db.close();
  });
});
