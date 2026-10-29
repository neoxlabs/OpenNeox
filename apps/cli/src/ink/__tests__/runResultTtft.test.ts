import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeEventHandler } from '../../utils/runtimeEvents.js';
import { getLastTurnTtft, recordTurnPerf, consumeRunPerf } from '../../utils/turnPerf.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

function makeCtx(ui: any): any {
  return {
    uiController: ui,
    getUiController: () => ui,
    lastToolCallArgs: new Map(),
    toolIdToName: new Map(),
    toolIdToArgs: new Map(),
    pushTokenStats: () => {},
    getRuntimeTokens: () => ({ input: 0, output: 0 }),
    setRuntimeTokens: () => {},
    getStreamingTokenCount: () => 0,
    setStreamingTokenCount: () => {},
  };
}

function makeUi(): any {
  return {
    completeReasoningStreaming: vi.fn(),
    completeTextStreaming: vi.fn(),
    commitAllPendingEntries: vi.fn(),
    updateStatus: vi.fn(),
    addTurnEnd: vi.fn(),
    endTurn: vi.fn(),
    clearAgentContext: vi.fn(),
    unsealAgentContext: vi.fn(),
    clearPlanSteps: vi.fn(),
    updateTaskTokens: vi.fn(),
    updateAgentContext: vi.fn(),
  };
}

const runResult = (perf: unknown, extra: Record<string, unknown> = {}) => ({
  type: 'run_result',
  output: '',
  totalTokens: 1200,
  iterations: 2,
  toolCalls: 1,
  durationMs: 5000,
  iterationPerf: perf,
  ...extra,
});

describe('run_result.iterationPerf → 首字时间 (CLI)', () => {
  beforeEach(() => {
    recordTurnPerf(null); // 模块级 store 在用例间重置
  });

  it('主 agent 一轮完成: 首字进 store 并打 PERF 日志', () => {
    const info = vi.spyOn(cliLogger, 'info').mockImplementation(() => {});
    const ui = makeUi();
    createRuntimeEventHandler(makeCtx(ui))(runResult([
      { iteration: 1, durationMs: 2000, ttftMs: 1200, firstKind: 'text', toolMs: 0, toolCalls: 0, textChars: 10 },
      { iteration: 2, durationMs: 1500, ttftMs: 400, firstKind: 'tool_call', toolMs: 700, toolCalls: 1, textChars: 0 },
    ]) as any);

    expect(getLastTurnTtft()).toBe(1200);
    const perfCall = info.mock.calls.find((c) => c[0] === 'PERF');
    expect(perfCall?.[1]).toContain('ttft=1200ms');
    expect(perfCall?.[1]).toContain('iterations=2');
    expect(perfCall?.[1]).toContain('label=Main');
    info.mockRestore();
  });

  it('子 agent 的 run_result 不覆盖主轮首字', () => {
    recordTurnPerf([{ iteration: 1, durationMs: 900, ttftMs: 1500, firstKind: 'text', toolMs: 0, toolCalls: 0, textChars: 1 }]);
    const info = vi.spyOn(cliLogger, 'info').mockImplementation(() => {});
    /* run_result 处理器就是调这一个入口 (handler 里还有整条 worker 卡片 UI 链,
     * 这里只关心首字那份 store 的归属)。 */
    consumeRunPerf({
      sourceLabel: 'Explore',
      iterationPerf: [{ iteration: 1, durationMs: 300, ttftMs: 80, firstKind: 'text', toolMs: 0, toolCalls: 0, textChars: 1 }],
    });

    expect(getLastTurnTtft()).toBe(1500);
    expect(info.mock.calls.some((c) => c[0] === 'PERF' && String(c[1]).includes('label=Explore'))).toBe(true);
    info.mockRestore();
  });

  it('没有 iterationPerf (老服务端 / 空数组) 时安静跳过, 不写假值', () => {
    const info = vi.spyOn(cliLogger, 'info').mockImplementation(() => {});
    const ui = makeUi();
    createRuntimeEventHandler(makeCtx(ui))(runResult(undefined) as any);

    expect(getLastTurnTtft()).toBeNull();
    expect(info.mock.calls.some((c) => c[0] === 'PERF')).toBe(false);
    info.mockRestore();
  });
});
