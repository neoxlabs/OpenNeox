import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

/** 与 database.ts initSchema 中 messages 相关部分保持一致。 */
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

/** better-sqlite3 风格外壳: prepare() 直通, transaction(fn) 返回可调用包装。 */
function makeRawDb(db: any) {
  return {
    prepare: (sql: string) => db.prepare(sql),
    exec: (sql: string) => db.exec(sql),
    /* 跟 better-sqlite3 一样: 返回的包装本身是 deferred, 另带 .immediate / .exclusive */
    transaction: (fn: (...a: any[]) => any) => {
      const run = (mode: string) => (...args: any[]) => {
        db.exec(`BEGIN ${mode}`);
        try {
          const r = fn(...args);
          db.exec('COMMIT');
          return r;
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
      };
      return Object.assign(run(''), { deferred: run('DEFERRED'), immediate: run('IMMEDIATE'), exclusive: run('EXCLUSIVE') });
    },
  };
}

vi.mock('../database.js', () => ({
  getDatabase: () => ({ getRawDb: () => raw }),
  NeoxDatabase: class {},
  /* 常量的定义在 database.ts (最低层) —— mock 必须同步导出, 否则 sessionContext 里拿到 undefined。 */
  COMPACTION_SNAPSHOT_ITEM_TYPE: 'compaction_snapshot',
}));
vi.mock('../../utils/config.js', () => ({ onUserIdChange: () => () => {} }));
vi.mock('@neoxlabs/kernel/platform/cliLogger.js', () => ({
  cliLogger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

import { SessionContext, COMPACTION_SNAPSHOT_ITEM_TYPE } from '../sessionContext.js';

const SID = 'sess-compaction';

/** 模拟重启: 丢掉单例, 下次 get() 重新从库 load。 */
function reload(): SessionContext {
  SessionContext.reset();
  return SessionContext.get(SID);
}

function rowsOf(itemType: string): Array<{ seq: number; item_data: string }> {
  return raw.prepare(
    `SELECT seq, item_data FROM messages WHERE session_id = ? AND item_type = ? ORDER BY seq ASC`,
  ).all(SID, itemType) as any;
}

beforeEach(() => {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  db.prepare('INSERT INTO sessions (id, created_at) VALUES (?, ?)').run(SID, Date.now());
  raw = makeRawDb(db);
  SessionContext.reset();
});

describe('SessionContext 压缩落盘 = append-only 快照', () => {
  it('无快照时 load 读全量 message 行 (存量库行为不变)', () => {
    const ctx = SessionContext.get(SID);
    ctx.appendMessage('user', '第一个问题', '', Date.now());
    ctx.appendMessage('assistant', '第一个回答', '', Date.now());

    const after = reload();
    expect(after.getAll().map((m) => m.content)).toEqual(['第一个问题', '第一个回答']);
  });

  it('① 重启后 LLM 投影 = 快照 + 快照之后追加的消息', () => {
    const ctx = SessionContext.get(SID);
    ctx.appendMessage('user', '老问题 A', '', Date.now());
    ctx.appendMessage('assistant', '老回答 A', '', Date.now());
    ctx.appendMessage('user', '老问题 B', '', Date.now());

    ctx.appendCompaction([
      { role: 'system', content: '[COMPACTED] 摘要: 讨论过 A 和 B' },
      { role: 'user', content: '老问题 B' },
    ]);
    ctx.appendMessage('assistant', '压缩后的新回答', '', Date.now());

    const after = reload();
    expect(after.getAll().map((m) => m.content)).toEqual([
      '[COMPACTED] 摘要: 讨论过 A 和 B',
      '老问题 B',
      '压缩后的新回答',
    ]);
    // 被压掉的原文不在 LLM 投影里
    expect(after.getAll().some((m) => m.content === '老回答 A')).toBe(false);
  });

  it('② 压缩不删任何原始 message 行 — 用户原话仍在库里', () => {
    const ctx = SessionContext.get(SID);
    ctx.appendMessage('user', '我说过的原话', '', Date.now());
    ctx.appendMessage('assistant', '很长的工具输出', '', Date.now());

    const beforeRows = rowsOf('message').length;
    ctx.appendCompaction([{ role: 'system', content: '[COMPACTED] 摘要' }]);

    // 原始行一条没少, 且新增了恰好一条快照行
    expect(rowsOf('message').length).toBe(beforeRows);
    expect(rowsOf(COMPACTION_SNAPSHOT_ITEM_TYPE).length).toBe(1);

    const shown = reload().getRawMessages().map((m) => m.content);
    expect(shown).toEqual(['我说过的原话', '很长的工具输出']);
    expect(shown).not.toContain('[COMPACTED] 摘要');
  });

  it('③ 回调漏一次 = 历史完整未折叠, 不是压缩前后混杂', () => {
    const ctx = SessionContext.get(SID);
    ctx.appendMessage('user', 'Q1', '', Date.now());
    ctx.appendMessage('assistant', 'A1', '', Date.now());
    // 压缩发生在内存里, 但 appendCompaction 没被调到 (回调漏了)
    ctx.appendMessage('user', 'Q2', '', Date.now());

    const after = reload();
    expect(after.getAll().map((m) => m.content)).toEqual(['Q1', 'A1', 'Q2']);
  });

  it('④ 连续两次压缩, 只有最新快照参与 LLM 投影', () => {
    const ctx = SessionContext.get(SID);
    ctx.appendMessage('user', 'Q1', '', Date.now());
    ctx.appendCompaction([{ role: 'system', content: '[COMPACTED] 第一代摘要' }]);
    ctx.appendMessage('user', 'Q2', '', Date.now());
    ctx.appendCompaction([
      { role: 'system', content: '[COMPACTED] 第二代摘要' },
      { role: 'user', content: 'Q2' },
    ]);
    ctx.appendMessage('user', 'Q3', '', Date.now());

    const after = reload();
    expect(after.getAll().map((m) => m.content)).toEqual([
      '[COMPACTED] 第二代摘要',
      'Q2',
      'Q3',
    ]);
    // 两条快照行都还在库里 (旧的可用于审计, 只是不参与投影)
    expect(rowsOf(COMPACTION_SNAPSHOT_ITEM_TYPE).length).toBe(2);
  });

  it('快照行不干扰 appendMessage 的去重指纹', () => {
    const ctx = SessionContext.get(SID);
    const s1 = ctx.appendMessage('user', '重复内容', '', Date.now());
    ctx.appendCompaction([{ role: 'user', content: '重复内容' }]);
    // 快照里有同样内容, 但它不是 message 行 —— 不该被当成"已存在", 应正常插新行
    const s2 = ctx.appendMessage('user', '压缩后的新消息', '', Date.now());
    expect(s2).toBeGreaterThan(s1);
    expect(rowsOf('message').length).toBe(2);
  });

  it('raw 字段 (tool_calls / 数组 content) 穿过快照仍能还原', () => {
    const ctx = SessionContext.get(SID);
    const toolMsg = {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_1', function: { name: 'read_file', arguments: '{}' } }],
    };
    ctx.appendCompaction([
      { role: 'system', content: '[COMPACTED] 摘要' },
      { role: 'assistant', content: '', raw: toolMsg },
    ]);

    const restored = reload().getAll();
    expect(restored[1].raw?.tool_calls?.[0]?.id).toBe('call_1');
  });

  it('pruneCompactedMessages 只在有两代快照时才删, 且保留最近一代', () => {
    const ctx = SessionContext.get(SID);
    ctx.appendMessage('user', '第一代原话', '', Date.now());
    ctx.appendCompaction([{ role: 'system', content: '[COMPACTED] 一代' }]);
    // 只有一条快照 → 无"过期一代"可删
    expect(ctx.pruneCompactedMessages()).toBe(0);
    expect(rowsOf('message').length).toBe(1);

    ctx.appendMessage('user', '第二代原话', '', Date.now());
    ctx.appendCompaction([{ role: 'system', content: '[COMPACTED] 二代' }]);
    // 两条快照 → 删掉第一条快照之前的原始行, 保留其后的
    expect(ctx.pruneCompactedMessages()).toBe(1);
    expect(rowsOf('message').map((r) => JSON.parse(r.item_data).content)).toEqual(['第二代原话']);
  });

  it('压缩快照条数封顶 —— 反复压缩不会无限堆 (每个 session 最多 MAX_SNAPSHOTS 条)', () => {
    const ctx = SessionContext.get(SID);
    for (let i = 0; i < 10; i++) {
      ctx.appendMessage('user', `第 ${i} 轮`, '', Date.now());
      /* 带上数组 content (模拟截图附件) —— 验证大载荷路径也照样封顶 */
      ctx.appendCompaction([
        { role: 'system', content: '[COMPACTED] 摘要' },
        { role: 'user', content: '', raw: { role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(1000)}` } }] } },
      ]);
    }
    const kept = rowsOf(COMPACTION_SNAPSHOT_ITEM_TYPE).length;
    expect(kept).toBe(SessionContext.maxSnapshots);
    expect(rowsOf('message').length).toBe(10);
  });

  it('快照的 content 不再重复存图片 base64 (只留文本, 结构在 raw)', () => {
    const ctx = SessionContext.get(SID);
    const dataUrl = `data:image/png;base64,${'B'.repeat(50_000)}`;
    ctx.appendCompaction([
      {
        role: 'user',
        content: '',
        raw: {
          role: 'user',
          content: [
            { type: 'text', text: '看这张图的报错' },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      },
    ]);
    const row = rowsOf(COMPACTION_SNAPSHOT_ITEM_TYPE)[0];
    const payload = JSON.parse(row.item_data);
    const msg = payload.messages[0];
    /* content 字段只有文本 —— 如果它还把整个数组 JSON.stringify 一遍, base64 会在这里出现第二份 */
    expect(msg.content).toContain('看这张图的报错');
    expect(msg.content).not.toContain('base64');
    /* 结构完整留在 raw —— 重启后 LLM 上下文一点不少 */
    expect(msg.raw.content[1].image_url.url).toBe(dataUrl);
  });

  it('开库自愈: 老库里积压的多条旧快照在 load 时被清到上限', () => {
    /* 直接往库里塞 5 条快照 (模拟改动前遗留), 再 new 一个 SessionContext 走 load() */
    const insert = raw.prepare(
      'INSERT INTO messages (session_id, seq, item_type, item_data, timestamp) VALUES (?, ?, ?, ?, ?)',
    );
    for (let i = 0; i < 5; i++) {
      insert.run(
        SID, i, COMPACTION_SNAPSHOT_ITEM_TYPE,
        JSON.stringify({ v: 1, messages: [{ role: 'system', content: `[COMPACTED] 第 ${i} 代` }], compactedAt: Date.now(), sourceCount: 1 }),
        Date.now(),
      );
    }
    insert.run(SID, 100, 'message', JSON.stringify({ role: 'user', content: '用户原话', turnId: '' }), Date.now());

    SessionContext.reset();
    const ctx = SessionContext.get(SID);
    /* 多余的 3 条被清, 只剩上限; 且投影取的是最新那条快照 */
    expect(rowsOf(COMPACTION_SNAPSHOT_ITEM_TYPE).length).toBe(SessionContext.maxSnapshots);
    expect(ctx.getAll()[0].content).toBe('[COMPACTED] 第 4 代');
  });
});
