/**
 * 后台 agent 止损护栏单测 — 硬超时 + token 熔断 + abort(reason) 透传。
 * 常量在模块加载时读 env, 所以全部用 vi.resetModules + 动态 import。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../shell/backgroundTaskNotifier.js', () => ({
  getBackgroundTaskNotifier: () => ({ enqueueMessageForSession: vi.fn() }),
}));
vi.mock('../../agentThreadContext.js', () => ({
  getAgentThreadContext: () => ({ checkCanSpawnOrThrow: () => {} }),
}));
vi.mock('@neoxlabs/platform/platform/osNotifier.js', () => ({ sendOsNotification: vi.fn() }));

async function freshManager(env: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const mod = await import('../backgroundAgent.js');
  return new mod.BackgroundAgentManager();
}

describe('BackgroundAgentManager limits', () => {
  beforeEach(() => {
    delete process.env.NEOX_AGENT_MAX_OUTPUT_TOKENS;
    delete process.env.NEOX_AGENT_HARD_TIMEOUT_MS;
  });

  it('token 熔断: token_usage 超上限当场 abort 并带原因', async () => {
    const mgr = await freshManager({ NEOX_AGENT_MAX_OUTPUT_TOKENS: '1000', NEOX_AGENT_HARD_TIMEOUT_MS: '600000' });
    const task = mgr.register('agent-tok', 'desc', 'prompt');
    mgr.updateProgress(task.agentId, { type: 'token_usage', outputTokens: 2000 });
    expect(task.status).toBe('aborted');
    expect(task.error).toContain('Token 熔断');
    expect(task.abortController.signal.aborted).toBe(true);
  });

  it('硬超时: sweep 扫到超龄任务 abort 并带原因', async () => {
    const mgr = await freshManager({ NEOX_AGENT_HARD_TIMEOUT_MS: '60000', NEOX_AGENT_MAX_OUTPUT_TOKENS: '0' });
    const task = mgr.register('agent-slow', 'desc', 'prompt');
    task.startedAt = Date.now() - 61_000;
    (mgr as any).sweepLimits();
    expect(task.status).toBe('aborted');
    expect(task.error).toContain('硬超时');
  });

  it('两个护栏都设 0 时不熔断', async () => {
    const mgr = await freshManager({ NEOX_AGENT_HARD_TIMEOUT_MS: '0', NEOX_AGENT_MAX_OUTPUT_TOKENS: '0' });
    const task = mgr.register('agent-free', 'desc', 'prompt');
    task.startedAt = Date.now() - 3_600_000;
    mgr.updateProgress(task.agentId, { type: 'token_usage', outputTokens: 10_000_000 });
    (mgr as any).sweepLimits();
    expect(task.status).toBe('running');
  });

  it('abort(reason) 透传到 task.error; 没给原因时如实说"未记录", 不冒充用户中断', async () => {
    const mgr = await freshManager({});
    const a = mgr.register('agent-a', 'desc', 'prompt');
    const b = mgr.register('agent-b', 'desc', 'prompt');
    const c = mgr.register('agent-c', 'desc', 'prompt');
    mgr.abort(a.agentId, '自定义原因');
    mgr.abort(b.agentId);
    mgr.abort(c.agentId, undefined, false, 'user');
    expect(a.error).toBe('自定义原因');
    expect(b.error).toContain('未记录');
    expect(b.error).not.toMatch(/user aborted/i);
    /* 明确标了是用户操作的, 才允许说"用户停止" */
    expect(c.error).toBe('用户停止');
  });
});
