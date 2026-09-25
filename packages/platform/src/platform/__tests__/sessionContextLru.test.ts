import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  item_type   TEXT NOT NULL,
  item_data   TEXT NOT NULL,
  timestamp   INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_session_type_seq ON messages(session_id, item_type, seq DESC);
`;

let raw: any;

function makeRawDb(db: any) {
  return {
    prepare: (sql: string) => db.prepare(sql),
    exec: (sql: string) => db.exec(sql),
    transaction: (fn: (...a: any[]) => any) => (...args: any[]) => {
      db.exec('BEGIN');
      try {
        const r = fn(...args);
        db.exec('COMMIT');
        return r;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

vi.mock('../database.js', () => ({
  getDatabase: () => ({ getRawDb: () => raw }),
  NeoxDatabase: class {},
}));
vi.mock('../../utils/config.js', () => ({ onUserIdChange: () => () => {} }));
vi.mock('@neoxlabs/kernel/platform/cliLogger.js', () => ({
  cliLogger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

import { SessionContext } from '../sessionContext.js';

/** 从实现里读上限, 别在测试里抄一份 —— 抄了之后改实现测试照样绿。 */
const LIMIT = (SessionContext as unknown as { MAX_CACHED_SESSIONS: number }).MAX_CACHED_SESSIONS;

beforeEach(() => {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  raw = makeRawDb(db);
  SessionContext.reset();
});

describe('SessionContext 缓存上限', () => {
  it('上限是个正整数, 而且没大到形同虚设', () => {
    expect(Number.isInteger(LIMIT)).toBe(true);
    expect(LIMIT).toBeGreaterThan(0);
    expect(LIMIT).toBeLessThanOrEqual(32);
  });

  it('① 开 3 倍上限那么多会话, 缓存个数仍不超过上限', () => {
    const n = LIMIT * 3;
    for (let i = 0; i < n; i++) {
      raw.prepare('INSERT INTO sessions (id, created_at) VALUES (?, ?)').run(`s${i}`, Date.now());
      SessionContext.get(`s${i}`).appendMessage('user', `hi ${i}`, '', Date.now());
    }
    expect(SessionContext.cachedSessionCount()).toBeLessThanOrEqual(LIMIT);
  });

  it('② 淘汰的是最久没用的, 反复访问的那个一直活着', () => {
    for (let i = 0; i < LIMIT * 2; i++) {
      raw.prepare('INSERT INTO sessions (id, created_at) VALUES (?, ?)').run(`s${i}`, Date.now());
    }
    const hot = SessionContext.get('s0');
    /* 每开一个新会话就回访一次 hot —— 它永远是最近使用的 */
    for (let i = 1; i < LIMIT * 2; i++) {
      SessionContext.get(`s${i}`);
      SessionContext.get('s0');
    }
    /* 同一个实例还在 (没被淘汰后重建) */
    expect(SessionContext.get('s0')).toBe(hot);
    expect(SessionContext.cachedSessionCount()).toBeLessThanOrEqual(LIMIT);
  });

  it('③ 被淘汰的会话再取回来, 消息一条不少 (库是真相源)', () => {
    raw.prepare('INSERT INTO sessions (id, created_at) VALUES (?, ?)').run('victim', Date.now());
    const ctx = SessionContext.get('victim');
    ctx.appendMessage('user', '第一条', '', Date.now());
    ctx.appendMessage('assistant', '第二条', '', Date.now());
    const before = ctx.getAll().map(m => m.content);

    /* 用足够多的新会话把它挤出去 */
    for (let i = 0; i < LIMIT * 2; i++) {
      raw.prepare('INSERT INTO sessions (id, created_at) VALUES (?, ?)').run(`f${i}`, Date.now());
      SessionContext.get(`f${i}`);
    }

    const revived = SessionContext.get('victim');
    expect(revived).not.toBe(ctx);                       /* 确实被淘汰过, 是新实例 */
    expect(revived.getAll().map(m => m.content)).toEqual(before);
  });
});
