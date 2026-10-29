/**
 * 增量映射缓存的等价性对拍。
 *
 * 契约: 缓存命中路径产出的 TimelineItem[] 必须与冷启动逐条重算**逐字段一致**,
 * 并且未变 entry 必须返回**同一个对象引用** (下游 timelineRows 的签名 WeakMap 靠它命中)。
 */
import { describe, expect, test } from 'vitest';
import {
  mapTimelineEntries,
  __resetTimelineMapCacheForTests,
  __resetFormatClockCacheForTests,
} from '../mapTimeline';
import type { TimelineEntry } from '../../../utils/workspaceUtils';

function corpus(nTurns: number): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  let ts = Date.now() - nTurns * 10 * 60_000;
  const diff = Array.from({ length: 8 }, (_, i) => `+ line ${i}`).join('\n');
  for (let t = 0; t < nTurns; t++) {
    out.push({ id: `u${t}`, type: 'user_message', detail: `第 ${t} 步`, timestamp: ts++ } as TimelineEntry);
    out.push({ id: `th${t}`, type: 'thinking', detail: `思考 ${t}`, timestamp: ts++ } as TimelineEntry);
    /* 同 batchId 两条 → 触发 groupId/groupLabel 副作用路径 */
    out.push({ id: `p${t}a`, type: 'tool_call', toolName: 'read_file', title: 'read_file', detail: `/r/a${t}.ts`, output: 'x', timestamp: ts++, batchId: `b${t}` } as TimelineEntry);
    out.push({ id: `p${t}b`, type: 'tool_call', toolName: 'grep', title: 'grep', detail: `q${t}`, output: 'y', timestamp: ts++, batchId: `b${t}` } as TimelineEntry);
    out.push({ id: `ef${t}`, type: 'edit_file', toolName: 'edit_file', title: 'edit_file', editFilePath: `/r/a${t}.ts`, detail: diff, output: diff, editHunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 8, content: diff }], timestamp: ts++ } as unknown as TimelineEntry);
    out.push({ id: `sum${t}`, type: 'turn_summary', summaryTurnId: `u${t}`, summaryChanges: [{ path: `/r/a${t}.ts`, op: 'edit', addCount: 8, delCount: 0 }], timestamp: ts++ } as unknown as TimelineEntry);
    out.push({ id: `a${t}`, type: 'assistant_message', detail: `回答 ${t}`, timestamp: ts++, messageId: `m${t}` } as TimelineEntry);
  }
  return out;
}

/** 冷算一遍 (清缓存) */
function cold(entries: TimelineEntry[]) {
  __resetTimelineMapCacheForTests();
  return mapTimelineEntries(entries, '/r');
}

describe('增量映射缓存 — 等价性', () => {
  test('连续映射同一批 entry: 结果逐字段一致', () => {
    __resetFormatClockCacheForTests();
    const entries = corpus(12);
    const first = cold(entries);
    const second = mapTimelineEntries(entries, '/r'); // 走缓存
    const third = mapTimelineEntries(entries, '/r');
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(JSON.stringify(third)).toBe(JSON.stringify(first));
  });

  test('未变 entry 返回同一对象引用 (下游签名缓存靠它)', () => {
    const entries = corpus(10);
    cold(entries);
    const a = mapTimelineEntries(entries, '/r');
    const b = mapTimelineEntries(entries, '/r');
    let same = 0;
    for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
    /* turn_summary 不缓存, 其余都该同引用 */
    expect(same).toBeGreaterThan(a.length * 0.75);
  });

  test('流式: 只改最后一条, 结果与全量冷算一致', () => {
    const entries = corpus(12);
    cold(entries);
    mapTimelineEntries(entries, '/r');
    /* 模拟 timelineStore: [...prev] + 替换最后一条 */
    const next = [...entries];
    next[next.length - 1] = { ...next[next.length - 1], detail: '回答 11 追加了新 token' } as TimelineEntry;
    const incremental = mapTimelineEntries(next, '/r');
    const fresh = cold(next);
    expect(JSON.stringify(incremental)).toBe(JSON.stringify(fresh));
  });

  test('追加新 entry: 结果与全量冷算一致', () => {
    const entries = corpus(8);
    cold(entries);
    mapTimelineEntries(entries, '/r');
    const next = [...entries, {
      id: 'new1', type: 'tool_call', toolName: 'write_file', title: 'write_file',
      detail: '/r/new.ts', output: 'ok', timestamp: Date.now(),
    } as TimelineEntry];
    expect(JSON.stringify(mapTimelineEntries(next, '/r'))).toBe(JSON.stringify(cold(next)));
  });

  test('并行批次标签只贴一次 (seenBatches 副作用不能被缓存跳过)', () => {
    const entries = corpus(6);
    cold(entries);
    for (let round = 0; round < 4; round++) {
      const items = mapTimelineEntries(entries, '/r');
      const labelled = items.filter(
        (it) => it.kind === 'tool' && (it as { groupLabel?: string }).groupLabel,
      );
      const grouped = items.filter(
        (it) => it.kind === 'tool' && (it as { groupId?: string }).groupId,
      );
      /* 6 个 batch, 每个 2 条: 12 条有 groupId, 只有 6 条带 label */
      expect(grouped.length).toBe(12);
      expect(labelled.length).toBe(6);
    }
  });

  test('workspacePath / density 变化必须让缓存失效', () => {
    const entries = corpus(6);
    __resetTimelineMapCacheForTests();
    const a = mapTimelineEntries(entries, '/r', { density: 'normal' });
    const b = mapTimelineEntries(entries, '/other-root', { density: 'normal' });
    const aFresh = JSON.stringify(a);
    /* 换 workspacePath 后不能拿旧结果 —— 与该 ctx 下冷算一致即可 */
    expect(JSON.stringify(b)).toBe(JSON.stringify((() => {
      __resetTimelineMapCacheForTests();
      const r = mapTimelineEntries(entries, '/other-root', { density: 'normal' });
      return r;
    })()));
    __resetTimelineMapCacheForTests();
    expect(JSON.stringify(mapTimelineEntries(entries, '/r', { density: 'normal' }))).toBe(aFresh);
  });

  test('pending assistant 遇到后续 error 时强制清 pending — 跨条目判据进 sig', () => {
    const base = Date.now();
    const entries = [
      { id: 'u1', type: 'user_message', detail: 'go', timestamp: base },
      { id: 'a1', type: 'assistant_message', detail: '正在写', timestamp: base + 1, pending: true, messageId: 'm1' },
    ] as TimelineEntry[];
    __resetTimelineMapCacheForTests();
    const before = mapTimelineEntries(entries, '/r');
    const aBefore = before.find((it) => it.kind === 'message' && it.id === 'a1');
    expect(aBefore && aBefore.kind === 'message' && aBefore.streaming).toBe(true);

    /* 追加一条 error → 同一个 a1 entry 对象, 但 streaming 必须翻 false */
    const withErr = [...entries, { id: 'e1', type: 'runner_error', detail: 'boom', timestamp: base + 2 } as TimelineEntry];
    const after = mapTimelineEntries(withErr, '/r');
    const aAfter = after.find((it) => it.kind === 'message' && it.id === 'a1');
    expect(aAfter && aAfter.kind === 'message' && aAfter.streaming).toBe(false);
  });
});
