import { describe, test } from 'vitest';
import { mapTimelineEntriesToRows, __resetTimelineSegmentCacheForTests } from '../mapTimelineToRows';
import { buildTimelineRows, __resetBuildSegmentCacheForTests } from '../timelineRows';
import type { TimelineEntry } from '../../../utils/workspaceUtils';

const RUN = process.env.NEOX_BENCH === '1';

/** 尽量贴近真实语料: 一轮 = 1 user + thinking + 3 工具 + 1 edit + 1 assistant */
function synth(nTurns: number): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  let ts = Date.now() - nTurns * 60_000;
  /* 每条内容必须唯一 —— 共用同一个字符串引用会让"entries 堆"测出接近 0,
   * 而真实会话里每条 entry 的文本都不一样, 不能共享。 */
  const uniq = (t: number, tag: string) =>
    `[${tag}#${t}] Neox 会话内存实测语料，中文按 UTF-16 每字 2 字节。`.repeat(30);
  for (let t = 0; t < nTurns; t++) {
    const text = uniq(t, 'txt');
    const diff = Array.from({ length: 40 }, (_, i) => `+ ${t}:${i} const v${t}_${i} = f(${i});`).join('\n');
    out.push({ id: `u${t}`, type: 'user_message', detail: `第 ${t} 轮请求`, timestamp: ts++ } as TimelineEntry);
    out.push({ id: `th${t}`, type: 'thinking', detail: text, timestamp: ts++ } as TimelineEntry);
    out.push({ id: `r${t}`, type: 'tool_call', toolName: 'read_file', title: 'read_file', detail: `/repo/m${t}.ts`, output: text, timestamp: ts++ } as TimelineEntry);
    out.push({ id: `g${t}`, type: 'tool_call', toolName: 'grep', title: 'grep', detail: `q${t}`, output: text, timestamp: ts++ } as TimelineEntry);
    out.push({ id: `s${t}`, type: 'tool_call', toolName: 'run_shell_command', title: 'shell', detail: `npm test ${t}`, output: text + text, timestamp: ts++ } as TimelineEntry);
    out.push({ id: `e${t}`, type: 'edit_file', toolName: 'edit_file', title: 'edit_file', editFilePath: `/repo/m${t}.ts`, detail: diff, output: diff, editHunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 40, content: diff }], timestamp: ts++ } as unknown as TimelineEntry);
    out.push({ id: `a${t}`, type: 'assistant_message', detail: text, timestamp: ts++, messageId: `m${t}` } as TimelineEntry);
  }
  return out;
}

const MB = (n: number) => `${(n / 1048576).toFixed(1)}MB`;
function heap(): number {
  if (typeof global.gc === 'function') { global.gc(); global.gc(); }
  return process.memoryUsage().heapUsed;
}

describe.skipIf(!RUN)('会话内存占用', () => {
  test('entries / items / rows 三层实测', () => {
    // eslint-disable-next-line no-console
    console.log(`\n  (gc ${typeof global.gc === 'function' ? '可用, 数值准确' : '不可用, 数值偏大含垃圾'})`);
    for (const turns of [143, 714, 1428, 2857]) {
      __resetTimelineSegmentCacheForTests();
      __resetBuildSegmentCacheForTests();

      const base = heap();
      const entries = synth(turns);
      const afterEntries = heap();

      const items = mapTimelineEntriesToRows(entries, '/repo', { sessionId: 's' });
      const afterItems = heap();

      const rows = buildTimelineRows(items as never, false, new Set(), true);
      const afterRows = heap();

      const json = JSON.stringify(entries).length;
      // eslint-disable-next-line no-console
      console.log(
        `  ${String(entries.length).padStart(6)} entries │ ` +
        `JSON ${MB(json).padStart(7)} │ ` +
        `entries堆 ${MB(afterEntries - base).padStart(7)} │ ` +
        `+items ${MB(afterItems - afterEntries).padStart(7)} │ ` +
        `+rows ${MB(afterRows - afterItems).padStart(7)} │ ` +
        `合计 ${MB(afterRows - base).padStart(7)} │ ` +
        `rows数 ${rows.length}`
      );
    }
  }, 600_000);
});
