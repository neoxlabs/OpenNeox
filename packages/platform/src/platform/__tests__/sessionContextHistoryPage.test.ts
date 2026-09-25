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
/** 这一轮跑了多少条 SQL —— 用来证明"一页的代价跟会话总长无关"。 */
let prepared: string[] = [];

function makeRawDb(db: any) {
  return {
    prepare: (sql: string) => {
      prepared.push(sql);
      return db.prepare(sql);
    },
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

const SID = 'sess-history-page';
const BEFORE_ALL = 0x7fffffff;

beforeEach(() => {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  db.prepare('INSERT INTO sessions (id, created_at) VALUES (?, ?)').run(SID, Date.now());
  raw = makeRawDb(db);
  prepared = [];
  SessionContext.reset();
});

/** 灌 n 轮对话 (每轮 user + assistant), 返回 ctx。 */
function seed(n: number): SessionContext {
  const ctx = SessionContext.get(SID);
  for (let i = 0; i < n; i++) {
    ctx.appendMessage('user', `问题 ${i}`, `chat-${i}`, 1000 + i * 2);
    ctx.appendMessage('assistant', `回答 ${i}`, '', 1001 + i * 2);
  }
  return ctx;
}

describe('getRawMessagesPage — 手机端拉历史的那一页', () => {
  it('取的是**最近** limit 条, 升序返回', () => {
    seed(10); // 20 条
    SessionContext.reset();
    const page = SessionContext.get(SID).getRawMessagesPage(BEFORE_ALL, 5);

    expect(page.map((m) => m.content)).toEqual([
      '回答 7', '问题 8', '回答 8', '问题 9', '回答 9',
    ]);
    /* 升序是契约: 手机按 seq 入库并据此判断"还有没有更早的" */
    expect(page.map((m) => m.seq)).toEqual([...page.map((m) => m.seq)].sort((a, b) => a - b));
  });

  it('beforeSeq 是游标 —— 往回翻页能一路翻到第一条 (seq 0 也翻得出来)', () => {
    seed(3); // seq 0..5
    SessionContext.reset();
    const ctx = SessionContext.get(SID);

    const seen: number[] = [];
    let cursor = BEFORE_ALL;
    for (let i = 0; i < 10; i++) {
      const page = ctx.getRawMessagesPage(cursor, 2);
      if (page.length === 0) break;
      seen.unshift(...page.map((m) => m.seq));
      cursor = page[0].seq;
    }
    /* seq 从 0 起算 —— 第一条用户消息就是 seq 0, 必须能翻到 */
    expect(seen).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('一页的成本跟会话总长无关 (SQL 条数 + 解析行数都不随长度涨)', () => {
    seed(200); // 400 条
    SessionContext.reset();
    const ctx = SessionContext.get(SID); // load 本身会读库
    prepared = [];

    const page = ctx.getRawMessagesPage(BEFORE_ALL, 50);
    expect(page.length).toBe(50);
    expect(prepared.length).toBe(1);
    expect(prepared[0]).toContain('LIMIT');
    expect(prepared[0]).toContain('seq < ?');
    /* 不许退化成全表: 没有 LIMIT 的 message 查询在这条路上就是那个 bug */
    expect(prepared[0]).not.toMatch(/ORDER BY seq ASC\s*$/);
  });

  it('压缩过的会话: 每条消息仍有自己的 seq (不像 LLM 投影那样共用快照行的 seq)', () => {
    const ctx = seed(2); // seq 0..3
    ctx.appendCompaction([
      { role: 'system', content: '[COMPACTED] 摘要' },
      { role: 'user', content: '问题 1' },
    ]);
    ctx.appendMessage('user', '压缩后的新问题', 'chat-new', 9000);
    SessionContext.reset();

    const after = SessionContext.get(SID);
    const page = after.getRawMessagesPage(BEFORE_ALL, 100);

    expect(page.map((m) => m.content)).toEqual([
      '问题 0', '回答 0', '问题 1', '回答 1', '压缩后的新问题',
    ]);
    /* seq 全不相同 —— 手机按 (sessionId, seq) 入库, 撞一个就丢一条 */
    const seqs = page.map((m) => m.seq);
    expect(new Set(seqs).size).toBe(seqs.length);

    /* 对照: LLM 投影里快照那几条共用同一个 seq, 所以它不能给手机用 */
    const llm = after.getAll();
    const llmSeqs = llm.map((m) => m.seq);
    expect(new Set(llmSeqs).size).toBeLessThan(llmSeqs.length);
  });

  it('库里没有这个会话 → 空数组 (调用方据此退回内存投影)', () => {
    SessionContext.reset();
    const page = SessionContext.get('sess-不存在').getRawMessagesPage(BEFORE_ALL, 50);
    expect(page).toEqual([]);
  });
});
