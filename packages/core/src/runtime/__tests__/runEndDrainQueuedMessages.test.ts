import { describe, expect, it, vi } from 'vitest';
import { AgentRuntimeHost } from '../agentRuntimeHost.js';


type RunImpl = (host: AgentRuntimeHost) => AsyncGenerator<any>;

function buildHost(runImpls: RunImpl[]) {
  const runCalls: Array<{ task: string; images?: string[] }> = [];
  let runIndex = 0;
  let hostRef: AgentRuntimeHost;

  const runner: any = {
    onHistoryCompacted: undefined,
    getMode: () => 'agent',
    setMode: vi.fn(),
    requestSteeringInterrupt: vi.fn(() => true),
    run: vi.fn((task: string, images?: string[]) => {
      runCalls.push({ task, images });
      const impl = runImpls[runIndex++];
      if (impl) return impl(hostRef);
      return (async function* () {
        yield { type: 'iteration_start', iteration: 1 };
      })();
    }),
  };

  const messages: any[] = [];
  const memory: any = {
    add: (m: any) => messages.push(m),
    getAll: () => messages,
    getMessagesForLLM: () => messages,
    onMessageAdded: () => () => {},
    addToolResult: vi.fn(),
  };

  hostRef = new AgentRuntimeHost({
    runner,
    memory,
    sessionManager: {} as any,
    sessionEnabled: false,
    workDir: process.cwd(),
    model: 'test-model',
  });

  return { host: hostRef, runner, runCalls, messages };
}

describe('explicit recovery is not user input', () => {
  it('uses existing task context without processing new attachments', async () => {
    const { host, runner, messages } = buildHost([]);
    messages.push({ role: 'user', content: 'original task' });
    messages.push({ role: 'assistant', content: 'partial output' });
    const before = structuredClone(messages);
    const prepare = vi.spyOn(host as any, 'prepareTaskInput');
    const extract = vi.spyOn(host as any, 'extractImageUrls');
    await host.runTask('', { metadata: { continuation: true } });
    expect(runner.run).toHaveBeenCalledWith(
      'original task', undefined, expect.anything(),
      expect.objectContaining({ continuation: true }),
    );
    expect(prepare).not.toHaveBeenCalled();
    expect(extract).not.toHaveBeenCalled();
    expect(messages).toEqual(before);
  });

  it('accepts an image-only task after restore', async () => {
    const { host, runner, messages } = buildHost([]);
    messages.push({ role: 'user', content: [{ type: 'image_url', image_url: { url: 'image' } }] });
    await host.runTask('', { metadata: { continuation: true } });
    expect(runner.run).toHaveBeenCalledWith(
      '', undefined, expect.anything(),
      expect.objectContaining({ continuation: true }),
    );
  });

  it('does not invent a task when there is no history', async () => {
    const { host, runner } = buildHost([]);
    await expect(host.runTask('', { metadata: { continuation: true } }))
      .rejects.toThrow('no conversation history');
    expect(runner.run).not.toHaveBeenCalled();
  });
});

describe('run-end drain of queued injected messages', () => {
  it('injectUserMessage queues without aborting the in-flight stream', async () => {
    const { host, runner } = buildHost([
      async function* (h) {
        yield { type: 'iteration_start', iteration: 1 };
        const pos = h.injectUserMessage('插话消息');
        expect(pos).toBe(1);
        yield { type: 'iteration_start', iteration: 2 };
      },
    ]);

    await host.runTask('原始任务');
    expect(runner.requestSteeringInterrupt).not.toHaveBeenCalled();
  });

  it('continues the turn with queued text when runner finishes naturally', async () => {
    const { host, runner, runCalls } = buildHost([
      /* 第一段: 只有 1 轮迭代 (iteration gate > 1 从不 drain), 流中插话 → 收束时队列非空 */
      async function* (h) {
        yield { type: 'iteration_start', iteration: 1 };
        h.injectUserMessage('收尾后的插话');
      },
      /* 第二段: drain 续跑, 正常收束 */
      async function* () {
        yield { type: 'iteration_start', iteration: 1 };
      },
    ]);
    const events: any[] = [];
    host.on((e: any) => events.push(e));

    await host.runTask('原始任务');

    expect(runner.run).toHaveBeenCalledTimes(2);
    expect(runCalls[1].task).toBe('收尾后的插话');

    const injected = events.filter((e) => e.type === 'user_message_injected');
    expect(injected).toHaveLength(1);
    expect(injected[0].text).toBe('收尾后的插话');

    /* 同一次 streaming — 只发一个 run_result, 且在 user_message_injected 之后 */
    const runResults = events.filter((e) => e.type === 'run_result');
    expect(runResults).toHaveLength(1);
    expect(events.indexOf(injected[0])).toBeLessThan(events.indexOf(runResults[0]));

    /* 队列已清空, 不滞留到下一轮 */
    expect(host.hasPendingInjectedMessages()).toBe(false);
  });

  it('drops unconsumed queue on interrupt instead of leaking into the next turn', async () => {
    const { host, runner } = buildHost([
      async function* (h) {
        yield { type: 'iteration_start', iteration: 1 };
        h.injectUserMessage('中断时的插话');
        h.interrupt();
        yield { type: 'iteration_start', iteration: 2 };
      },
    ]);

    await host.runTask('原始任务');

    /* 中断路径: 不 drain 续跑 (runner.run 只调了一次), 队列被丢弃 */
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(host.hasPendingInjectedMessages()).toBe(false);
  });
});
