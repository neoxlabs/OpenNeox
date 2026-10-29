import { describe, expect, it, vi } from 'vitest';
import { RuntimeEventForwarder } from '../runtimeEventForwarder.js';

describe('RuntimeEventForwarder', () => {
  it('preserves per-explorer progress without overwriting the main request dial', () => {
    const emitStream = vi.fn();
    const forwarder = new RuntimeEventForwarder({ emitStream } as any);
    const data = { iterations: 3, tokens: 12340, tokensEstimated: false, startedAt: 1000, elapsed: 42000 };
    forwarder.forward('parent-session', {
      type: 'worker_event',
      agentId: 'Explorer-2',
      taskAgentId: 'Explorer-2',
      eventType: 'explore_progress',
      data,
    } as any, { contextUsed: 500, startTime: Date.now(), provider: 'test', model: 'test' });
    expect(emitStream).toHaveBeenCalledWith(expect.objectContaining({
      type: 'worker_event', sessionId: 'parent-session',
      agentId: 'Explorer-2', taskAgentId: 'Explorer-2', eventType: 'explore_progress', data,
    }));
    expect(emitStream.mock.calls.some(([event]) => event.type === 'metrics')).toBe(false);
  });

  it('parses tool_call_start arguments JSON into args object', () => {
    const emitStream = vi.fn();
    const forwarder = new RuntimeEventForwarder({ emitStream } as any);

    forwarder.forward('session-1', {
      type: 'tool_call_start',
      name: 'edit_file',
      arguments: JSON.stringify({ file_path: 'src/App.tsx', old_string: 'a', new_string: 'b' }),
      timestamp: Date.now(),
    } as any, {
      contextUsed: 0,
      startTime: Date.now(),
      provider: 'test',
      model: 'test',
    });

    expect(emitStream).toHaveBeenCalledWith(expect.objectContaining({
      type: 'tool_call',
      toolName: 'edit_file',
      args: expect.objectContaining({ file_path: 'src/App.tsx' }),
    }));
  });

  it('forwards turn_complete for assistant mode completion', () => {
    const emitStream = vi.fn();
    const forwarder = new RuntimeEventForwarder({ emitStream } as any);

    forwarder.forward('session-1', {
      type: 'turn_complete',
      output: 'hello from assistant',
      timestamp: Date.now(),
    } as any, {
      contextUsed: 0,
      startTime: Date.now(),
      provider: 'test',
      model: 'test',
    });

    expect(emitStream).toHaveBeenCalledWith(expect.objectContaining({
      type: 'turn_complete',
      sessionId: 'session-1',
      output: 'hello from assistant',
    }));
  });

  it('forwards approval_cancelled to stream', () => {
    const emitStream = vi.fn();
    const forwarder = new RuntimeEventForwarder({ emitStream } as any);

    forwarder.forward('session-1', {
      type: 'approval_cancelled',
      requestId: 'perm_123',
      reason: 'resolved',
      approved: true,
      timestamp: Date.now(),
    } as any, {
      contextUsed: 0,
      startTime: Date.now(),
      provider: 'test',
      model: 'test',
    });

    expect(emitStream).toHaveBeenCalledWith(expect.objectContaining({
      type: 'approval_cancelled',
      sessionId: 'session-1',
      requestId: 'perm_123',
      reason: 'resolved',
      approved: true,
    }));
  });

  it('promotes Main worker plan_update to top-level stream event', () => {
    const emitStream = vi.fn();
    const forwarder = new RuntimeEventForwarder({ emitStream } as any);

    forwarder.forward('session-1', {
      type: 'worker_event',
      agentId: 'Main',
      event: {
        type: 'plan_update',
        explanation: 'plan explain',
        plan: [{ step: 'A', status: 'in_progress' }],
      },
      timestamp: Date.now(),
    } as any, {
      contextUsed: 0,
      startTime: Date.now(),
      provider: 'test',
      model: 'test',
    });

    expect(emitStream).toHaveBeenCalledWith(expect.objectContaining({
      type: 'plan_update',
      sessionId: 'session-1',
      explanation: 'plan explain',
      plan: [{ step: 'A', status: 'in_progress' }],
    }));
  });

  it('emits warning status when edit_file arguments stream gets too large', () => {
    const emitStream = vi.fn();
    const forwarder = new RuntimeEventForwarder({ emitStream } as any);
    const tracker = {
      contextUsed: 0,
      startTime: Date.now(),
      provider: 'test',
      model: 'test',
    };

    forwarder.forward('session-1', {
      type: 'tool_call_delta',
      name: 'edit_file',
      argumentsDelta: 'x'.repeat(6100),
      timestamp: Date.now(),
    } as any, tracker);

    expect(emitStream).toHaveBeenCalledWith(expect.objectContaining({
      type: 'status',
      level: 'warning',
      message: expect.stringContaining('edit 参数过大'),
    }));
  });

  it('forwards edit_file_stream with startLine and failure metadata', () => {
    const emitStream = vi.fn();
    const forwarder = new RuntimeEventForwarder({ emitStream } as any);

    forwarder.forward('session-1', {
      type: 'edit_file_stream',
      filePath: 'src/a.ts',
      oldString: 'const a = 1;',
      newString: 'const a = 2;',
      startLine: 12,
      isComplete: true,
      success: false,
      errorMessage: 'File not found',
      timestamp: Date.now(),
    } as any, {
      contextUsed: 0,
      startTime: Date.now(),
      provider: 'test',
      model: 'test',
    });

    expect(emitStream).toHaveBeenCalledWith(expect.objectContaining({
      type: 'edit_file_stream',
      sessionId: 'session-1',
      filePath: 'src/a.ts',
      startLine: 12,
      success: false,
      errorMessage: 'File not found',
    }));
  });

  it('promotes Main worker edit_file_stream keeping status and line', () => {
    const emitStream = vi.fn();
    const forwarder = new RuntimeEventForwarder({ emitStream } as any);

    forwarder.forward('session-1', {
      type: 'worker_event',
      agentId: 'Main',
      event: {
        type: 'edit_file_stream',
        toolId: 'tool-edit-1',
        filePath: 'src/b.ts',
        oldString: 'x',
        newString: 'y',
        startLine: 8,
        isComplete: true,
        success: false,
        errorMessage: 'anchor mismatch',
      },
      timestamp: Date.now(),
    } as any, {
      contextUsed: 0,
      startTime: Date.now(),
      provider: 'test',
      model: 'test',
    });

    expect(emitStream).toHaveBeenCalledWith(expect.objectContaining({
      type: 'edit_file_stream',
      sessionId: 'session-1',
      toolId: 'tool-edit-1',
      filePath: 'src/b.ts',
      startLine: 8,
      success: false,
      errorMessage: 'anchor mismatch',
    }));
  });

  it('forwards queued message events to stream', () => {
    const emitStream = vi.fn();
    const forwarder = new RuntimeEventForwarder({ emitStream } as any);
    const tracker = {
      contextUsed: 0,
      startTime: Date.now(),
      provider: 'test',
      model: 'test',
    };

    forwarder.forward('session-1', {
      type: 'queued_message_added',
      position: 2,
      text: '继续看 watcher 的收尾逻辑',
      timestamp: Date.now(),
    } as any, tracker);

    expect(emitStream).toHaveBeenCalledWith(expect.objectContaining({
      type: 'queued_message_added',
      sessionId: 'session-1',
      position: 2,
      text: '继续看 watcher 的收尾逻辑',
    }));
  });


  it('drops stale sequenced events by default', () => {
    const emitStream = vi.fn();
    const forwarder = new RuntimeEventForwarder({ emitStream } as any);
    const tracker = {
      contextUsed: 0,
      startTime: Date.now(),
      provider: 'test',
      model: 'test',
    };

    forwarder.forward('session-1', {
      type: 'turn_complete',
      output: 'fresh',
      sequence: 100,
      timestamp: Date.now(),
    } as any, tracker);

    forwarder.forward('session-1', {
      type: 'turn_complete',
      output: 'stale',
      sequence: 99,
      timestamp: Date.now(),
    } as any, tracker);

    expect(emitStream).toHaveBeenCalledTimes(1);
    expect(emitStream).toHaveBeenCalledWith(expect.objectContaining({
      type: 'turn_complete',
      output: 'fresh',
      sequence: 100,
    }));
  });


  it('does not treat local synthetic sequence as stale runtime sequence', () => {
    const emitStream = vi.fn();
    const forwarder = new RuntimeEventForwarder({ emitStream } as any);
    const tracker = {
      contextUsed: 0,
      startTime: Date.now(),
      provider: 'test',
      model: 'test',
    };

    // Unsequenced runtime/local events allocate an outgoing UI sequence.
    forwarder.forward('session-1', {
      type: 'text',
      delta: 'prelude',
      timestamp: Date.now(),
    } as any, tracker);

    // The first real runtime sequenced event is also sequence=1. This must be accepted;
    // otherwise desktop drops run-start/status and can stay stuck in running state.
    forwarder.forward('session-1', {
      type: 'status',
      status: 'info',
      message: 'Starting task...',
      sequence: 1,
      timestamp: Date.now(),
    } as any, tracker);

    expect(emitStream).toHaveBeenCalledWith(expect.objectContaining({
      type: 'status',
      message: 'Starting task...',
    }));
  });

  it('records first-token latency (TTFT) into metrics and token_usage (chat:C8-11)', async () => {
    const emitStream = vi.fn();
    const tokenUsage = {
      recordUsage: vi.fn(async () => {}),
      getSessionSummary: vi.fn(() => ({
        requests: 1,
        inputTokens: 10,
        baseInputTokens: 5,
        outputTokens: 5,
        totalTokens: 15,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        hitRate: 0,
      })),
    };
    const forwarder = new RuntimeEventForwarder({ emitStream, tokenUsage } as any);
    const t0 = 1_000_000;
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(t0);
    const tracker: any = { contextUsed: 0, startTime: t0, provider: 'DeepSeek', model: 'deepseek-v4.1-flash' };

    /* 回合起点: 首个 thinking */
    forwarder.forward('session-ttft', { type: 'status', status: 'thinking' } as any, tracker);

    /* 350ms 后首个可见正文 */
    nowSpy.mockReturnValue(t0 + 350);
    forwarder.forward('session-ttft', { type: 'token', content: '你' } as any, tracker);

    /* 又 250ms 后末个 token → 生成窗口 250ms */
    nowSpy.mockReturnValue(t0 + 600);
    forwarder.forward('session-ttft', { type: 'token', content: '好' } as any, tracker);

    /* 这一轮结算 */
    nowSpy.mockReturnValue(t0 + 700);
    forwarder.forward('session-ttft', {
      type: 'token_usage',
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      contextTokens: 10,
      timestamp: t0 + 700,
    } as any, tracker);

    const metrics = emitStream.mock.calls
      .map(args => args[0])
      .filter((e: any) => e.type === 'metrics' && !e.sessionUsageOnly);
    expect(metrics).toHaveLength(1);
    expect(metrics[0].firstTokenMs).toBe(350);
    expect(metrics[0].generationMs).toBe(250);

    /* 入库: first_token_ms / generation_ms 一起写 (桌面 token_usage) */
    expect(tokenUsage.recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      model: 'deepseek-v4.1-flash',
      firstTokenMs: 350,
      generationMs: 250,
      success: true,
    }));

    /* 结算后复位: 下一轮重新从 0 开始计时 */
    expect(tracker.turnStartTime).toBeUndefined();
    expect(tracker.firstTokenTime).toBeUndefined();
    expect(tracker.lastTokenTime).toBeUndefined();

    nowSpy.mockRestore();
  });

  it('accumulates session usage across token_usage events with DB seed', () => {
    const emitStream = vi.fn();
    const tokenUsage = {
      recordUsage: vi.fn(async () => {}),
      getSessionSummary: vi.fn(() => ({
        requests: 2,
        inputTokens: 100,
        baseInputTokens: 50,
        outputTokens: 10,
        totalTokens: 110,
        cacheReadTokens: 40,
        cacheWriteTokens: 10,
        hitRate: 0.4,
      })),
    };
    const forwarder = new RuntimeEventForwarder({ emitStream, tokenUsage } as any);
    const tracker = { contextUsed: 0, startTime: Date.now(), provider: 'test', model: 'test' };

    forwarder.forward('session-1', {
      type: 'token_usage',
      promptTokens: 20,
      completionTokens: 5,
      totalTokens: 125,
      cacheReadTokens: 70,
      cacheWriteTokens: 0,
      contextTokens: 90,
      breakdown: { systemTokens: 40, messageTokens: 20, toolTokens: 30, totalTokens: 90, details: { systemPromptTokens: 40 } },
      timestamp: Date.now(),
    } as any, tracker);

    // DB 种子只读一次
    expect(tokenUsage.getSessionSummary).toHaveBeenCalledTimes(1);
    // 种子(50/40/10, 2req) + 本轮(20/70/0) = 70/110/10, 3req
    expect(emitStream).toHaveBeenCalledWith(expect.objectContaining({
      type: 'metrics',
      sessionId: 'session-1',
      sessionUsage: expect.objectContaining({
        requests: 3,
        baseInputTokens: 70,
        cacheReadTokens: 110,
        cacheWriteTokens: 10,
        outputTokens: 15,
      }),
    }));

    forwarder.forward('session-1', {
      type: 'token_usage',
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 115,
      cacheReadTokens: 90,
      cacheWriteTokens: 0,
      contextTokens: 100,
      breakdown: { systemTokens: 40, messageTokens: 25, toolTokens: 35, totalTokens: 100, details: { systemPromptTokens: 40 } },
      timestamp: Date.now(),
    } as any, tracker);

    expect(tokenUsage.getSessionSummary).toHaveBeenCalledTimes(1);
    const metricsCalls = emitStream.mock.calls
      .map(args => args[0])
      .filter((e: any) => e.type === 'metrics');
    expect(metricsCalls[metricsCalls.length - 1].sessionUsage).toMatchObject({
      requests: 4,
      baseInputTokens: 80,
      cacheReadTokens: 200,
      outputTokens: 20,
      // 累积 breakdown = 两轮逐字段求和 (details 递归)
      breakdown: {
        systemTokens: 80,
        messageTokens: 45,
        toolTokens: 65,
        totalTokens: 190,
        details: { systemPromptTokens: 80 },
      },
    });
  });

  it('side-agent token_usage only refreshes cumulative view, never the request dial', () => {
    const emitStream = vi.fn();
    const tokenUsage = {
      recordUsage: vi.fn(async () => {}),
      getSessionSummary: vi.fn(() => ({
        requests: 0, inputTokens: 0, baseInputTokens: 0, outputTokens: 0,
        totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, hitRate: 0,
      })),
    };
    const forwarder = new RuntimeEventForwarder({ emitStream, tokenUsage } as any);
    const tracker = { contextUsed: 500, startTime: Date.now(), provider: 'test', model: 'test' };

    forwarder.forward('session-1', {
      type: 'token_usage',
      taskAgentId: 'Explorer-1',
      promptTokens: 30,
      completionTokens: 8,
      totalTokens: 38,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      contextTokens: 30,
      timestamp: Date.now(),
    } as any, tracker);

    const metricsCalls = emitStream.mock.calls
      .map(args => args[0])
      .filter((e: any) => e.type === 'metrics');
    expect(metricsCalls).toHaveLength(1);
    expect(metricsCalls[0]).toMatchObject({
      sessionUsageOnly: true,
      tokens: 0,
      contextUsed: 0,
      sessionUsage: expect.objectContaining({
        requests: 1,
        baseInputTokens: 30,
        outputTokens: 8,
      }),
    });
    // 子 agent usage 不能动主表盘的 contextUsed
    expect(tracker.contextUsed).toBe(500);
  });

  it('accepts low sequence after reset hint and then resumes stale filtering', () => {
    const emitStream = vi.fn();
    const forwarder = new RuntimeEventForwarder({ emitStream } as any);
    const tracker = {
      contextUsed: 0,
      startTime: Date.now(),
      provider: 'test',
      model: 'test',
    };

    forwarder.forward('session-1', {
      type: 'turn_complete',
      output: 'before-reset',
      sequence: 100,
      timestamp: Date.now(),
    } as any, tracker);

    forwarder.markSessionSequenceResetHint('session-1');

    forwarder.forward('session-1', {
      type: 'turn_complete',
      output: 'after-reset',
      sequence: 1,
      timestamp: Date.now(),
    } as any, tracker);

    forwarder.forward('session-1', {
      type: 'turn_complete',
      output: 'duplicate-after-reset',
      sequence: 1,
      timestamp: Date.now(),
    } as any, tracker);

    expect(emitStream).toHaveBeenCalledTimes(2);
    expect(emitStream).toHaveBeenNthCalledWith(2, expect.objectContaining({
      type: 'turn_complete',
      output: 'after-reset',
      sequence: 1,
    }));
  });
});
