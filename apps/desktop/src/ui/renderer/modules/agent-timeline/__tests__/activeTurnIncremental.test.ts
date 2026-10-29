/**
 * work:M-01 · 活跃轮不再每帧全量重算 —— 契约测试
 *
 * 【这条测试锁什么】
 * 活跃段 (最后一段 turn) 每帧重算时, 未变的行必须**复用同一批行对象**。这不是内部实现
 * 细节: 下游 stabilizeTimelineRows 的公共前缀短路是纯指针比较, React 的 row memo 也是按
 * 引用判等。行对象一旦每帧换新, 两处缓存全部落空 —— 活跃轮就退回"每帧全量重算"。
 *
 * 【为什么等价性要单独测】
 * 复用的前提是"每个 builder 的产物只由输入决定"。这条前提一旦被悄悄破坏 (比如某处开始
 * 读外部可变状态、或者原地改行对象), 界面上就会出现"内容不更新"或"上一帧被改写"这种
 * 最难查的问题。所以每一帧都把增量结果与**清空全部缓存后的冷启动结果**逐字段对拍。
 */
import { describe, expect, test } from 'vitest';
import { mapTimelineEntriesToRows, __resetTimelineRowCacheForTests, __resetTimelineSegmentCacheForTests } from '../mapTimelineToRows';
import { buildTimelineRows, stabilizeTimelineRows, __resetBuildSegmentCacheForTests, type Row } from '../timelineRows';
import { __resetActiveTurnRowCacheForTests } from '../activeTurnRows';
import type { TimelineEntry } from '../../../utils/workspaceUtils';

type Entries = TimelineEntry[];

function resetAll(): void {
  __resetTimelineRowCacheForTests();
  __resetTimelineSegmentCacheForTests();
  __resetBuildSegmentCacheForTests();
  __resetActiveTurnRowCacheForTests();
}

const largeText = '这是一段用来撑起正文字数的说明文字。'.repeat(20);
const diffBody = Array.from({ length: 40 }, (_, i) => `+ line ${i} const x${i} = compute(${i});`).join('\n');

/** 一轮"真实形状"的活跃轮: 用户消息 → 聚类 → 写文件 → 并行组 → 助手短评 → 更多工具 → 流式回答 */
function turn(opts: { t: number; tail?: number; streaming?: boolean }): Entries {
  const { t, tail = 0, streaming = true } = opts;
  const base = 1_700_000_000_000 + t * 10_000;
  const out: Entries = [
    { id: `u${t}`, type: 'user_message', detail: `第 ${t} 轮: 把这份表补齐`, timestamp: base } as TimelineEntry,
  ];
  /* 3 条同 head → 走 cluster */
  for (let i = 0; i < 3; i++) {
    out.push({
      id: `r${t}-${i}`, type: 'tool_call', toolName: 'read_file', title: 'read_file',
      detail: `/repo/m${t}-${i}.ts`, output: largeText, timestamp: base + 100 + i,
    } as TimelineEntry);
  }
  /* 写文件 → 高价值行, 不折进 activity */
  out.push({
    id: `ef${t}`, type: 'edit_file', toolName: 'edit_file', title: 'edit_file',
    editFilePath: `/repo/m${t}.ts`, detail: diffBody, output: diffBody,
    editHunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 40, content: diffBody }],
    timestamp: base + 200,
  } as unknown as TimelineEntry);
  /* 同一个 batchId 的两条 → 并行组行 */
  out.push({
    id: `p${t}a`, type: 'tool_call', toolName: 'grep', title: 'grep',
    detail: `pattern-${t}-a`, output: 'hit', timestamp: base + 300, batchId: `b${t}`,
  } as TimelineEntry);
  out.push({
    id: `p${t}b`, type: 'tool_call', toolName: 'grep', title: 'grep',
    detail: `pattern-${t}-b`, output: 'hit', timestamp: base + 301, batchId: `b${t}`,
  } as TimelineEntry);
  out.push({
    id: `a${t}`, type: 'assistant_message', detail: `阶段小结 ${t}`, timestamp: base + 400, messageId: `am${t}`,
  } as TimelineEntry);
  for (let i = 0; i < tail; i++) {
    out.push({
      id: `r${t}-late-${i}`, type: 'tool_call', toolName: 'read_file', title: 'read_file',
      detail: `/repo/late${t}-${i}.ts`, output: 'ok', timestamp: base + 500 + i,
    } as TimelineEntry);
  }
  out.push({
    id: `f${t}`, type: 'assistant_message', detail: streaming ? `正在写回答 ${t}…` : `回答 ${t}`,
    timestamp: base + 900, messageId: `fm${t}`, ...(streaming ? { pending: true } : {}),
  } as TimelineEntry);
  return out;
}

/** 把前面若干轮封口, 最后一轮是活跃轮 */
function session(frameTail: number[]): Entries[] {
  const frames: Entries[] = [];
  let acc: Entries = [];
  for (let t = 0; t < 3; t++) acc = acc.concat(turn({ t, streaming: false }));
  frameTail.forEach((tail, i) => {
    frames.push([...acc, ...turn({ t: 10, tail })]);
    void i;
  });
  return frames;
}

function build(entries: Entries, streaming: boolean): Row[] {
  const items = mapTimelineEntriesToRows(entries, '/repo', { sessionId: 's' });
  return buildTimelineRows(items as never, false, new Set(), true, streaming, 's');
}

describe('work:M-01 · 活跃轮尾插增量', () => {
  test('每一帧的增量结果都与冷启动逐字段一致 (聚类 / 并行组 / activity / 折叠全在)', () => {
    const frames = session([0, 1, 2, 3, 4, 5]);

    /* 增量: 连续帧之间共享缓存 —— 这正是线上形状 */
    resetAll();
    const incremental = frames.map((f) => JSON.stringify(build(f, true)));

    /* 冷启动: 每帧前清空全部缓存, 同样的输入重算一遍 */
    const cold = frames.map((f) => {
      resetAll();
      return JSON.stringify(build(f, true));
    });

    expect(incremental).toEqual(cold);
  });

  test('未变的前缀行返回同一对象 —— 这就是"不再全量重算"的可观测契约', () => {
    resetAll();
    /* 注意: 前几轮与活跃轮的前缀必须是**同一批 entry 对象** —— 输入身份变了就没有复用的前提,
     * 线上也不会变 (mapping 每帧拿到的是同一批 entry 对象)。 */
    const history = turn({ t: 0, streaming: false });
    const base = turn({ t: 12, tail: 2 });
    const lastIdx = base.length - 1;
    const lastEntry = base[lastIdx] as unknown as Record<string, unknown>;

    const first = build([...history, ...base], true);
    /* 只往流式回答里追加字符: 行数不变, 该换的只有最后一行 */
    const second = build([
      ...history,
      ...base.slice(0, lastIdx),
      { ...lastEntry, detail: `${String(lastEntry.detail ?? '')}再补一句` } as never,
    ], true);

    expect(second.length).toBe(first.length);
    for (let i = 0; i < first.length - 1; i++) expect(second[i]).toBe(first[i]);
    /* 变了的最后一行不能复用 (否则界面不更新) */
    expect(second[second.length - 1]).not.toBe(first[first.length - 1]);
  });

  test('中途插入新行时, 插入点之前的所有行仍然原样复用', () => {
    resetAll();
    const history = turn({ t: 0, streaming: false });
    const base = turn({ t: 13, tail: 0 });
    const lastEntry = base[base.length - 1]!;
    const late = Array.from({ length: 3 }, (_, i) => ({
      id: `late${i}`, type: 'tool_call', toolName: 'read_file', title: 'read_file',
      detail: `/repo/late${i}.ts`, output: 'ok', timestamp: 1_700_000_900_000 + i,
    } as TimelineEntry));

    const short = build([...history, ...base], true);
    const long = build([...history, ...base.slice(0, -1), ...late, lastEntry], true);

    let diff = 0;
    while (diff < short.length && short[diff] === long[diff]) diff++;
    /* 允许变化的只有: 插入点本身、插入的簇、末尾的流式回答, 以及插入点前那一段 activity
     * —— 后者是因为"点亮 shimmer"的那个标志从它挪到了新插入的一段 (本就该变)。 */
    expect(diff).toBeGreaterThanOrEqual(short.length - 3);
    expect(long.length).toBeGreaterThanOrEqual(short.length);
  });

  test('内容没变时整段行数组逐元素同引用 (重复映射不产生新对象)', () => {
    const frame = session([2])[0]!;
    resetAll();
    const a = build(frame, true);
    const b = build(frame, true);
    expect(b.length).toBe(a.length);
    for (let i = 0; i < a.length; i++) expect(b[i]).toBe(a[i]);
  });

  test('stabilize 只处理变动尾部: 不变时直接交回上一帧数组', () => {
    const frame = session([2])[0]!;
    resetAll();
    const first = build(frame, true);
    const second = build(frame, true);
    const stabilized = stabilizeTimelineRows(first, second);
    /* 全等 → 原样返回上一帧的数组, 下游 React 零工作 */
    expect(stabilized).toBe(first);
  });

  test('合并相邻 activity 不再原地改写上一帧的行', () => {
    /* activity → 空助手消息 → activity 会触发 merge; 中间的空消息被吞掉 */
    const base = 1_700_000_100_000;
    const mk = (tail: number): Entries => [
      { id: 'u', type: 'user_message', detail: '做点事', timestamp: base } as TimelineEntry,
      { id: 'x1', type: 'tool_call', toolName: 'read_file', title: 'read_file', detail: '/a.ts', output: 'ok', timestamp: base + 1 } as TimelineEntry,
      { id: 'x2', type: 'tool_call', toolName: 'read_file', title: 'read_file', detail: '/b.ts', output: 'ok', timestamp: base + 2 } as TimelineEntry,
      { id: 'x3', type: 'tool_call', toolName: 'read_file', title: 'read_file', detail: '/c.ts', output: 'ok', timestamp: base + 3 } as TimelineEntry,
      { id: 'em', type: 'assistant_message', detail: '', timestamp: base + 4, messageId: 'em' } as TimelineEntry,
      { id: 'y1', type: 'tool_call', toolName: 'grep', title: 'grep', detail: 'q1', output: 'ok', timestamp: base + 5 } as TimelineEntry,
      { id: 'y2', type: 'tool_call', toolName: 'grep', title: 'grep', detail: 'q2', output: 'ok', timestamp: base + 6 } as TimelineEntry,
      { id: 'y3', type: 'tool_call', toolName: 'grep', title: 'grep', detail: 'q3', output: 'ok', timestamp: base + 7 } as TimelineEntry,
      ...Array.from({ length: tail }, (_, i) => ({
        id: `z${i}`, type: 'tool_call', toolName: 'glob', title: 'glob', detail: `g${i}`, output: 'ok', timestamp: base + 10 + i,
      } as TimelineEntry)),
      { id: 'ans', type: 'assistant_message', detail: '好了', timestamp: base + 90, messageId: 'ans' } as TimelineEntry,
    ];

    resetAll();
    const firstRows = build(mk(0), true);
    const activities = firstRows.filter((r) => r.kind === 'activity');
    expect(activities.length).toBeGreaterThan(0);
    const snapshot = activities.map((r) => (r.kind === 'activity' ? r.rows.length : -1));

    build(mk(2), true);

    /* 上一帧交出去的行被后续合并改写 → 它当时记录的 rows 长度会变 */
    const after = activities.map((r) => (r.kind === 'activity' ? r.rows.length : -1));
    expect(after).toEqual(snapshot);
  });

  test('已折起的一轮不会因为 sessionStreaming 翻转被重新展开 (单调闩)', () => {
    const entries = turn({ t: 20, streaming: false });
    resetAll();
    const closed = build(entries, false);
    expect(closed.some((r) => r.kind === 'turn_fold')).toBe(true);

    /* 用户发了下一条消息、新行还没到的那个窗口: 最后一段仍是这一轮, streaming 已翻 true */
    const during = build(entries, true);
    expect(during.some((r) => r.kind === 'turn_fold')).toBe(true);
  });

  test('活跃轮 300 条工具调用: 单帧 build+stabilize 远低于 16ms 预算', () => {
    /* 活跃轮是"每来一条流式事件就整段走一遍"的路径, 所以闸门按单帧主线程预算给。
     * 阈值刻意给得宽松 (8ms ≈ 半个 60fps 帧): 这条用例要拦的是"退回每帧全量重算"的
     * 数量级回归, 不是几个百分点的抖动。 */
    const history: Entries = [];
    for (let t = 0; t < 20; t++) history.push(...turn({ t, streaming: false }));
    const active: Entries = [{ id: 'uX', type: 'user_message', detail: '开跑', timestamp: 1_700_100_000_000 } as TimelineEntry];
    for (let i = 0; i < 300; i++) {
      active.push({
        id: `p${i}`, type: 'tool_call', toolName: 'read_file', title: 'read_file',
        detail: `/repo/a${i}.ts`, output: largeText, timestamp: 1_700_100_001_000 + i,
      } as TimelineEntry);
    }

    resetAll();
    let prev = build([...history, ...active], true);
    const frameCosts: number[] = [];
    for (let i = 0; i < 20; i++) {
      const last = active[active.length - 1] as unknown as Record<string, unknown>;
      active[active.length - 1] = { ...last, output: `${largeText}${'x'.repeat(i + 1)}` } as never;
      const t0 = performance.now();
      const next = build([...history, ...active], true);
      stabilizeTimelineRows(prev, next);
      frameCosts.push(performance.now() - t0);
      prev = next;
    }
    const best = Math.min(...frameCosts.slice(5));
    expect(best).toBeLessThan(8);
  });
});
