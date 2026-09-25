import { describe, it, expect, vi } from 'vitest';
import { createAgenticModeTools } from '../agenticModeTools.js';
import { createAgentTool } from '../agentTool.js';
import { BackgroundAgentManager } from '../backgroundAgent.js';
import { PermissionManager } from '@neoxlabs/kernel/core/permissions/index.js';
import { ToolPermission } from '@neoxlabs/kernel/types/permissions.js';
import { ShortTermMemory as STM } from '@neoxlabs/kernel/memory/shortterm.js';

function createOptions(runSession: any) {
  return {
    orchestrator: { runSession } as any,
    providerId: 'test-provider',
    modelName: 'test-model',
    permissionManager: new PermissionManager({ defaultPermission: ToolPermission.ALLOW }),
    allTools: [],
    workDir: '/tmp/neox-test',
    getParentMemory: () => new STM(),
    backgroundManager: new BackgroundAgentManager(),
  };
}

function createFailedRunSession(message: string = 'Bad gateway') {
  return vi.fn(async ({ onRuntimeEvent }: any) => {
    onRuntimeEvent?.({
      type: 'error_classified',
      category: 'server_error',
      code: 'PROXY_502',
      message,
      retryable: true,
    }, {} as any);

    return {
      summary: {
        output: '',
        totalTokens: 0,
        durationMs: 1,
        iterations: 1,
        toolCalls: 0,
        interrupted: false,
        failed: true,
      },
      contextUsed: 0,
      providerId: 'test-provider',
    };
  });
}

describe('task-agent failure propagation', () => {
  it('explore surfaces runtime failures instead of no output', async () => {
    const runSession = createFailedRunSession();
    const tools = createAgenticModeTools(createOptions(runSession));
    const explore = tools.find(tool => tool.name === 'explore');

    expect(explore).toBeDefined();
    await expect(explore!.function({ prompt: 'inspect chokidar' })).resolves.toBe('[ERROR] Bad gateway');
  });

  it('agent surfaces runtime failures instead of no output (前台)', async () => {
    const runSession = createFailedRunSession();
    const agent = createAgentTool(createOptions(runSession));

    await expect(
      agent.function({ description: 'inspect', prompt: 'inspect chokidar', run_in_background: false }),
    ).resolves.toBe('[ERROR] Bad gateway');
  });

  it('不传 run_in_background 时默认后台派发, 不阻塞主 agent', async () => {
    const runSession = createFailedRunSession();
    const agent = createAgentTool(createOptions(runSession));

    const out = await agent.function({ description: 'inspect bg', prompt: 'inspect chokidar' });
    expect(JSON.parse(out as string).status).toBe('background_launched');
  });
});
