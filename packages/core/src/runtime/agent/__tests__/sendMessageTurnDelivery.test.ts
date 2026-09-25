import { describe, expect, it, vi } from 'vitest';
import { BackgroundAgentManager } from '../backgroundAgent.js';
import { createSendMessageTool } from '../sendMessageTool.js';
import { createAgentTool } from '../agentTool.js';
import { PermissionManager } from '@neoxlabs/kernel/core/permissions/index.js';
import { ToolPermission } from '@neoxlabs/kernel/types/permissions.js';
import { ShortTermMemory as STM } from '@neoxlabs/kernel/memory/shortterm.js';

function createAgentOptions(runSession: any, backgroundManager: BackgroundAgentManager) {
  return {
    orchestrator: { runSession } as any,
    providerId: 'test-provider',
    modelName: 'test-model',
    permissionManager: new PermissionManager({ defaultPermission: ToolPermission.ALLOW }),
    allTools: [],
    workDir: '/tmp/neox-test',
    getParentMemory: () => new STM(),
    backgroundManager,
  };
}

describe('send_message turn-boundary delivery', () => {
  it('injects into runtime host queue when host is ready', async () => {
    const backgroundManager = new BackgroundAgentManager();
    backgroundManager.register('Agent-1', 'inspect', 'inspect chokidar');
    const injectUserMessage = vi.fn().mockReturnValue(1);

    backgroundManager.attachRuntimeHost('Agent-1', { injectUserMessage } as any);

    const tool = createSendMessageTool({ backgroundManager });
    const raw = await tool.function({ to: 'Agent-1', message: '继续检查错误处理' });
    const result = JSON.parse(raw as string);

    expect(result.success).toBe(true);
    expect(result.type).toBe('ephemeral');
    expect(result.status).toBe('success');
    expect(result.tool).toBe('send_message');
    expect(result.delivery).toBe('injected');
    expect(result.message).toContain('下一轮对话开始时处理');
    expect(result.metadata.agentId).toBe('Agent-1');
    expect(result.metadata.agentStatus).toBe('running');
    expect(injectUserMessage).toHaveBeenCalledWith(
      '<send_message from="main_agent">\n继续检查错误处理\n</send_message>',
    );
  });

  it('flushes locally queued messages once runtime host attaches', async () => {
    const backgroundManager = new BackgroundAgentManager();
    backgroundManager.register('Agent-1', 'inspect', 'inspect chokidar');
    const tool = createSendMessageTool({ backgroundManager });

    const queuedRaw = await tool.function({ to: 'Agent-1', message: '补充看下 watcher 调用链' });
    const queued = JSON.parse(queuedRaw as string);
    expect(queued.delivery).toBe('queued');

    const injectUserMessage = vi.fn().mockReturnValue(1);
    backgroundManager.attachRuntimeHost('Agent-1', { injectUserMessage } as any);

    expect(injectUserMessage).toHaveBeenCalledWith(
      '<send_message from="main_agent">\n补充看下 watcher 调用链\n</send_message>',
    );
    expect(backgroundManager.resolveAgent('Agent-1')?.pendingMessages).toHaveLength(0);
  });

  it('background agent startup wires host so follow-up messages use next-turn injection', async () => {
    const backgroundManager = new BackgroundAgentManager();
    const injectUserMessage = vi.fn().mockReturnValue(1);
    const never = new Promise(() => {});
    const runSession = vi.fn(async ({ onHostReady }: any) => {
      onHostReady?.({ injectUserMessage } as any);
      return await never;
    });

    const agentTool = createAgentTool(createAgentOptions(runSession, backgroundManager));
    const sendMessageTool = createSendMessageTool({ backgroundManager });

    const launchRaw = await agentTool.function({
      description: 'inspect chokidar',
      prompt: 'inspect chokidar',
      run_in_background: true,
    });
    const launch = JSON.parse(launchRaw as string);

    await Promise.resolve();
    await Promise.resolve();

    const sendRaw = await sendMessageTool.function({
      to: launch.agentId,
      message: '继续看 watcher 的收尾逻辑',
    });
    const send = JSON.parse(sendRaw as string);

    expect(launch.status).toBe('background_launched');
    expect(send.delivery).toBe('injected');
    expect(injectUserMessage).toHaveBeenCalledWith(
      '<send_message from="main_agent">\n继续看 watcher 的收尾逻辑\n</send_message>',
    );
  });

  it('auto-background keeps the same task and still emits worker_complete', async () => {
    vi.useFakeTimers();
    try {
      let resolveRun!: (value: any) => void;
      const runPromise = new Promise(resolve => { resolveRun = resolve; });
      const runSession = vi.fn(async () => runPromise);
      const lifecycle: Array<{ kind: string; synchronous?: boolean; status: string }> = [];
      const backgroundManager = new BackgroundAgentManager({
        onLifecycle: (kind, task) => {
          lifecycle.push({ kind, synchronous: task.synchronous, status: task.status });
        },
      });
      const workerEvents: any[] = [];
      const agentTool = createAgentTool({
        ...createAgentOptions(runSession, backgroundManager),
        sessionId: 'session-1',
        onTaskAgentEvent: (_agentId: string, event: any) => workerEvents.push(event),
      } as any);

      const launchPromise = agentTool.function({
        description: 'large edit',
        prompt: 'perform the large edit',
        run_in_background: false,
        auto_background_ms: 10,
      });

      await vi.advanceTimersByTimeAsync(10);
      const launch = JSON.parse(await launchPromise as string);

      expect(launch.status).toBe('auto_backgrounded');
      expect(lifecycle.filter(e => e.kind === 'started')).toHaveLength(1);
      expect(backgroundManager.resolveAgent(launch.agentId)?.status).toBe('running');

      resolveRun({ summary: { output: 'sub-agent done', failed: false, interrupted: false } });
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();

      expect(backgroundManager.resolveAgent(launch.agentId)?.status).toBe('completed');
      expect(workerEvents.some(e => e.type === 'worker_complete' && e.success === true)).toBe(true);
      expect(lifecycle.some(e => e.kind === 'done' && e.synchronous === false)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
