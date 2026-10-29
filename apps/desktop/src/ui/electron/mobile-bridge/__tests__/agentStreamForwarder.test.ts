import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pushed: Array<{ sessionId: string; kind: string; payload: any }> = [];

vi.mock('../index.js', () => ({
  getMobileBridgeServer: () => ({
    listConns: () => [{ subscribedSessionIds: new Set(['s1']) }],
    pushToSessionSubscribers: (sessionId: string, notif: any) => {
      pushed.push({ sessionId, kind: notif.params.kind, payload: notif.params.payload });
    },
  }),
  notifyDesktopMobileActiveSession: vi.fn(),
}));

const appendMessage = vi.fn(async () => {});
vi.mock('@neoxlabs/platform/platform/sessionContext.js', () => ({
  SessionContext: {
    get: () => ({ appendMessage }),
    onAppend: () => () => {},
  },
}));

vi.mock('../log.js', () => ({
  bridgeLog: () => {},
  flushBridgeLogSync: () => {},
  BRIDGE_LOG_FILE: '/dev/null',
}));

import {
  _clearAllForwarderStateForTest,
  flushPendingDeltas,
  getLiveStreamingSnapshot,
  getSessionCurrentTurnId,
  handleStreamEvent,
} from '../agentStreamForwarder.js';
import { _clearAllRunStateMirrorForTest } from '../runStateMirror.js';
import { getPendingActions } from '../pendingActionsRegistry.js';

function evt(type: string, extra: Record<string, unknown> = {}): any {
  return { sessionId: 's1', type, timestamp: 1000, ...extra };
}

describe('agentStreamForwarder 合帧+快照+清桶', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    pushed.length = 0;
    appendMessage.mockClear();
    _clearAllForwarderStateForTest();
    _clearAllRunStateMirrorForTest();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function startTurn(turnId = 'turn-A'): Promise<void> {
    await handleStreamEvent(evt('run_state_changed', {
      turnId,
      data: { status: 'running', turnId, updatedAt: 1000 },
      status: 'running',
    }));
    pushed.length = 0; // run_state_changed 本身的推送不参与断言
  }

  it('token 洪水在 40ms 窗口内合并成单帧且内容无损', async () => {
    await startTurn();
    await handleStreamEvent(evt('token', { turnId: 'turn-A', content: 'Hel' }));
    await handleStreamEvent(evt('token', { turnId: 'turn-A', content: 'lo ' }));
    await handleStreamEvent(evt('token', { turnId: 'turn-A', content: 'world' }));
    expect(pushed).toHaveLength(0); // 还在窗口内
    vi.advanceTimersByTime(45);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({
      kind: 'agent_text_delta',
      payload: { content: 'Hello world', turn_id: 'turn-A' },
    });
  });

  it('thinking 与 text delta 各自归桶, tool_progress 按 callId 归桶', async () => {
    await startTurn();
    await handleStreamEvent(evt('token', { turnId: 'turn-A', content: 'a' }));
    await handleStreamEvent(evt('reasoning', { turnId: 'turn-A', content: 'think1' }));
    await handleStreamEvent(evt('shell_output_stream', { turnId: 'turn-A', toolCallId: 'c1', chunk: 'out1' }));
    await handleStreamEvent(evt('token', { turnId: 'turn-A', content: 'b' }));
    await handleStreamEvent(evt('shell_output_stream', { turnId: 'turn-A', toolCallId: 'c1', chunk: 'out2' }));
    vi.advanceTimersByTime(45);
    const kinds = pushed.map((p) => p.kind);
    expect(kinds).toEqual(['agent_text_delta', 'agent_thinking_delta', 'tool_progress']);
    expect(pushed[0]!.payload.content).toBe('ab');
    expect(pushed[1]!.payload.content).toBe('think1');
    expect(pushed[2]!.payload.chunk).toBe('out1out2');
  });

  it('非 delta 事件是保序屏障 — 先 flush 排队 delta 再推自己', async () => {
    await startTurn();
    await handleStreamEvent(evt('token', { turnId: 'turn-A', content: 'partial' }));
    await handleStreamEvent(evt('run_result', { turnId: 'turn-A' }));
    const kinds = pushed.map((p) => p.kind);
    expect(kinds[0]).toBe('agent_text_delta');
    expect(kinds).toContain('agent_turn_done');
    expect(kinds.indexOf('agent_text_delta')).toBeLessThan(kinds.indexOf('agent_turn_done'));
  });

  it('mid-stream attach 快照: 半成品正文/思考/在跑工具齐活', async () => {
    await startTurn();
    await handleStreamEvent(evt('token', { turnId: 'turn-A', content: 'half-done text' }));
    await handleStreamEvent(evt('reasoning', { turnId: 'turn-A', content: 'half thinking' }));
    await handleStreamEvent(evt('tool_call_start', {
      turnId: 'turn-A', toolName: 'shell', toolCallId: 'c9', args: { command: 'ls' },
    }));
    flushPendingDeltas('s1');
    const snap = getLiveStreamingSnapshot('s1');
    expect(snap).not.toBeNull();
    expect(snap!.turn_id).toBe('turn-A');
    expect(snap!.partial_text).toBe('half-done text');
    expect(snap!.partial_thinking).toBe('half thinking');
    expect(snap!.running_tools).toEqual([
      { tool_call_id: 'c9', tool_name: 'shell', args: { command: 'ls' } },
    ]);
  });

  it('tool_result 后 running_tools 移除该工具', async () => {
    await startTurn();
    await handleStreamEvent(evt('tool_call_start', {
      turnId: 'turn-A', toolName: 'shell', toolCallId: 'c9', args: {},
    }));
    await handleStreamEvent(evt('token', { turnId: 'turn-A', content: 'x' }));
    await handleStreamEvent(evt('tool_result', {
      turnId: 'turn-A', toolName: 'shell', toolCallId: 'c9', output: 'ok', success: true,
    }));
    const snap = getLiveStreamingSnapshot('s1');
    expect(snap!.running_tools).toEqual([]);
  });

  it('run_result 清桶: 快照归零, 泄漏的 accum 不残留', async () => {
    await startTurn();
    await handleStreamEvent(evt('token', { turnId: 'turn-A', content: 'orphaned' }));
    await handleStreamEvent(evt('run_result', { turnId: 'turn-A' }));
    expect(getLiveStreamingSnapshot('s1')).toBeNull();
  });

  it('session_interrupted 清桶且先 flush 已排队 delta', async () => {
    await startTurn();
    await handleStreamEvent(evt('token', { turnId: 'turn-A', content: 'before-abort' }));
    await handleStreamEvent(evt('session_interrupted', { turnId: 'turn-A', reason: 'user_stop' }));
    const kinds = pushed.map((p) => p.kind);
    expect(kinds.indexOf('agent_text_delta')).toBeLessThan(kinds.indexOf('session_interrupted'));
    expect(getLiveStreamingSnapshot('s1')).toBeNull();
  });

  it('stream_order: 正文按段首 token 取号 — 同补全内 text_complete 晚于 tool 也排回工具前', async () => {
    await startTurn();
    /* OpenAI 协议同一次补全: intro tokens 先流 (段首锁 order=1), 再 tool_call_start
     * (order=2), text_complete 最后才 fire — drift raw 必须带 order=1 (在工具前). */
    await handleStreamEvent(evt('token', { turnId: 'turn-A', content: '我先解释一下' }));
    await handleStreamEvent(evt('tool_call_start', {
      turnId: 'turn-A', toolName: 'shell', toolCallId: 'c1', args: {},
    }));
    await handleStreamEvent(evt('text_complete', { turnId: 'turn-A' }));
    /* mock.calls 的元素类型是 vi 推出来的空元组, 直接 c[4] 会报 TS2493/TS2532。
     * 这里只是取第 5 个实参 (appendMessage 的 payload), 断言逻辑不变。 */
    const calls = appendMessage.mock.calls as unknown as any[][];
    const textCall = calls.find((c) => c[4]?.content === '我先解释一下');
    const toolCall = calls.find((c) => Array.isArray(c[4]?.tool_calls));
    expect(textCall![4].stream_order).toBe(1);
    expect(toolCall![4].stream_order).toBe(2);
  });

  it('stream_order: 工具后的答案段取号在工具后 (真机错序场景)', async () => {
    await startTurn();
    await handleStreamEvent(evt('reasoning', { turnId: 'turn-A', content: '想一想' }));
    await handleStreamEvent(evt('reasoning_complete', { turnId: 'turn-A' }));
    await handleStreamEvent(evt('tool_call_start', {
      turnId: 'turn-A', toolName: 'shell', toolCallId: 'c1', args: {},
    }));
    await handleStreamEvent(evt('tool_result', {
      turnId: 'turn-A', toolName: 'shell', toolCallId: 'c1', output: 'out', success: true,
    }));
    await handleStreamEvent(evt('reasoning', { turnId: 'turn-A', content: '看到结果了' }));
    await handleStreamEvent(evt('reasoning_complete', { turnId: 'turn-A' }));
    await handleStreamEvent(evt('token', { turnId: 'turn-A', content: '当前在 /x' }));
    await handleStreamEvent(evt('text_complete', { turnId: 'turn-A' }));
    const orders = appendMessage.mock.calls.map((c: any[]) => ({
      kind: c[4]?.thinking ? 'think' : Array.isArray(c[4]?.tool_calls) ? 'tool_call' : c[0] === 'tool' ? 'tool' : 'text',
      order: c[4]?.stream_order,
    }));
    expect(orders).toEqual([
      { kind: 'think', order: 1 },
      { kind: 'tool_call', order: 2 },
      { kind: 'tool', order: 3 },
      { kind: 'think', order: 4 },
      { kind: 'text', order: 5 },
    ]);
  });

  it('心跳重播的 run_state_changed 不铸新 turnId (电平重播零副作用)', async () => {
    /* 不带真 turnId 的开轮事件 → 铸一个合成 id */
    await handleStreamEvent(evt('run_state_changed', {
      data: { status: 'running', updatedAt: 1000 },
      status: 'running',
    }));
    const mintedTurnId = getSessionCurrentTurnId('s1');
    expect(mintedTurnId).toMatch(/^turn-/);

    /* 心跳重播同一电平 (同样不带真 turnId) — 必须复用当前轮, 不能再铸 */
    for (let i = 0; i < 3; i++) {
      await handleStreamEvent(evt('run_state_changed', {
        data: { status: 'running', updatedAt: 1000 },
        status: 'running',
        heartbeat: true,
      }));
    }
    expect(getSessionCurrentTurnId('s1')).toBe(mintedTurnId);
  });

  it('text_complete 用累积值落 drift 且推 done (合帧不丢账)', async () => {
    await startTurn();
    await handleStreamEvent(evt('token', { turnId: 'turn-A', content: 'full ' }));
    await handleStreamEvent(evt('token', { turnId: 'turn-A', content: 'answer' }));
    await handleStreamEvent(evt('text_complete', { turnId: 'turn-A' }));
    expect(appendMessage).toHaveBeenCalledWith(
      'assistant', 'full answer', 'turn-A', 1000,
      expect.objectContaining({ content: 'full answer' }),
    );
    expect(pushed.map((p) => p.kind)).toContain('agent_text_done');
  });

  it('ask 作废后待办快照也要撤 —— 手机重连不该再把已死的卡画回来', async () => {
    await startTurn();
    await handleStreamEvent(evt('ask_user_needed', {
      requestId: 'ask-1',
      questions: [{ question: '选哪个?' }],
    }));
    expect(getPendingActions('s1').ask_user).toHaveLength(1);

    await handleStreamEvent(evt('ask_user_expired', {
      requestId: 'ask-1',
      timeoutSec: 60,
      reason: 'timeout',
    }));

    /* 快照里留着已死的 ask = 手机重连时卡片又回来 */
    expect(getPendingActions('s1').ask_user).toEqual([]);
    /* 当时在线的手机仍然要收到那条事件 (翻成"已超时"), 不能因为撤快照就不推了 */
    expect(pushed.map((p) => p.kind)).toContain('ask_user_expired');
  });
});
