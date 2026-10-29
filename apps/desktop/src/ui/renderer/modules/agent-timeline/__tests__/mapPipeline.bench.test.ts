/**
 * Timeline 映射管线成本基准 — 默认不跑, CI 无噪音。
 *   NEOX_BENCH=1 npx vitest run apps/desktop/src/ui/renderer/modules/agent-timeline/__tests__/mapPipeline.bench.test.ts --disable-console-intercept
 *
 * 量的是"流式期每帧成本": 每个 stream chunk 都会全量重跑 map → buildRows → stabilize。
 */
import { describe, test } from 'vitest';
import { mapTimelineEntriesToRows } from '../mapTimelineToRows';
import { buildTimelineRows, stabilizeTimelineRows } from '../timelineRows';
import type { TimelineEntry } from '../../../utils/workspaceUtils';

const RUN = process.env.NEOX_BENCH === '1';

function synth(nTurns: number): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  let ts = Date.now() - nTurns * 7 * 60_000;
  const bigText = 'Neox timeline 性能分析文本片段。'.repeat(40);
  const diffBody = Array.from({ length: 60 }, (_, i) => `+ line ${i} const x${i} = compute(${i});`).join('\n');
  for (let t = 0; t < nTurns; t++) {
    out.push({ id: `u${t}`, type: 'user_message', detail: `请继续第 ${t} 步`, timestamp: ts++ } as TimelineEntry);
    out.push({ id: `th${t}`, type: 'thinking', detail: bigText, timestamp: ts++ } as TimelineEntry);
    out.push({ id: `tc${t}a`, type: 'tool_call', toolName: 'read_file', title: 'read_file', detail: `/repo/m${t}.ts`, output: bigText, timestamp: ts++, batchId: `b${t}` } as TimelineEntry);
    out.push({ id: `tc${t}b`, type: 'tool_call', toolName: 'grep', title: 'grep', detail: `p${t}`, output: bigText, timestamp: ts++, batchId: `b${t}` } as TimelineEntry);
    out.push({ id: `ef${t}`, type: 'edit_file', toolName: 'edit_file', title: 'edit_file', editFilePath: `/repo/m${t}.ts`, detail: diffBody, output: diffBody, editHunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 60, content: diffBody }], timestamp: ts++ } as unknown as TimelineEntry);
    out.push({ id: `sh${t}`, type: 'tool_call', toolName: 'run_shell_command', title: 'shell', detail: `npm test ${t}`, output: bigText + bigText, timestamp: ts++ } as TimelineEntry);
    out.push({ id: `a${t}`, type: 'assistant_message', detail: bigText, timestamp: ts++, messageId: `m${t}` } as TimelineEntry);
  }
  return out;
}

function bench(label: string, fn: () => void, iters: number): number {
  fn();
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  const dt = (performance.now() - t0) / iters;
  // eslint-disable-next-line no-console
  console.log(`  ${label.padEnd(46)} ${dt.toFixed(2)} ms/帧`);
  return dt;
}

describe.skipIf(!RUN)('timeline 映射管线 — 流式期每帧成本', () => {
  test('规模扫描', () => {
    for (const turns of [140, 700, 1400, 2800, 7000, 14000]) {
      const entries = synth(turns);
      const bytes = JSON.stringify(entries).length;
      // eslint-disable-next-line no-console
      console.log(`\n── ${entries.length} entries / 原始 ${(bytes/1048576).toFixed(1)}MB ──`);
      const iters = turns > 500 ? 5 : 20;
      const tRows = bench('mapTimelineEntriesToRows', () => { mapTimelineEntriesToRows(entries, '/repo', { sessionId: 's' }); }, iters);
      const items = mapTimelineEntriesToRows(entries, '/repo', { sessionId: 's' });
      const built = buildTimelineRows(items as never, false, new Set(), true);
      bench('  └ buildTimelineRows 单项', () => { buildTimelineRows(items as never, false, new Set(), true); }, iters);
      const freshRows = buildTimelineRows(items as never, false, new Set(), true);
      bench('  └ stabilizeTimelineRows 单项', () => { stabilizeTimelineRows(built, freshRows); }, iters);
      const tAll = bench('全链 map+build+stabilize', () => {
        const fresh = buildTimelineRows(
          mapTimelineEntriesToRows(entries, '/repo', { sessionId: 's' }) as never,
          false, new Set(), true,
        );
        stabilizeTimelineRows(built, fresh);
      }, iters);
      // eslint-disable-next-line no-console
      console.log(`  → 60fps 预算(16.7ms) 占用 ${((tAll / 16.7) * 100).toFixed(0)}%   [map 单项 ${tRows.toFixed(2)}ms]`);
    }
  }, 600_000);
});

describe.skipIf(!RUN)('真实流式口径 —— 只改末尾一条 (增量缓存生效)', () => {
  test('规模扫描', () => {
    for (const turns of [140, 700, 1400, 2800, 7000, 14000]) {
      const entries = synth(turns);
      // eslint-disable-next-line no-console
      console.log(`\n── ${entries.length} entries ──`);
      // 预热: 建立缓存
      let items = mapTimelineEntriesToRows(entries, '/repo', { sessionId: 's' });
      let rows = buildTimelineRows(items as never, false, new Set(), true);
      const iters = 40;
      let cur = entries;
      let tMap = 0, tBuild = 0, tStab = 0;
      const t0 = performance.now();
      for (let i = 0; i < iters; i++) {
        /* 模拟 timelineStore: [...prev] + 只替换最后一条 (对象身份其余不变) */
        const next = [...cur];
        const last = next[next.length - 1] as unknown as Record<string, unknown>;
        next[next.length - 1] = { ...last, detail: String(last.detail ?? '') + 'x' } as never;
        cur = next as never;
        const a = performance.now();
        const it = mapTimelineEntriesToRows(cur, '/repo', { sessionId: 's' });
        const b = performance.now();
        const rw = buildTimelineRows(it as never, false, new Set(), true);
        const c = performance.now();
        rows = stabilizeTimelineRows(rows as never, rw as never) as never;
        const d = performance.now();
        tMap += b - a; tBuild += c - b; tStab += d - c;
        items = it;
      }
      const dt = (performance.now() - t0) / iters;
      // eslint-disable-next-line no-console
      console.log(`  流式每帧 ${dt.toFixed(2)} ms (map ${(tMap/iters).toFixed(2)} / build ${(tBuild/iters).toFixed(2)} / stabilize ${(tStab/iters).toFixed(2)}) → 预算 ${((dt / 16.7) * 100).toFixed(0)}%  rows=${(rows as never as unknown[]).length}`);
    }
  }, 600_000);
});
