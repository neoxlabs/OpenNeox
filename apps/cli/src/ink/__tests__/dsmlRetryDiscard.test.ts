
import { describe, expect, it, vi } from 'vitest';
import { InkUIAdapter } from '../InkUIAdapter.js';
import { createRuntimeEventHandler } from '../../utils/runtimeEvents.js';

function makeAdapter(): InkUIAdapter {
  return new InkUIAdapter({
    version: 'test',
    provider: 'test',
    model: 'test-model',
    workDir: process.cwd(),
  });
}

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

const THINKING = 'I should call the shell tool now.\n<｜DSML｜invoke name="bash">';

const dsmlRetryEvent = {
  type: 'raw_response_event',
  event_type: 'dsml.incomplete_retry',
  data: { type: 'dsml.incomplete_retry', attempt: 1, discardedText: THINKING },
};

/** 时间线里的助手正文 (info / tool 卡不算) */
function assistantTexts(ui: InkUIAdapter): string[] {
  const entries = ((ui as any).runtime.staticEntries as any[]) || [];
  return entries
    .filter((e) => e.type === 'assistant' || e.type === 'assistant_message')
    .map((e) => e.message?.content?.[0]?.text ?? e.text ?? '');
}

describe('dsml.incomplete_retry (CLI)', () => {
  it('收到事件 → 丢弃还没落定的正文, 并说明为什么重来', () => {
    const ui = { resetStreamingState: vi.fn(), addInfo: vi.fn() };
    createRuntimeEventHandler(makeCtx(ui))(dsmlRetryEvent as any);
    expect(ui.resetStreamingState).toHaveBeenCalledTimes(1);
    expect(ui.addInfo).toHaveBeenCalledTimes(1);
  });

  it('别的 raw_response_event (response.completed 等) 不受影响', () => {
    const ui = { resetStreamingState: vi.fn(), addInfo: vi.fn() };
    createRuntimeEventHandler(makeCtx(ui))({ type: 'raw_response_event', event_type: 'response.completed', data: {} } as any);
    expect(ui.resetStreamingState).not.toHaveBeenCalled();
    expect(ui.addInfo).not.toHaveBeenCalled();
  });

  it('先流出一段思考 → 收到重来事件 → 气泡清空, 新回答正常落进时间线', () => {
    const ui = makeAdapter();
    const handler = createRuntimeEventHandler(makeCtx(ui));
    ui.beginTurn();

    ui.addTextDelta(THINKING); // 这一轮的正文还只在缓冲里 (没成段)
    handler(dsmlRetryEvent as any);

    /* 收尾也不能把作废的那段提交出来 */
    ui.completeTextStreaming();
    expect(assistantTexts(ui)).toEqual([]);

    /* 重来后的正文照常流、照常落 */
    ui.addTextDelta('修好了。');
    ui.completeTextStreaming();
    expect(assistantTexts(ui)).toEqual(['修好了。']);
  });
});
