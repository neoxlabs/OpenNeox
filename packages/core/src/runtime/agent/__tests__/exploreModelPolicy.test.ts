import { describe, it, expect, vi } from 'vitest';
import { resolveClaudeSmallFastModelSelection, resolveExploreModelSelection } from '../exploreModelPolicy.js';
import { createAgenticModeTools } from '../agenticModeTools.js';
import { BackgroundAgentManager } from '../backgroundAgent.js';
import { PermissionManager } from '@neoxlabs/kernel/core/permissions/index.js';
import { ToolPermission } from '@neoxlabs/kernel/types/permissions.js';
import { ShortTermMemory as STM } from '@neoxlabs/kernel/memory/shortterm.js';

function createProvider(models: string[], extra: { protocol?: 'anthropic'; baseUrl?: string } = {}) {
  return {
    models: models.map(name => ({ name })),
    ...extra,
  };
}

function createRunSessionRecorder() {
  const calls: Array<{ providerId: string; modelName: string }> = [];
  const runSession = vi.fn(async ({ providerId, modelName }: any) => {
    calls.push({ providerId, modelName });
    return {
      summary: {
        output: 'ok',
        totalTokens: 0,
        durationMs: 1,
        iterations: 1,
        toolCalls: 0,
        interrupted: false,
        failed: false,
      },
      contextUsed: 0,
      providerId,
    };
  });
  return { runSession, calls };
}

describe('explore model policy', () => {
  it('uses manual explore config when provided', () => {
    const result = resolveExploreModelSelection({
      sessionProviderId: 'anthropic-main',
      sessionModelName: 'claude-sonnet-4-5-20250929',
      provider: createProvider(['claude-haiku-4-5-20251001']),
      configuredProviderId: 'anthropic-manual',
      configuredModelName: 'claude-3-5-haiku-20241022',
      claudeExploreUseHaiku: true,
    });

    expect(result).toMatchObject({
      providerId: 'anthropic-manual',
      modelName: 'claude-3-5-haiku-20241022',
      source: 'configured',
    });
  });

  it('switches Claude sessions to Haiku by default', () => {
    const result = resolveExploreModelSelection({
      sessionProviderId: 'anthropic-main',
      sessionModelName: 'claude-sonnet-4-5-20250929',
      provider: createProvider(['claude-haiku-4.5', 'claude-sonnet-4-5-20250929']),
      claudeExploreUseHaiku: true,
    });

    expect(result).toMatchObject({
      providerId: 'anthropic-main',
      modelName: 'claude-haiku-4.5',
      source: 'auto-haiku',
    });
  });

  it('defaults official Anthropic Claude side-queries to canonical Haiku', () => {
    const result = resolveClaudeSmallFastModelSelection({
      providerId: 'anthropic-main',
      modelName: 'claude-opus-4-6',
      provider: createProvider(['claude-opus-4-6'], {
        protocol: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
      }),
    });

    expect(result).toMatchObject({
      providerId: 'anthropic-main',
      modelName: 'claude-haiku-4-5-20251001',
      source: 'auto-haiku',
    });
  });

  it('uses the same Claude→Haiku rule for generic side queries', () => {
    const result = resolveClaudeSmallFastModelSelection({
      providerId: 'anthropic-main',
      modelName: 'claude-opus-4-6',
      provider: createProvider(['claude-haiku-4-5-20251001', 'claude-opus-4-6']),
    });

    expect(result).toMatchObject({
      providerId: 'anthropic-main',
      modelName: 'claude-haiku-4-5-20251001',
      source: 'auto-haiku',
    });
  });

  it('does not auto-fallback to Opus unless explicitly enabled', () => {
    const result = resolveClaudeSmallFastModelSelection({
      providerId: 'anthropic-main',
      modelName: 'claude-sonnet-4-5-20250929',
      provider: createProvider(['claude-opus-4-6', 'claude-sonnet-4-5-20250929']),
    });

    expect(result).toMatchObject({
      providerId: 'anthropic-main',
      modelName: 'claude-sonnet-4-5-20250929',
      source: 'session',
    });
  });

  it('falls back to Opus only when the flag is enabled', () => {
    const result = resolveClaudeSmallFastModelSelection({
      providerId: 'anthropic-main',
      modelName: 'claude-sonnet-4-5-20250929',
      provider: createProvider(['claude-opus-4-6', 'claude-sonnet-4-5-20250929']),
      allowOpusFallback: true,
    });

    expect(result).toMatchObject({
      providerId: 'anthropic-main',
      modelName: 'claude-opus-4-6',
      source: 'auto-opus',
    });
  });

  it('keeps the session model when auto-switch is disabled', () => {
    const result = resolveExploreModelSelection({
      sessionProviderId: 'anthropic-main',
      sessionModelName: 'claude-sonnet-4-5-20250929',
      provider: createProvider(['claude-haiku-4-5-20251001']),
      claudeExploreUseHaiku: false,
    });

    expect(result).toMatchObject({
      providerId: 'anthropic-main',
      modelName: 'claude-sonnet-4-5-20250929',
      source: 'session',
    });
  });

  it('falls back to the session model when provider has no Haiku', () => {
    const result = resolveExploreModelSelection({
      sessionProviderId: 'anthropic-main',
      sessionModelName: 'claude-sonnet-4-5-20250929',
      provider: createProvider(['claude-sonnet-4-5-20250929']),
      claudeExploreUseHaiku: true,
    });

    expect(result).toMatchObject({
      providerId: 'anthropic-main',
      modelName: 'claude-sonnet-4-5-20250929',
      source: 'session',
    });
  });

  it('wires explore and agent to different models', async () => {
    const { runSession, calls } = createRunSessionRecorder();
    const tools = createAgenticModeTools({
      orchestrator: { runSession } as any,
      providerId: 'anthropic-main',
      modelName: 'claude-sonnet-4-5-20250929',
      exploreProviderId: 'anthropic-main',
      exploreModelName: 'claude-haiku-4-5-20251001',
      permissionManager: new PermissionManager({ defaultPermission: ToolPermission.ALLOW }),
      allTools: [],
      workDir: '/tmp/neox-test',
      getParentMemory: () => new STM(),
      backgroundManager: new BackgroundAgentManager(),
    });

    const explore = tools.find(tool => tool.name === 'explore');
    const agent = tools.find(tool => tool.name === 'agent');

    expect(explore).toBeDefined();
    expect(agent).toBeDefined();

    await expect(explore!.function({ prompt: 'inspect routes' })).resolves.toBe('ok');
    await expect(
      agent!.function({ description: 'inspect routes', prompt: 'inspect routes', run_in_background: false }),
    ).resolves.toBe('ok');

    expect(calls).toEqual([
      { providerId: 'anthropic-main', modelName: 'claude-haiku-4-5-20251001' },
      { providerId: 'anthropic-main', modelName: 'claude-sonnet-4-5-20250929' },
    ]);
  });

  it('does not expose shell execution to explore agents', async () => {
    let toolNames: string[] = [];
    const runSession = vi.fn(async ({ buildHostConfig }: any) => {
      const hostConfig = buildHostConfig({}, {});
      toolNames = hostConfig.tools.map((tool: { name: string }) => tool.name);
      return {
        summary: {
          output: 'ok',
          totalTokens: 0,
          durationMs: 1,
          iterations: 1,
          toolCalls: 0,
          interrupted: false,
          failed: false,
        },
        contextUsed: 0,
        providerId: 'anthropic-main',
      };
    });
    const toolStub = (name: string) => ({
      name,
      description: name,
      parameters: { type: 'object' as const, properties: {} },
      function: async () => 'ok',
    });
    const tools = createAgenticModeTools({
      orchestrator: { runSession } as any,
      providerId: 'anthropic-main',
      modelName: 'claude-sonnet-4-5-20250929',
      permissionManager: new PermissionManager({ defaultPermission: ToolPermission.ALLOW }),
      allTools: [toolStub('readfile'), toolStub('search_files'), toolStub('execute_shell')],
      workDir: '/tmp/neox-test',
      getParentMemory: () => new STM(),
      backgroundManager: new BackgroundAgentManager(),
    });

    const explore = tools.find(tool => tool.name === 'explore');
    await expect(explore!.function({ prompt: 'inspect routes' })).resolves.toBe('ok');

    expect(toolNames).toContain('readfile');
    expect(toolNames).toContain('search_files');
    expect(toolNames).not.toContain('execute_shell');
  });
});
