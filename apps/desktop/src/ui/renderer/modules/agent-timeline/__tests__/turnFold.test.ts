import { describe, test, expect } from 'vitest';
import { buildTimelineRows, __resetBuildSegmentCacheForTests } from '../timelineRows';
import type { Row } from '../timelineRows';

function msg(id: string, role: 'user' | 'assistant', text: string) {
  return { kind: 'message', id, role, text, timestamp: new Date(1700000000000).toISOString() } as never;
}
function tool(id: string, title: string, extra: Record<string, unknown> = {}) {
  return { kind: 'tool', id, title, iconKind: 'read', status: 'done', ...extra } as never;
}
function edit(id: string, file: string, add: number, del: number) {
  return {
    kind: 'tool', id, title: `写入文件 · ${file}`, iconKind: 'edit', status: 'done',
    content: { type: 'diff', file, addCount: add, delCount: del, lines: [] },
  } as never;
}

/** 默认按"会话正在跑"来构建 —— 保持老用例原本的语义 (最后一轮是活跃 turn) */
const build = (items: unknown[], streaming = true) =>
  buildTimelineRows(items as never, false, new Set(), true, streaming);

const foldsOf = (rows: Row[]) => rows.filter(r => r.kind === 'turn_fold') as Array<Extract<Row, { kind: 'turn_fold' }>>;

describe('turn_fold', () => {
  test('活跃 turn 不折, 封口 turn 折', () => {
    __resetBuildSegmentCacheForTests();
    const turn = (n: number) => [
      msg(`u${n}`, 'user', `第 ${n} 轮`),
      tool(`t${n}a`, 'read_file · a.ts'),
      tool(`t${n}b`, 'grep · x'),
      tool(`t${n}c`, 'read_file · b.ts'),
      msg(`a${n}`, 'assistant', `第 ${n} 轮结论`),
    ];

    /* 只有一轮 = 它就是活跃 turn */
    const one = build(turn(1));
    expect(foldsOf(one)).toHaveLength(0);

    /* 第二轮到达 → 第一轮封口, 必须折; 第二轮仍是活跃 turn, 不折 */
    const two = build([...turn(1), ...turn(2)]);
    const folds = foldsOf(two);
    expect(folds).toHaveLength(1);
    expect(folds[0]!.id).toBe('turnfold-u1');
    /* 用户消息和结论都必须留在外面 */
    const kinds = two.map(r => r.kind);
    expect(kinds[0]).toBe('message');
    expect(kinds[1]).toBe('turn_fold');
    expect(kinds[2]).toBe('message');
  });

  test('段从活跃变封口时会重算 (缓存不能把未折叠状态钉死)', () => {
    __resetBuildSegmentCacheForTests();
    const t1 = [
      msg('u1', 'user', '一'),
      tool('x1', 'read_file · a.ts'),
      tool('x2', 'read_file · b.ts'),
      tool('x3', 'grep · q'),
      msg('a1', 'assistant', '结论一'),
    ];
    /* 先以"活跃"身份算一遍并进缓存 */
    expect(foldsOf(build(t1))).toHaveLength(0);

    /* 同样的对象身份追加新一轮 —— 第一段输入区间完全没变。
     * 缓存若只比对象身份就会复用那份未折叠结果。 */
    const t2 = [...t1, msg('u2', 'user', '二'), tool('y1', 'read_file · c.ts'), msg('a2', 'assistant', '结论二')];
    expect(foldsOf(build(t2))).toHaveLength(1);
  });

  test('统计: 操作数 / 文件数 / 增删行', () => {
    __resetBuildSegmentCacheForTests();
    const rows = build([
      msg('u1', 'user', '改几个文件'),
      edit('e1', 'a.ts', 10, 3),
      edit('e2', 'b.ts', 5, 1),
      tool('t1', 'run_shell_command · npm test'),
      msg('a1', 'assistant', '改完了'),
      msg('u2', 'user', '下一轮'),
      msg('a2', 'assistant', '好'),
    ]);
    const f = foldsOf(rows)[0]!;
    expect(f.fileCount).toBe(2);
    expect(f.addCount).toBe(15);
    expect(f.delCount).toBe(4);
    expect(f.hasFailure).toBe(false);
    expect(f.opCount).toBeGreaterThanOrEqual(3);
  });

  test('这一轮有失败 → 整轮不折叠, 错误直接可见', () => {
    __resetBuildSegmentCacheForTests();
    const rows = build([
      msg('u1', 'user', '改几个文件'),
      edit('e1', 'a.ts', 10, 3),
      tool('t1', 'run_shell_command · npm test', { status: 'failed' }),
      msg('a1', 'assistant', '没跑成'),
      msg('u2', 'user', '下一轮'),
      msg('a2', 'assistant', '好'),
    ]);
    expect(foldsOf(rows)).toHaveLength(0);
  });

  /* 反向锁: 同样的形状, 工具跑成了就照常折 —— 否则"失败不折"很容易被写成"一律不折",
   * 长会话会退回满屏展开。「抖了一下但恢复了」的轮次也走这一支: settleTurnErrorEntries
   * 在本轮最终跑成时会删掉 runner_error 条目, hasFailure 随之变 false。 */
  test('这一轮全成功 → 照常折叠', () => {
    __resetBuildSegmentCacheForTests();
    const rows = build([
      msg('u1', 'user', '改几个文件'),
      edit('e1', 'a.ts', 10, 3),
      tool('t1', 'run_shell_command · npm test'),
      msg('a1', 'assistant', '改完了'),
      msg('u2', 'user', '下一轮'),
      msg('a2', 'assistant', '好'),
    ]);
    expect(foldsOf(rows)).toHaveLength(1);
  });

  test('时长来自 step.startedAtMs 跨度, 不是 message.timestamp', () => {
    __resetBuildSegmentCacheForTests();
    const base = 1700000000000;
    const rows = build([
      { kind: 'message', id: 'u1', role: 'user', text: '干活', timestamp: '20:31' },
      { kind: 'tool', id: 't1', title: 'read_file · a.ts', iconKind: 'read', status: 'done', startedAtMs: base },
      { kind: 'tool', id: 't2', title: 'read_file · b.ts', iconKind: 'read', status: 'done', startedAtMs: base + 65_000 },
      { kind: 'tool', id: 't3', title: 'grep · q', iconKind: 'read', status: 'done', startedAtMs: base + 125_000 },
      { kind: 'message', id: 'a1', role: 'assistant', text: '好了', timestamp: '20:33' },
      { kind: 'message', id: 'u2', role: 'user', text: '下一轮' },
      { kind: 'message', id: 'a2', role: 'assistant', text: '嗯' },
    ]);
    const f = foldsOf(rows)[0]!;
    expect(f.durationMs).toBe(125_000);
  });

  test('重试之间的长空档不算"已工作" (跨尝试跨度会把发呆时间算进去)', () => {
    __resetBuildSegmentCacheForTests();
    const base = 1700000000000;
    const IDLE = 5 * 60_000;            /* 两次尝试之间干等 5 分钟 */
    const rows = build([
      { kind: 'message', id: 'u1', role: 'user', text: '干活', timestamp: '20:31' },
      /* 第一次尝试: 10 秒 */
      { kind: 'tool', id: 't1', title: 'read_file · a.ts', iconKind: 'read', status: 'done', startedAtMs: base },
      { kind: 'tool', id: 't2', title: 'grep · x', iconKind: 'read', status: 'done', startedAtMs: base + 10_000 },
      /* —— 失败, 用户发呆 5 分钟后点重试 —— */
      /* 第二次尝试: 20 秒 */
      { kind: 'tool', id: 't3', title: 'read_file · b.ts', iconKind: 'read', status: 'done', startedAtMs: base + 10_000 + IDLE },
      { kind: 'tool', id: 't4', title: 'grep · y', iconKind: 'read', status: 'done', startedAtMs: base + 30_000 + IDLE },
      { kind: 'message', id: 'a1', role: 'assistant', text: '好了', timestamp: '20:38' },
      { kind: 'message', id: 'u2', role: 'user', text: '下一轮' },
      { kind: 'message', id: 'a2', role: 'assistant', text: '嗯' },
    ]);
    const f = foldsOf(rows)[0]!;
    /* 10s + 20s = 30s, 不是 5 分 30 秒 */
    expect(f.durationMs).toBe(30_000);
    /* 变异闸: 老口径 (整段跨度) 会得到 IDLE + 30s, 这条断言必须把它挡住 */
    expect(f.durationMs).toBeLessThan(IDLE);
  });

  test('中段没有工具调用就不折 (折了只是把内容藏起来)', () => {
    __resetBuildSegmentCacheForTests();
    const rows = build([
      msg('u1', 'user', '你好'),
      msg('a1', 'assistant', '你好'),
      msg('u2', 'user', '再见'),
      msg('a2', 'assistant', '再见'),
    ]);
    expect(foldsOf(rows)).toHaveLength(0);
  });
});

describe('turn_fold · 跑完就折', () => {
  const turn = (n: number) => [
    msg(`u${n}`, 'user', `第 ${n} 轮`),
    tool(`t${n}a`, 'read_file · a.ts'),
    tool(`t${n}b`, 'grep · x'),
    msg(`a${n}`, 'assistant', `第 ${n} 轮结论`),
  ];

  test('单轮会话: 跑着不折, 跑完就折', () => {
    __resetBuildSegmentCacheForTests();
    expect(foldsOf(build(turn(1), true))).toHaveLength(0);

    __resetBuildSegmentCacheForTests();
    const done = build(turn(1), false);
    const folds = foldsOf(done);
    expect(folds).toHaveLength(1);
    expect(folds[0]!.id).toBe('turnfold-u1');
    /* 用户输入和结论仍留在外面 —— 折的只是中间的工作 */
    expect(done.map(r => r.kind)).toEqual(['message', 'turn_fold', 'message']);
  });

  test('已折起的轮次不因 streaming 翻 true 而重新展开 (发新消息那一帧的竞态)', () => {
    __resetBuildSegmentCacheForTests();
    const items = turn(1);

    expect(foldsOf(build(items, false)), '跑完 → 折起').toHaveLength(1);
    /* 用户按下发送: streaming 先翻 true, 新 user 行还没到 */
    expect(foldsOf(build(items, true)), '这一帧不许展开').toHaveLength(1);
    /* 新 user 行到达 —— 上一轮不再是最后一段, 当然还是折着 */
    expect(foldsOf(build([...items, msg('u2', 'user', '第二轮')], true))
      .map(f => f.id)).toEqual(['turnfold-u1']);
  });

  test('从没折起过的活跃轮次不受闩影响 (中途 agent 说完一段话又继续调工具)', () => {
    __resetBuildSegmentCacheForTests();
    const items = turn(1);
    /* 全程 streaming: 一次都没折过, 闩不该无中生有 */
    expect(foldsOf(build(items, true))).toHaveLength(0);
    expect(foldsOf(build(items, true))).toHaveLength(0);
  });

  test('多轮会话跑完: 每一轮都折, 一条不剩', () => {
    __resetBuildSegmentCacheForTests();
    const rows = build([...turn(1), ...turn(2), ...turn(3)], false);
    expect(foldsOf(rows).map(f => f.id)).toEqual(['turnfold-u1', 'turnfold-u2', 'turnfold-u3']);
  });

  test('同一段: streaming 翻 false 后必须重新算出折叠 (不能被缓存钉死)', () => {
    __resetBuildSegmentCacheForTests();
    const items = turn(1);
    expect(foldsOf(build(items, true))).toHaveLength(0);
    /* 输入区间一个字没变, 只有 streaming 变了 —— 最后一段每帧重算, 所以必须跟上 */
    expect(foldsOf(build(items, false))).toHaveLength(1);
  });

  test('等审批时绝不折 —— 否则"同意"按钮被折没了', () => {
    __resetBuildSegmentCacheForTests();
    /* streaming 在等审批 / ask_user 期间会翻 false。只看 streaming 的话这一轮会被折起来,
     * 而用户正等着点那张待审改动卡。 */
    const waiting = [
      msg('u1', 'user', '改一下 mod01.ts'),
      tool('t1', 'read_file · mod01.ts'),
      tool('t2', '写入文件 · mod01.ts', { status: 'pending' }),
    ];
    expect(foldsOf(build(waiting, false))).toHaveLength(0);

    /* 落定之后 (没有 pending 了) 才折 */
    __resetBuildSegmentCacheForTests();
    const settled = [
      msg('u1', 'user', '改一下 mod01.ts'),
      tool('t1', 'read_file · mod01.ts'),
      edit('t2', 'mod01.ts', 19, 1),
      msg('a1', 'assistant', '改好了'),
    ];
    const folds = foldsOf(build(settled, false));
    expect(folds).toHaveLength(1);
    expect(folds[0]!.addCount).toBe(19);
    expect(folds[0]!.delCount).toBe(1);
  });

  test('running 的 step 也算活跃 (工具还在跑就不能折)', () => {
    __resetBuildSegmentCacheForTests();
    const running = [
      msg('u1', 'user', '跑个命令'),
      tool('t1', 'read_file · a.ts'),
      tool('t2', 'run_command · npm test', { status: 'running' }),
    ];
    expect(foldsOf(build(running, false))).toHaveLength(0);
  });
});

describe('turn_fold · 结论必须留在外面', () => {
  const summary = (id: string) => ({
    kind: 'tool', id, title: '本轮改动', iconKind: 'edit', status: 'done',
    content: { type: 'turn_summary', files: [] },
  } as never);

  test('结论后面挂着 turn_summary 时, 回复仍然留在折叠外', () => {
    __resetBuildSegmentCacheForTests();
    const rows = build([
      msg('u1', 'user', '整理 14 个模块'),
      tool('t1', 'read_file · mod01.ts'),
      tool('t2', 'read_file · mod02.ts'),
      edit('t3', 'report.md', 19, 1),
      msg('a1', 'assistant', '14 个模块的 SPEC 已汇总到 report.md'),
      summary('s1'),
    ], false);

    /* 结论必须还在, 而且是 message 行 —— 不能被折进 turn_fold */
    const texts = rows
      .filter(r => r.kind === 'message')
      .map(r => (r as Extract<Row, { kind: 'message' }>).message.text);
    expect(texts).toContain('14 个模块的 SPEC 已汇总到 report.md');

    expect(foldsOf(rows)).toHaveLength(1);
    /* 折进去的只能是过程, 不能含最终回复 */
    const foldedTexts = JSON.stringify(foldsOf(rows)[0]!.rows);
    expect(foldedTexts).not.toContain('SPEC 已汇总');
  });

  test('多条连续结论 + 尾部 turn_summary: 结论整段都留在外面', () => {
    __resetBuildSegmentCacheForTests();
    const rows = build([
      msg('u1', 'user', '干活'),
      tool('t1', 'read_file · a.ts'),
      tool('t2', 'grep · x'),
      msg('a1', 'assistant', '第一段结论'),
      msg('a2', 'assistant', '第二段结论'),
      summary('s1'),
    ], false);
    const texts = rows
      .filter(r => r.kind === 'message')
      .map(r => (r as Extract<Row, { kind: 'message' }>).message.text);
    expect(texts).toContain('第一段结论');
    expect(texts).toContain('第二段结论');
    expect(foldsOf(rows)).toHaveLength(1);
  });

  test('一轮里根本没有 assistant 回复时, 不能把全部内容折没', () => {
    __resetBuildSegmentCacheForTests();
    /* 被中断的一轮就是这个形状: 只有工具, 没有结论。折是可以折的,
     * 但用户输入必须还在, 否则这一轮在页面上等于消失。 */
    const rows = build([
      msg('u1', 'user', '跑一下'),
      tool('t1', 'read_file · a.ts'),
      tool('t2', 'grep · x'),
    ], false);
    expect(rows[0]!.kind).toBe('message');
    expect(foldsOf(rows)).toHaveLength(1);
  });
});

describe('富结果卡不被折叠', () => {
  const card = (id: string) => ({
    kind: 'tool', id, title: '查天气', iconKind: 'read', status: 'done',
    content: { type: 'neox_card', kind: 'weather', body: '{"current":{}}' },
  } as never);

  test('封口 turn: 卡片留在折叠外, 过程仍被折起来', () => {
    __resetBuildSegmentCacheForTests();
    const rows = build([
      msg('u1', 'user', '蚌埠天气'),
      tool('t1', 'web_search · 天气'),
      card('c1'),
      msg('a1', 'assistant', '今天阴 28°'),
      msg('u2', 'user', '下一轮'),
    ], false);
    expect(foldsOf(rows)).toHaveLength(1);
    /* 卡片这一行必须还在顶层 rows 里 (不在 fold.rows 里) */
    const topCard = rows.find(r => r.kind === 'single'
      && (r as Extract<Row, { kind: 'single' }>).step
      && JSON.stringify(r).includes('neox_card'));
    expect(topCard).toBeTruthy();
    expect(JSON.stringify(foldsOf(rows)[0]!.rows)).not.toContain('neox_card');
  });

  test('顺序不乱: 折叠行在前, 卡片在后, 结论仍在最后', () => {
    __resetBuildSegmentCacheForTests();
    const rows = build([
      msg('u1', 'user', '蚌埠天气'),
      tool('t1', 'web_search · 天气'),
      card('c1'),
      msg('a1', 'assistant', '今天阴 28°'),
      msg('u2', 'user', '下一轮'),
    ], false);
    const idxFold = rows.findIndex(r => r.kind === 'turn_fold');
    const idxCard = rows.findIndex(r => JSON.stringify(r).includes('neox_card'));
    const idxAnswer = rows.findIndex(r => r.kind === 'message'
      && (r as Extract<Row, { kind: 'message' }>).message.text === '今天阴 28°');
    expect(idxFold).toBeGreaterThan(-1);
    expect(idxCard).toBeGreaterThan(idxFold);
    expect(idxAnswer).toBeGreaterThan(idxCard);
  });

  test('整段只有卡片时不折 —— 折了就只剩一个空壳', () => {
    __resetBuildSegmentCacheForTests();
    const rows = build([
      msg('u1', 'user', '蚌埠天气'),
      card('c1'),
      msg('a1', 'assistant', '今天阴 28°'),
      msg('u2', 'user', '下一轮'),
    ], false);
    expect(foldsOf(rows)).toHaveLength(0);
    expect(JSON.stringify(rows)).toContain('neox_card');
  });
});
