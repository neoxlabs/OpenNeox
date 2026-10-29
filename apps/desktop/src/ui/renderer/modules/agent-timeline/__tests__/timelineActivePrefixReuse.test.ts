import { describe, expect, test } from 'vitest';
import { mapTimelineEntriesToRows, __resetTimelineRowCacheForTests, __resetTimelineSegmentCacheForTests } from '../mapTimelineToRows';
import { buildTimelineRows, stabilizeTimelineRows, __resetBuildSegmentCacheForTests, type Row } from '../timelineRows';
import { __resetActiveTurnRowCacheForTests } from '../activeTurnRows';
import type { TimelineEntry } from '../../../utils/workspaceUtils';

type Entries = TimelineEntry[];
type Shape = 'same-head' | 'mixed' | 'messages' | 'edits';

function resetAll(): void {
  __resetTimelineRowCacheForTests();
  __resetTimelineSegmentCacheForTests();
  __resetBuildSegmentCacheForTests();
  __resetActiveTurnRowCacheForTests();
}

const largeText = '这是一段用来撑起正文字数的说明文字。'.repeat(20);
const diffBody = Array.from({ length: 40 }, (_, i) => `+ line ${i} const x${i} = compute(${i});`).join('\n');
const BASE_TS = 1_700_100_000_000;

/** 一轮活跃 turn 的四种线上形状 —— 覆盖单一大簇 / 混杂工具 / 消息穿插 / 大量独立 diff 行 */
function activeTurn(shape: Shape, n: number): Entries {
  const out: Entries = [{ id: 'uX', type: 'user_message', detail: '把这份表补齐', timestamp: BASE_TS } as TimelineEntry];
  for (let i = 0; i < n; i++) {
    const ts = BASE_TS + 1_000 + i;
    if (shape === 'same-head') {
      out.push({ id: `p${i}`, type: 'tool_call', toolName: 'read_file', title: 'read_file', detail: `/repo/a${i}.ts`, output: largeText, timestamp: ts } as TimelineEntry);
      continue;
    }
    if (shape === 'mixed') {
      const kind = i % 4;
      const tool = ['read_file', 'grep', 'glob', 'shell'][kind]!;
      out.push({ id: `p${i}`, type: 'tool_call', toolName: tool, title: tool, detail: `${tool}-${i}`, output: kind === 1 ? 'hit' : largeText, timestamp: ts } as TimelineEntry);
      continue;
    }
    if (shape === 'messages') {
      if (i % 3 === 0) {
        out.push({ id: `p${i}`, type: 'tool_call', toolName: 'read_file', title: 'read_file', detail: `/repo/a${i}.ts`, output: largeText, timestamp: ts } as TimelineEntry);
      } else {
        out.push({ id: `am${i}`, type: 'assistant_message', detail: `阶段 ${i} ${largeText}`, timestamp: ts, messageId: `am${i}` } as TimelineEntry);
      }
      continue;
    }
    out.push({
      id: `e${i}`, type: 'edit_file', toolName: 'edit_file', title: 'edit_file',
      editFilePath: `/repo/e${i}.ts`, detail: diffBody, output: diffBody,
      editHunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 40, content: diffBody }],
      timestamp: ts,
    } as unknown as TimelineEntry);
  }
  return out;
}

function mapEntries(entries: Entries): unknown {
  return mapTimelineEntriesToRows(entries, '/repo', { sessionId: 's' });
}

function buildRows(entries: Entries, minimal = false): Row[] {
  return buildTimelineRows(mapEntries(entries) as never, minimal, new Set(), !minimal, true, 's');
}

/** 只改尾部那条 entry —— 流式正文追加 / 最新工具卡刷新时的真实形状 */
function rewriteTail(entries: Entries, suffix: string): Entries {
  const next = entries.slice();
  const last = next[next.length - 1] as unknown as Record<string, unknown>;
  next[next.length - 1] = {
    ...last,
    detail: `${String(last.detail ?? '')}${suffix}`,
    output: `${String(last.output ?? '')}${suffix}`,
  } as never;
  return next;
}

const median = (values: number[]): number => {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};
const pct = (values: number[], p: number): number => {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
};

function firstDiffIndex(a: Row[], b: Row[]): number {
  const min = Math.min(a.length, b.length);
  let i = 0;
  while (i < min && a[i] === b[i]) i++;
  return i;
}

describe('code:TIMELINE-01 · 活跃 turn 前缀复用', () => {
  test('验收: 活跃 turn 300 条时每帧 map+build+stabilize 中位数 ≤2ms', () => {
    for (const shape of ['same-head', 'mixed', 'messages', 'edits'] as Shape[]) {
      resetAll();
      const active = activeTurn(shape, 300);
      let prev = buildRows(active);
      /* 预热: 建缓存 + JIT, 不计入样本 */
      for (let i = 0; i < 5; i++) {
        prev = stabilizeTimelineRows(prev, buildRows(rewriteTail(active, `w${i}`)));
      }

      const costs: number[] = [];
      for (let i = 0; i < 30; i++) {
        const frameEntries = rewriteTail(active, `t${i}`);
        const t0 = performance.now();
        const next = buildRows(frameEntries);
        const stabilized = stabilizeTimelineRows(prev, next);
        costs.push(performance.now() - t0);
        prev = stabilized;
      }

      /* 中位数判算法; p90 只拦数量级回归 (单帧 GC 不算回归) */
      expect(median(costs), `${shape} 每帧中位成本`).toBeLessThanOrEqual(2);
      expect(pct(costs, 0.9), `${shape} 每帧 p90 成本`).toBeLessThanOrEqual(10);
    }
  });

  test('正确性: 300 条活跃 turn 的增量结果与冷启动逐字段一致 (四种形状)', () => {
    for (const shape of ['same-head', 'mixed', 'messages', 'edits'] as Shape[]) {
      resetAll();
      const frames: Entries[] = [];
      let acc = activeTurn(shape, 300);
      for (let i = 0; i < 6; i++) {
        acc = rewriteTail(acc, `#${i}`);
        frames.push(acc);
      }

      /* 增量: 连续帧之间共享缓存 —— 线上形状 */
      resetAll();
      const incremental = frames.map((f) => JSON.stringify(buildRows(f)));

      /* 冷启动: 每帧前清空全部缓存, 同一输入重算 */
      const cold = frames.map((f) => {
        resetAll();
        return JSON.stringify(buildRows(f));
      });

      expect(incremental, shape).toEqual(cold);
    }
  });

  test('正确性: Work 极简模式同样与冷启动一致', () => {
    const frames: Entries[] = [];
    let acc = activeTurn('mixed', 120);
    for (let i = 0; i < 4; i++) {
      acc = rewriteTail(acc, `#w${i}`);
      frames.push(acc);
    }

    resetAll();
    const incremental = frames.map((f) => JSON.stringify(buildRows(f, true)));
    const cold = frames.map((f) => {
      resetAll();
      return JSON.stringify(buildRows(f, true));
    });
    expect(incremental).toEqual(cold);
  });

  test('契约: 尾部追加新工具事件只影响最后一行 (聚合不回溯前缀)', () => {
    for (const shape of ['same-head', 'mixed', 'messages', 'edits'] as Shape[]) {
      resetAll();
      const base = activeTurn(shape, 300);
      const before = buildRows(base);
      const appended = [
        ...base,
        {
          id: 'tail-new', type: 'tool_call', toolName: 'read_file', title: 'read_file',
          detail: '/repo/tail-new.ts', output: 'ok', timestamp: BASE_TS + 9_000,
        } as TimelineEntry,
      ];
      const after = buildRows(appended);

      /* 前缀逐元素同引用; 允许变化的只有尾部那一段 (簇 / activity / 新行本身) */
      expect(firstDiffIndex(before, after), `${shape} 首处变化位置`)
        .toBeGreaterThanOrEqual(before.length - 2);
      expect(after.length).toBeGreaterThanOrEqual(before.length);
      expect(after.length).toBeLessThanOrEqual(before.length + 2);
    }
  });

  test('契约: 改写尾部正文时前缀行原样复用', () => {
    for (const shape of ['same-head', 'mixed', 'messages', 'edits'] as Shape[]) {
      resetAll();
      const base = activeTurn(shape, 300);
      const before = buildRows(base);
      const after = buildRows(rewriteTail(base, '再补一句'));

      expect(after.length, shape).toBe(before.length);
      expect(firstDiffIndex(before, after), `${shape} 首处变化位置`)
        .toBeGreaterThanOrEqual(before.length - 1);
      /* 变了的最后一行必须换新, 否则界面不更新 */
      expect(after[after.length - 1]).not.toBe(before[before.length - 1]);
    }
  });

  test('契约成立的前提: 空助手消息两侧的 activity 会合并 —— 变化范围仍不超过尾部两行', () => {
    /* 这是 aggregation 跨消息的唯一一种情况 (collapseActivityRuns 的 merge)。
     * 把它的依赖范围钉成 ≤2 行: 前缀复用 / 分段缓存都以这个上界为前提。 */
    resetAll();
    const base: Entries = [
      { id: 'u1', type: 'user_message', detail: '做事', timestamp: BASE_TS } as TimelineEntry,
      ...Array.from({ length: 3 }, (_, i) => ({
        id: `r${i}`, type: 'tool_call', toolName: 'read_file', title: 'read_file',
        detail: `/repo/r${i}.ts`, output: 'ok', timestamp: BASE_TS + 1 + i,
      } as TimelineEntry)),
      { id: 'blank', type: 'assistant_message', detail: '', timestamp: BASE_TS + 10, messageId: 'blank' } as TimelineEntry,
    ];
    const before = buildRows(base);
    const after = buildRows([
      ...base,
      { id: 'r9', type: 'tool_call', toolName: 'grep', title: 'grep', detail: 'q', output: 'hit', timestamp: BASE_TS + 20 } as TimelineEntry,
    ]);

    const diff = firstDiffIndex(before, after);
    expect(diff).toBeGreaterThanOrEqual(before.length - 2);
    /* 空消息被合并吞掉 —— 这正是"只能回溯到前一个 activity"的原因 */
    expect(after.length).toBeLessThanOrEqual(before.length + 1);
  });
});
