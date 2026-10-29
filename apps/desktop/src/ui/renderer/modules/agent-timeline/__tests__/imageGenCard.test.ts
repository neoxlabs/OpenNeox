import { describe, it, expect } from 'vitest';
import { mapTimelineEntries, __resetTimelineMapCacheForTests } from '../mapTimeline';
import type { TimelineEntry } from '../../../utils/workspaceUtils';

const REAL_OUTPUT = JSON.stringify({
  success: true,
  paths: ['/ws/2026-08-19-images/A-solid-pure-blue-square.png'],
  count: 1,
  model: 'gpt-image-2',
  mode: 'byok',
  revisedPrompt: 'A solid pure blue square, flat single color',
});

const entry = (over: Partial<TimelineEntry> = {}): TimelineEntry => ({
  id: 'img-1',
  type: 'tool_result',
  timestamp: 1_000,
  toolName: 'generate_image',
  output: REAL_OUTPUT,
  toolArgs: { prompt: '纯蓝色方块' },
  ...over,
} as unknown as TimelineEntry);

function imageStep(e: TimelineEntry) {
  __resetTimelineMapCacheForTests();
  const steps = mapTimelineEntries([e]) as any[];
  return steps.find((s) => s?.content?.type === 'image');
}

describe('出图结果卡', () => {
  it('generate_image 的 tool_result 要产出 image 卡, 而不是掉进通用 tool_result', () => {
    const s = imageStep(entry());
    expect(s, '没产出 image content —— 这正是修复前的现象').toBeTruthy();
    expect(s.content.paths).toEqual(['/ws/2026-08-19-images/A-solid-pure-blue-square.png']);
  });

  it('带上 model / prompt / cached, 卡片才说得清这张图是怎么来的', () => {
    const c = imageStep(entry()).content;
    expect(c.model).toBe('gpt-image-2');
    expect(c.prompt).toBe('纯蓝色方块');
    expect(c.cached).toBe(false); /* mode='byok' 不是 cache */
  });

  it('mode=cache 时标成命中缓存', () => {
    const c = imageStep(entry({ output: JSON.stringify({ paths: ['/a.png'], mode: 'cache' }) } as any)).content;
    expect(c.cached).toBe(true);
  });

  it('edit_image 走同一条卡', () => {
    expect(imageStep(entry({ toolName: 'edit_image' } as any))).toBeTruthy();
  });

  it('⚠️ 读 entry.result 会退回 bug 行为 —— 这条守的就是"别再读那个不存在的字段"', () => {
    const e = entry({ output: undefined } as any);
    (e as any).result = REAL_OUTPUT;
    expect(imageStep(e)).toBeFalsy();
  });

  it('工具失败 / 没有 paths 时不画空图卡', () => {
    expect(imageStep(entry({ output: JSON.stringify({ error: 'boom' }) } as any))).toBeFalsy();
    expect(imageStep(entry({ output: JSON.stringify({ success: true, paths: [] }) } as any))).toBeFalsy();
    expect(imageStep(entry({ output: 'not json' } as any))).toBeFalsy();
  });

  it('被 contextual 信封包一层时也要认 (metadata 载荷)', () => {
    const wrapped = JSON.stringify({
      tool: 'generate_image', summary: '已生成', status: 'success', type: 'contextual',
      metadata: { paths: ['/b.png'], model: 'gpt-image-2' },
    });
    const s = imageStep(entry({ output: wrapped } as any));
    expect(s).toBeTruthy();
    expect(s.content.paths).toEqual(['/b.png']);
  });
});

/* ── 整条渲染链 ──────────────────────────────────────────────────────────
 * entry → StepContent(mapTimeline) → HistoryCellRow(mapTimelineToRows)
 *       → TimelineStep(rowStepToTimelineStep) → ErrorView/卡片 props
 * 每一跳都是**手写字段清单** (见 memory/feedback_timeline_three_hop_field_rebuild),
 * 漏一跳就等于这个字段在那条路径上不存在, 而 typecheck 和上面那组单测都照样绿。
 * 上面只验到第一跳; 这里把 image content 一路跟到底。 */
describe('image content 要活着走完整条链', () => {
  it('mapTimelineEntriesToRows 之后 payload 里仍有那张图', async () => {
    const { mapTimelineEntriesToRows } = await import('../mapTimelineToRows');
    __resetTimelineMapCacheForTests();
    const rows = mapTimelineEntriesToRows([entry()]) as any[];
    const withImg = rows.find((r) => JSON.stringify(r).includes('A-solid-pure-blue-square.png'));
    expect(withImg, 'row 层把图弄丢了 —— 三跳重建漏了一跳').toBeTruthy();
  });

  it('rowStepToTimelineStep 之后仍在 (最后一跳)', async () => {
    const { mapTimelineEntriesToRows } = await import('../mapTimelineToRows');
    const { rowStepToTimelineStep } = await import('../timelineRows');
    __resetTimelineMapCacheForTests();
    const rows = mapTimelineEntriesToRows([entry()]) as any[];
    const survived = rows
      .map((r) => { try { return rowStepToTimelineStep(r); } catch { return null; } })
      .some((s) => JSON.stringify(s ?? {}).includes('A-solid-pure-blue-square.png'));
    expect(survived, 'TimelineStep 那一跳把图弄丢了').toBe(true);
  });
});
