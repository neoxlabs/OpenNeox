import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SideAgentConfig } from '@neoxlabs/platform/utils/config.js';

const queryFnHolder: { fn: ReturnType<typeof vi.fn> | null } = { fn: null };

vi.mock('../claude/ClaudeSideAgentService.js', () => {
  return {
    ClaudeSideAgentService: class {
      // 实例化时把 holder 里的 fn 暴露成实例方法,后续 setupAdapter 可重设 holder.fn
      query = (...args: unknown[]) => queryFnHolder.fn!(...args);
    },
  };
});

// 必须在 vi.mock 之后再 import 被测模块,否则拿到的是真实 ClaudeSideAgentService
const { createClaudeSideAgentAdapter } = await import('../claude/sideAgentAdapterImpl.js');

function setupAdapter(opts: {
  config?: SideAgentConfig;
  sessionRoute?: { providerId: string; modelName: string } | null;
  taskAgentRoute?: { providerId: string; modelName: string } | null;
  queryResult?: { text?: string | null; modelName?: string };
  queryError?: Error;
  persistSessionTitle?: ReturnType<typeof vi.fn>;
}) {
  const queryFn = vi.fn(async () => {
    if (opts.queryError) throw opts.queryError;
    return {
      providerId: 'anthropic-main',
      modelName: opts.queryResult?.modelName ?? 'claude-haiku-4-5-20251001',
      text: opts.queryResult?.text ?? 'Edited userService',
      reason: 'mock',
    };
  });
  queryFnHolder.fn = queryFn;

  const adapter = createClaudeSideAgentAdapter({
    getSessionRoute: () => opts.sessionRoute ?? { providerId: 'anthropic-main', modelName: 'claude-opus-4-6' },
    getTaskAgentRoute: opts.taskAgentRoute !== undefined ? () => opts.taskAgentRoute! : undefined,
    getSideAgentConfig: () => opts.config,
    resolveProvider: () => ({ provider: null, llmConfig: null }),
    persistSessionTitle: opts.persistSessionTitle,
  });

  return { adapter, queryFn };
}

afterEach(() => {
  vi.clearAllMocks();
  queryFnHolder.fn = null;
});

describe('createClaudeSideAgentAdapter — toolUseSummary', () => {
  it('没配置时**不**触发 —— opt-in, 缺省关', async () => {
    const emit = vi.fn();
    const { adapter, queryFn } = setupAdapter({});
    adapter.scheduleToolBatchSummary!({
      batchId: 'b1',
      toolCalls: [{ name: 'edit', success: true, args: {}, outputPreview: 'ok' }],
      emit,
    });
    await new Promise((r) => setImmediate(r));
    expect(queryFn).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('显式打开时才触发', async () => {
    const emit = vi.fn();
    const { adapter, queryFn } = setupAdapter({ config: { enabled: true, features: { toolUseSummary: true } } });
    adapter.scheduleToolBatchSummary!({
      batchId: 'b1',
      toolCalls: [{ name: 'edit', success: true, args: {}, outputPreview: 'ok' }],
      emit,
    });
    await new Promise((r) => setImmediate(r));
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('Edited userService');
  });

  it('skips when sideAgent.enabled=false', () => {
    const emit = vi.fn();
    const { adapter, queryFn } = setupAdapter({ config: { enabled: false } });
    adapter.scheduleToolBatchSummary!({
      batchId: 'b1',
      toolCalls: [{ name: 'edit', success: true }],
      emit,
    });
    expect(queryFn).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('skips when features.toolUseSummary=false', () => {
    const emit = vi.fn();
    const { adapter, queryFn } = setupAdapter({
      config: { enabled: true, features: { toolUseSummary: false } },
    });
    adapter.scheduleToolBatchSummary!({
      batchId: 'b1',
      toolCalls: [{ name: 'edit', success: true }],
      emit,
    });
    expect(queryFn).not.toHaveBeenCalled();
  });

  it('uses configured providerId/model when present', async () => {
    const emit = vi.fn();
    const { adapter, queryFn } = setupAdapter({
      /* opt-in 后必须显式开 —— 这条测的是路由解析, 不是开关本身 */
      config: { providerId: 'openai-main', model: 'gpt-4o-mini', features: { toolUseSummary: true } },
    });
    adapter.scheduleToolBatchSummary!({
      batchId: 'b1',
      toolCalls: [{ name: 'edit', success: true }],
      emit,
    });
    await new Promise((r) => setImmediate(r));
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(queryFn.mock.calls[0][0].providerId).toBe('openai-main');
    expect(queryFn.mock.calls[0][0].modelName).toBe('gpt-4o-mini');
  });

  it('falls back to taskAgent route before sessionRoute when sideAgent has no providerId/model', async () => {
    const emit = vi.fn();
    const { adapter, queryFn } = setupAdapter({
      config: { features: { toolUseSummary: true } },   /* opt-in: 显式开 */
      taskAgentRoute: { providerId: 'task-provider', modelName: 'task-model' },
      sessionRoute: { providerId: 'session-provider', modelName: 'session-model' },
    });
    adapter.scheduleToolBatchSummary!({
      batchId: 'b1',
      toolCalls: [{ name: 'edit', success: true }],
      emit,
    });
    await new Promise((r) => setImmediate(r));
    expect(queryFn.mock.calls[0][0].providerId).toBe('task-provider');
    expect(queryFn.mock.calls[0][0].modelName).toBe('task-model');
  });

  it('falls back to session route when no config providerId/model', async () => {
    const emit = vi.fn();
    const { adapter, queryFn } = setupAdapter({
      config: { features: { toolUseSummary: true } },   /* opt-in: 显式开 */
      sessionRoute: { providerId: 'anthropic-main', modelName: 'claude-opus-4-6' },
    });
    adapter.scheduleToolBatchSummary!({
      batchId: 'b1',
      toolCalls: [{ name: 'edit', success: true }],
      emit,
    });
    await new Promise((r) => setImmediate(r));
    expect(queryFn.mock.calls[0][0].providerId).toBe('anthropic-main');
    expect(queryFn.mock.calls[0][0].modelName).toBe('claude-opus-4-6');
  });

  it('does not emit when query returns empty text', async () => {
    const emit = vi.fn();
    const { adapter } = setupAdapter({ queryResult: { text: '   ' } });
    adapter.scheduleToolBatchSummary!({
      batchId: 'b1',
      toolCalls: [{ name: 'edit', success: true }],
      emit,
    });
    await new Promise((r) => setImmediate(r));
    expect(emit).not.toHaveBeenCalled();
  });

  it('swallows query errors silently (does not throw)', async () => {
    const emit = vi.fn();
    const { adapter } = setupAdapter({ queryError: new Error('upstream 500') });
    expect(() => {
      adapter.scheduleToolBatchSummary!({
        batchId: 'b1',
        toolCalls: [{ name: 'edit', success: true }],
        emit,
      });
    }).not.toThrow();
    await new Promise((r) => setImmediate(r));
    expect(emit).not.toHaveBeenCalled();
  });
});

describe('createClaudeSideAgentAdapter — sessionTitle', () => {
  it('triggers query and persists when callback provided', async () => {
    const persist = vi.fn();
    const emit = vi.fn();
    const { adapter, queryFn } = setupAdapter({
      queryResult: { text: 'Refactor auth middleware' },
      persistSessionTitle: persist,
    });
    adapter.scheduleSessionTitle!({
      sessionId: 'sess-1',
      firstUserMessage: 'help me refactor auth',
      emit,
    });
    await new Promise((r) => setImmediate(r));
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('Refactor auth middleware');
    expect(persist).toHaveBeenCalledWith('sess-1', 'Refactor auth middleware', {
      aggregatedFromUserMessages: undefined,
      expectedCurrentTitle: undefined,
    });
  });

  it('skips when features.sessionTitle=false', () => {
    const emit = vi.fn();
    const { adapter, queryFn } = setupAdapter({
      config: { features: { sessionTitle: false } },
    });
    adapter.scheduleSessionTitle!({
      sessionId: 'sess-1',
      firstUserMessage: 'hi',
      emit,
    });
    expect(queryFn).not.toHaveBeenCalled();
  });

  it('strips wrapping quotes and trims long titles', async () => {
    const emit = vi.fn();
    const { adapter } = setupAdapter({
      queryResult: { text: '"添加暗色模式开关"' },
    });
    adapter.scheduleSessionTitle!({
      sessionId: 'sess-1',
      firstUserMessage: '加暗色模式',
      emit,
    });
    await new Promise((r) => setImmediate(r));
    expect(emit).toHaveBeenCalledWith('添加暗色模式开关');
  });
});
