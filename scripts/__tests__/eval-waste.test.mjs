import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { classifyWaste, extractCalls, readWasteStats } from '../eval/lib/waste.mjs';

/** 造一条 assistant 消息 (带工具调用) */
function assistant(...calls) {
  return {
    itemType: 'message',
    itemData: {
      role: 'assistant',
      content: '',
      raw: {
        role: 'assistant',
        content: '',
        tool_calls: calls.map(([id, name, args]) => ({
          id,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        })),
      },
    },
  };
}

/** 造一条 assistant 纯文本消息 */
function assistantText(text = '我看看') {
  return { itemType: 'message', itemData: { role: 'assistant', content: text, raw: { role: 'assistant', content: text } } };
}

function toolResult(id, content = 'ok') {
  return {
    itemType: 'message',
    itemData: { role: 'tool', content, raw: { role: 'tool', tool_call_id: id, content } },
  };
}

function compaction() {
  return { itemType: 'compaction_snapshot', itemData: { v: 1, messages: [] } };
}

function stats(items, runtime) {
  const trace = extractCalls(items);
  return { ...trace, ...classifyWaste(trace, runtime) };
}

test('重读同一文件计数, 写入后不再算重读', () => {
  const items = [
    assistant(['c1', 'readfile', { path: 'src/a.ts' }]),
    toolResult('c1'),
    assistant(['c2', 'readfile', { path: 'src/a.ts' }]),
    toolResult('c2'),
    /* 改过文件后再读是正常行为, 不算重读 */
    assistant(['c3', 'edit', { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }]),
    toolResult('c3'),
    assistant(['c4', 'readfile', { path: 'src/a.ts' }]),
    toolResult('c4'),
  ];
  const result = stats(items);
  assert.equal(result.buckets.reread.calls, 1);
  assert.equal(result.buckets.reread.turns, 1);
  assert.equal(result.buckets.rereadAfterCompact.calls, 0);
});

test('paths 数组里的每个文件都算重读目标', () => {
  const items = [
    assistant(['c1', 'readfile', { paths: ['src/a.ts', 'src/b.ts'] }]),
    assistant(['c2', 'readfile', { paths: ['src/a.ts', 'src/c.ts'] }]),
  ];
  const result = stats(items);
  assert.equal(result.buckets.reread.calls, 1);
});

test('压缩后重读单独成桶, 不重复计入重读', () => {
  const items = [
    assistant(['c1', 'readfile', { path: 'src/a.ts' }]),
    toolResult('c1'),
    compaction(),
    assistant(['c2', 'readfile', { path: 'src/a.ts' }]),
    toolResult('c2'),
  ];
  const result = stats(items);
  assert.equal(result.compactions, 1);
  assert.equal(result.buckets.reread.calls, 0);
  assert.equal(result.buckets.rereadAfterCompact.calls, 1);
  assert.equal(result.buckets.rereadAfterCompact.turns, 1);
});

test('穷举: 同一搜索区域第 3 次调用算, 参数完全相同的重复也算', () => {
  const items = [
    assistant(['c1', 'search', { pattern: 'foo', path: 'src' }]),
    assistant(['c2', 'search', { pattern: 'bar', path: 'src' }]),
    assistant(['c3', 'search', { pattern: 'baz', path: 'src' }]),
    /* 第 4 次与第 1 次参数完全相同 = 原地重试, 只算一次穷举 */
    assistant(['c4', 'search', { pattern: 'foo', path: 'src' }]),
  ];
  const result = stats(items);
  /* c3 (同区域第 3 次) + c4 (完全重复) = 2; c1/c2 是正常探索 */
  assert.equal(result.buckets.exhaustive.calls, 2);
  assert.equal(result.buckets.exhaustive.turns, 2);
});

test('穷举: 不同搜索区域不会互相累加', () => {
  const items = [
    assistant(['c1', 'search', { pattern: 'foo', path: 'src/a' }]),
    assistant(['c2', 'search', { pattern: 'foo', path: 'src/b' }]),
    assistant(['c3', 'search', { pattern: 'foo', path: 'src/c' }]),
  ];
  const result = stats(items);
  assert.equal(result.buckets.exhaustive.calls, 0);
});

test('穷举: shell 同一命令族第 3 次算', () => {
  const items = [
    assistant(['c1', 'execute_shell', { command: 'node check.mjs foo' }]),
    assistant(['c2', 'execute_shell', { command: 'node check.mjs bar' }]),
    assistant(['c3', 'execute_shell', { command: 'node check.mjs baz' }]),
  ];
  const result = stats(items);
  assert.equal(result.buckets.exhaustive.calls, 1);
});

test('空转: 没有工具调用且后面还有 assistant 消息的轮次', () => {
  const items = [
    assistantText('我再想想'),
    assistant(['c1', 'readfile', { path: 'src/a.ts' }]),
    toolResult('c1'),
    assistant('最终答案'),
  ];
  const result = stats(items);
  assert.equal(result.buckets.idle.turns, 1);
  assert.equal(result.idleSource, 'messages');
  assert.equal(result.wasteTurns, 1);
});

test('空转: 最后一条纯文本消息是收尾回答, 不算空转', () => {
  const items = [
    assistant(['c1', 'readfile', { path: 'src/a.ts' }]),
    toolResult('c1'),
    assistant('完成'),
  ];
  const result = stats(items);
  assert.equal(result.buckets.idle.turns, 0);
  assert.equal(result.wasteTurns, 0);
});

test('空转: 有 runtime 的 waste_json 汇总时优先用它', () => {
  const items = [assistantText('嗯'), assistant(['c1', 'readfile', { path: 'src/a.ts' }])];
  const result = stats(items, { idleTurns: 3 });
  assert.equal(result.buckets.idle.turns, 3);
  assert.equal(result.idleSource, 'waste_json');
  assert.equal(result.wasteTurns, 3);
});

test('没有任何调用时返回全 0, 不产生 NaN', () => {
  const result = classifyWaste({ turns: [], calls: [], compactions: 0 });
  assert.equal(result.turns, 0);
  assert.equal(result.wasteTurns, 0);
  assert.equal(result.wasteRate, 0);
  assert.equal(result.buckets.reread.calls, 0);
});

test('readWasteStats: 从真实会话库读出工具调用、压缩和运行时空转', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = mkdtempSync(join(tmpdir(), 'eval-waste-db-'));
  const dbPath = join(dir, 'neox.db');
  try {
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        item_type TEXT NOT NULL,
        item_data TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );
      CREATE TABLE agent_turn_metrics (id TEXT PRIMARY KEY, waste_json TEXT);
    `);
    let seq = 0;
    const insert = (itemType, payload) => {
      db.prepare('INSERT INTO messages (session_id, seq, item_type, item_data, timestamp) VALUES (?, ?, ?, ?, ?)')
        .run('s1', seq++, itemType, JSON.stringify(payload), Date.now());
    };
    const call = (id, name, args) => ({
      role: 'assistant',
      content: '',
      raw: { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
    });

    insert('message', call('c1', 'readfile', { path: 'src/a.ts' }));
    insert('message', call('c2', 'readfile', { path: 'src/a.ts' }));
    insert('compaction_snapshot', { v: 1 });
    insert('message', call('c3', 'readfile', { path: 'src/a.ts' }));
    db.prepare('INSERT INTO agent_turn_metrics (id, waste_json) VALUES (?, ?)')
      .run('w1', JSON.stringify({ noToolGuardFollowups: 2, noToolFinalizeContinues: 1, progressGateTriggers: 0 }));
    db.close();

    const result = await readWasteStats(dbPath);
    assert.equal(result.turns, 3);
    assert.equal(result.toolCalls, 3);
    assert.equal(result.buckets.reread.calls, 1);
    assert.equal(result.buckets.rereadAfterCompact.calls, 1);
    assert.equal(result.buckets.idle.turns, 3);
    assert.equal(result.idleSource, 'waste_json');
    assert.match(result.source, /agent_turn_metrics/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
