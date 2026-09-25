import { describe, expect, it, vi } from 'vitest';
import { NeoxError, ErrorCategory } from '@neoxlabs/kernel/types/errors.js';
import { RuntimeOrchestrator, type RuntimeOrchestratorOptions } from '../runtimeOrchestrator.js';

/* E1 回归: manual provider (非 auto-route) 遇到 fatal_auth/fatal_limit 时,
 *   orchestrator 自动切 listAlternateProviders 给的下一家, 不整段废掉.
 *   用户 22:50:56 balance 掉线 27 iter 全丢的场景。 */

/** Mock hostService: 按 providerId 决定 runTask 抛什么错或返成功. */
function makeMockHostService(scenarios: Record<string, () => any>) {
  return {
    async runTask(config: any) {
      const providerId = config.provider?.id;
      const handler = scenarios[providerId];
      if (!handler) throw new Error(`No mock scenario for provider ${providerId}`);
      return handler();
    },
  } as any;
}

function makeMockResolveProvider(providers: Array<{ id: string; model: string }>): RuntimeOrchestratorOptions['resolveProvider'] {
  return (providerId?: string, modelName?: string) => {
    const p = providers.find(x => x.id === providerId);
    if (!p) return { provider: null, llmConfig: null };
    return {
      provider: { id: p.id, name: p.id, protocol: 'openai', apiKey: 'x', models: [{ name: p.model }] } as any,
      llmConfig: { model: modelName ?? p.model, providerName: p.id } as any,
    };
  };
}

const RUN_OPTS_BASE = {
  sessionId: 'sess-1',
  prompt: 'hi',
  /* 把 provider 透传给 hostConfig, mock hostService.runTask 才能按 providerId 路由 */
  buildHostConfig: (provider: any, llmConfig: any) => ({ provider, llmConfig } as any),
  startedAt: Date.now(),
};

describe('RuntimeOrchestrator manual-fallback on fatal_auth/fatal_limit', () => {
  it('switches to next alternate provider on fatal_auth', async () => {
    const scenarios = {
      'primary': () => { throw new NeoxError({ category: ErrorCategory.FATAL_AUTH, code: 'FORBIDDEN', message: 'Access denied', retryable: false }); },
      'backup':  () => ({ finalOutput: 'ok', taskUsed: 42, iterations: 1, totalTokens: 10 }),
    };
    const alternates = vi.fn().mockReturnValue([{ providerId: 'backup', modelName: 'claude-opus-4-6' }]);
    const statuses: string[] = [];

    const orch = new RuntimeOrchestrator({
      hostService: makeMockHostService(scenarios),
      resolveProvider: makeMockResolveProvider([
        { id: 'primary', model: 'claude-opus-4-6' },
        { id: 'backup', model: 'claude-opus-4-6' },
      ]),
      listAlternateProviders: alternates,
    });

    const result = await orch.runSession({
      ...RUN_OPTS_BASE,
      providerId: 'primary',
      modelName: 'claude-opus-4-6',
      onStatus: (_l, msg) => { statuses.push(msg); },
    });

    expect(result.providerId).toBe('backup');
    expect(alternates).toHaveBeenCalledWith('primary', 'claude-opus-4-6');
    /* 用户可见的切换提示 */
    expect(statuses.some(s => s.includes('switching to backup'))).toBe(true);
    expect(statuses.some(s => s.includes('Recovered on fallback provider: backup'))).toBe(true);
  });

  it('switches on fatal_limit (quota exhausted)', async () => {
    const scenarios = {
      'primary': () => { throw new NeoxError({ category: ErrorCategory.FATAL_LIMIT, code: 'QUOTA_EXCEEDED', message: 'insufficient balance', retryable: false }); },
      'backup':  () => ({ finalOutput: 'ok', taskUsed: 0, iterations: 1, totalTokens: 0 }),
    };
    const orch = new RuntimeOrchestrator({
      hostService: makeMockHostService(scenarios),
      resolveProvider: makeMockResolveProvider([
        { id: 'primary', model: 'claude-opus-4-6' },
        { id: 'backup', model: 'claude-opus-4-6' },
      ]),
      listAlternateProviders: () => [{ providerId: 'backup', modelName: 'claude-opus-4-6' }],
    });

    const result = await orch.runSession({
      ...RUN_OPTS_BASE,
      providerId: 'primary',
      modelName: 'claude-opus-4-6',
    });
    expect(result.providerId).toBe('backup');
  });

  it('does NOT switch on retryable errors (leaves to runner stream-retry)', async () => {
    /* retryable_stream / retryable_network 类不属于 fatal, 由 runner 内部 stream-retry 兜, orchestrator 不 fallback. */
    const scenarios = {
      'primary': () => { throw new NeoxError({ category: ErrorCategory.RETRYABLE_STREAM, code: 'STREAM_DISCONNECT', message: 'stream error', retryable: true }); },
      'backup':  () => ({ finalOutput: 'ok', taskUsed: 0, iterations: 1, totalTokens: 0 }),
    };
    const alternates = vi.fn().mockReturnValue([{ providerId: 'backup', modelName: 'claude-opus-4-6' }]);
    const orch = new RuntimeOrchestrator({
      hostService: makeMockHostService(scenarios),
      resolveProvider: makeMockResolveProvider([
        { id: 'primary', model: 'claude-opus-4-6' },
        { id: 'backup', model: 'claude-opus-4-6' },
      ]),
      listAlternateProviders: alternates,
    });

    await expect(orch.runSession({
      ...RUN_OPTS_BASE,
      providerId: 'primary',
      modelName: 'claude-opus-4-6',
    })).rejects.toThrow(/stream error/);
    /* fallback 探测函数即使被调也不该有第二次 attempt (retryable 直接 rethrow) */
  });

  it('throws original error when alternates empty', async () => {
    const scenarios = {
      'primary': () => { throw new NeoxError({ category: ErrorCategory.FATAL_AUTH, code: 'FORBIDDEN', message: 'access denied', retryable: false }); },
    };
    const orch = new RuntimeOrchestrator({
      hostService: makeMockHostService(scenarios),
      resolveProvider: makeMockResolveProvider([{ id: 'primary', model: 'claude-opus-4-6' }]),
      listAlternateProviders: () => [],
    });
    await expect(orch.runSession({
      ...RUN_OPTS_BASE,
      providerId: 'primary',
      modelName: 'claude-opus-4-6',
    })).rejects.toThrow(/access denied/);
  });

  it('throws when listAlternateProviders not configured (旧行为兜底)', async () => {
    const scenarios = {
      'primary': () => { throw new NeoxError({ category: ErrorCategory.FATAL_AUTH, code: 'FORBIDDEN', message: 'access denied', retryable: false }); },
    };
    const orch = new RuntimeOrchestrator({
      hostService: makeMockHostService(scenarios),
      resolveProvider: makeMockResolveProvider([{ id: 'primary', model: 'claude-opus-4-6' }]),
      /* 完全不传 listAlternateProviders */
    });
    await expect(orch.runSession({
      ...RUN_OPTS_BASE,
      providerId: 'primary',
      modelName: 'claude-opus-4-6',
    })).rejects.toThrow(/access denied/);
  });

  it('exhausts all alternates when every provider fails fatally, throws last error', async () => {
    const scenarios = {
      'primary': () => { throw new NeoxError({ category: ErrorCategory.FATAL_AUTH, code: 'FORBIDDEN', message: 'auth 1', retryable: false }); },
      'backup1': () => { throw new NeoxError({ category: ErrorCategory.FATAL_LIMIT, code: 'QUOTA_EXCEEDED', message: 'quota 2', retryable: false }); },
      'backup2': () => { throw new NeoxError({ category: ErrorCategory.FATAL_AUTH, code: 'FORBIDDEN', message: 'auth 3', retryable: false }); },
    };
    const orch = new RuntimeOrchestrator({
      hostService: makeMockHostService(scenarios),
      resolveProvider: makeMockResolveProvider([
        { id: 'primary', model: 'claude-opus-4-6' },
        { id: 'backup1', model: 'claude-opus-4-6' },
        { id: 'backup2', model: 'claude-opus-4-6' },
      ]),
      listAlternateProviders: () => [
        { providerId: 'backup1', modelName: 'claude-opus-4-6' },
        { providerId: 'backup2', modelName: 'claude-opus-4-6' },
      ],
    });
    /* 最后一家的 error 抛出 (auth 3), 而不是首家 */
    await expect(orch.runSession({
      ...RUN_OPTS_BASE,
      providerId: 'primary',
      modelName: 'claude-opus-4-6',
    })).rejects.toThrow(/auth 3/);
  });
});

describe('403 error classification: balance/quota → FATAL_LIMIT', () => {
  /** 构造 axios-like error 塞给 classifyError */
  const mkAxios403 = (message: string) => {
    const err: any = new Error(message);
    err.isAxiosError = true;
    err.response = { status: 403, headers: {}, data: { error: { message } } };
    return err;
  };

  it('classifies "insufficient balance" as FATAL_LIMIT not FATAL_AUTH', async () => {
    const { classifyError } = await import('@neoxlabs/kernel/types/errors.js');
    const err = classifyError(mkAxios403('insufficient balance'));
    expect(err.category).toBe(ErrorCategory.FATAL_LIMIT);
    expect(err.code).toBe('QUOTA_EXCEEDED');
  });

  it('classifies "quota exceeded" as FATAL_LIMIT', async () => {
    const { classifyError } = await import('@neoxlabs/kernel/types/errors.js');
    const err = classifyError(mkAxios403('You have exceeded your quota'));
    expect(err.category).toBe(ErrorCategory.FATAL_LIMIT);
  });

  it('classifies "invalid api key" (403) still as FATAL_AUTH', async () => {
    const { classifyError } = await import('@neoxlabs/kernel/types/errors.js');
    const err = classifyError(mkAxios403('Invalid API key'));
    expect(err.category).toBe(ErrorCategory.FATAL_AUTH);
    expect(err.code).toBe('FORBIDDEN');
  });
});
