
import { describe, it, expect, vi } from 'vitest';
import type { ProjectInstructions } from '@neoxlabs/kernel/core/projectInstructions.js';
import {
  emitInstructionsTimelineCard,
  shouldEmitInstructionsCard,
  summarizeInstructionsLoad,
  LOAD_INSTRUCTIONS_TOOL_NAME,
} from '../instructionsTimelineCard.js';

function makeInstructions(over: Partial<ProjectInstructions> = {}): ProjectInstructions {
  return {
    content: '',
    contentHash: 'deadbeefdeadbeef',
    sources: [],
    failures: [],
    loadedAt: Date.now(),
    ...over,
  };
}

const WS = '/tmp/ws';

describe('shouldEmitInstructionsCard', () => {
  it('没有任何指令文件 → 不出卡 (正常态, 不是失败)', () => {
    expect(shouldEmitInstructionsCard(makeInstructions())).toBe(false);
  });

  it('读到指令 → 出卡', () => {
    const i = makeInstructions({
      sources: [{ path: `${WS}/NEOX.md`, level: 'workspace', lines: 12 }],
    });
    expect(shouldEmitInstructionsCard(i)).toBe(true);
  });

  it('只有读取失败 (EACCES) 也要出卡 —— 不能静默吞掉', () => {
    const i = makeInstructions({
      failures: [{ path: `${WS}/NEOX.md`, code: 'EACCES', message: 'permission denied' }],
    });
    expect(shouldEmitInstructionsCard(i)).toBe(true);
  });
});

describe('emitInstructionsTimelineCard', () => {
  it('走 tool_call_start / tool_call_end 这条现有工具卡通道, 不发新事件类型', () => {
    const emit = vi.fn();
    const emitted = emitInstructionsTimelineCard({
      emit,
      workspace: WS,
      instructions: makeInstructions({
        content: 'a'.repeat(300),
        sources: [
          { path: `${WS}/NEOX.md`, level: 'workspace', lines: 12 },
          { path: '/home/u/.neox/INSTRUCTIONS.md', level: 'user', lines: 30 },
        ],
      }),
    });

    expect(emitted).toBe(true);
    expect(emit).toHaveBeenCalledTimes(2);

    const [start] = emit.mock.calls[0] as [any, any];
    const [end] = emit.mock.calls[1] as [any, any];
    expect(start.type).toBe('tool_call_start');
    expect(start.name).toBe(LOAD_INSTRUCTIONS_TOOL_NAME);
    expect(end.type).toBe('tool_call_end');
    expect(end.success).toBe(true);
    expect(end.toolKind).toBe('contextual');
  });

  it('payload 走 output 里的 ContextualResult (SavedTimelineEntry 没有 metadata 列)', () => {
    const emit = vi.fn();
    emitInstructionsTimelineCard({
      emit,
      workspace: WS,
      instructions: makeInstructions({
        content: 'x'.repeat(120),
        sources: [{ path: `${WS}/.neox/INSTRUCTIONS.md`, level: 'workspace', lines: 9 }],
      }),
    });

    const [end] = emit.mock.calls[1] as [any, any];
    const unwrapped = JSON.parse(end.output);
    expect(unwrapped.tool).toBe(LOAD_INSTRUCTIONS_TOOL_NAME);
    expect(unwrapped.metadata.sources).toHaveLength(1);
    expect(unwrapped.metadata.sources[0]).toMatchObject({ level: 'workspace', lines: 9 });
    expect(unwrapped.metadata.chars).toBe(120);
    /* hash 是内部缓存细节, 不该出现在用户看的卡上 */
    expect(JSON.stringify(unwrapped.metadata)).not.toContain('deadbeef');
  });

  it('没有指令文件 → 一个事件都不发', () => {
    const emit = vi.fn();
    const emitted = emitInstructionsTimelineCard({
      emit,
      workspace: WS,
      instructions: makeInstructions(),
    });
    expect(emitted).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it('有文件读不了 → success=false + toolError 点名到文件和 errno', () => {
    const emit = vi.fn();
    emitInstructionsTimelineCard({
      emit,
      workspace: WS,
      instructions: makeInstructions({
        failures: [{ path: `${WS}/NEOX.md`, code: 'EACCES', message: 'permission denied' }],
      }),
    });

    const [end] = emit.mock.calls[1] as [any, any];
    expect(end.success).toBe(false);
    expect(end.toolStatus).toBe('error');
    expect(end.toolError).toContain('EACCES');
    expect(end.toolError).toContain('NEOX.md');
  });

  it('部分成功也算失败 —— 用户少了一份他以为生效的指令', () => {
    const emit = vi.fn();
    emitInstructionsTimelineCard({
      emit,
      workspace: WS,
      instructions: makeInstructions({
        sources: [{ path: `${WS}/NEOX.md`, level: 'workspace', lines: 5 }],
        failures: [{ path: '/home/u/.neox/INSTRUCTIONS.md', code: 'EACCES', message: 'denied' }],
      }),
    });
    const [end] = emit.mock.calls[1] as [any, any];
    expect(end.success).toBe(false);
  });

  it('没有 emit 通道时安全返回 false, 不抛', () => {
    expect(
      emitInstructionsTimelineCard({
        emit: undefined,
        workspace: WS,
        instructions: makeInstructions({
          sources: [{ path: `${WS}/NEOX.md`, level: 'workspace', lines: 1 }],
        }),
      }),
    ).toBe(false);
  });
});

describe('summarizeInstructionsLoad', () => {
  it('折叠态就能看懂: 几个文件 / 多少行', () => {
    const s = summarizeInstructionsLoad(makeInstructions({
      sources: [
        { path: 'a', level: 'workspace', lines: 10 },
        { path: 'b', level: 'user', lines: 5 },
      ],
    }));
    expect(s).toContain('2 个指令文件');
    expect(s).toContain('15 行');
  });

  it('失败数也进摘要', () => {
    const s = summarizeInstructionsLoad(makeInstructions({
      failures: [{ path: 'a', code: 'EACCES', message: 'x' }],
    }));
    expect(s).toContain('1 个读取失败');
  });
});
