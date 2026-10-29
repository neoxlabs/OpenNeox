/**
 * 项目指令加载卡 — renderer 侧映射契约.
 *
 * 端到端方向: runtime 发的 tool_call_end.output (ContextualResult JSON)
 *   → TimelineEntry.output → mapTimeline 的 buildInstructionsContent
 *   → StepContent { type: 'instructions' } → InstructionsCardView.
 *
 * 这里锁的是中间那一段: 只要 runtime 侧的 payload 形状不变, 卡就渲得出来。
 * 之所以必须有这条测试 —— payload 走的是 `output` 而不是 `metadata`
 * (SavedTimelineEntry 上没有 metadata 列), 这个约束很容易在重构时被"顺手改回去"。
 */

import { describe, it, expect } from 'vitest';
import { mapTimelineEntries } from '../mapTimeline';
import type { TimelineEntry } from '../../../utils/workspaceUtils';
import type { TimelineStep } from '../types';

/** 跟 runtime/instructionsTimelineCard.ts 的 emit 保持同形 */
function makeEntry(metadata: Record<string, unknown>, success = true): TimelineEntry {
  return {
    id: 'e1',
    type: 'tool_result',
    toolName: 'load_instructions',
    title: 'load_instructions',
    timestamp: Date.now(),
    success,
    output: JSON.stringify({
      type: 'contextual',
      status: success ? 'success' : 'error',
      tool: 'load_instructions',
      summary: '1 个指令文件 · 12 行',
      content: '',
      metadata,
    }),
  } as unknown as TimelineEntry;
}

function firstContent(entry: TimelineEntry) {
  const steps = mapTimelineEntries([entry], '/ws');
  return (steps[0] as TimelineStep | undefined)?.content as any;
}

describe('load_instructions → instructions 卡', () => {
  it('读到指令 → 卡上带路径 / 来源层级 / 行数', () => {
    const content = firstContent(makeEntry({
      workspace: '/ws',
      sources: [
        { path: '/ws/NEOX.md', level: 'workspace', lines: 12 },
        { path: '/home/u/.neox/INSTRUCTIONS.md', level: 'user', lines: 40 },
      ],
      failures: [],
      chars: 900,
    }));

    expect(content?.type).toBe('instructions');
    expect(content.sources).toHaveLength(2);
    expect(content.sources[0]).toMatchObject({ level: 'workspace', lines: 12 });
    expect(content.sources[1]).toMatchObject({ level: 'user', lines: 40 });
    expect(content.workspace).toBe('/ws');
    expect(content.chars).toBe(900);
  });

  it('读取失败 → failures 带到卡上 (点名文件 + errno)', () => {
    const content = firstContent(makeEntry({
      workspace: '/ws',
      sources: [],
      failures: [{ path: '/ws/NEOX.md', code: 'EACCES', message: 'permission denied' }],
      chars: 0,
    }, false));

    expect(content?.type).toBe('instructions');
    expect(content.failures).toHaveLength(1);
    expect(content.failures[0].code).toBe('EACCES');
  });

  it('sources 和 failures 都空 → 不渲空卡', () => {
    const content = firstContent(makeEntry({
      workspace: '/ws', sources: [], failures: [], chars: 0,
    }));
    expect(content?.type).not.toBe('instructions');
  });

  it('畸形 metadata 不会渲出半张卡', () => {
    const content = firstContent(makeEntry({
      workspace: '/ws',
      sources: [{ path: '/ws/NEOX.md' /* 缺 level / lines */ }],
      failures: [],
      chars: 0,
    }));
    expect(content?.type).not.toBe('instructions');
  });
});
