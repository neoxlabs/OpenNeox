import { describe, expect, it, vi } from 'vitest';
import { AgentRuntimeHost } from '../agentRuntimeHost.js';

/**
 * 第二次回车 = 立即转向 (需求：「回车两次后还是等待, 并不是强行中断插入」)。
 *
 *   injectUserMessage 仍然只排队不打断 (07-02 的规矩, 见 runEndDrainQueuedMessages.test)。
 *   立即转向是**另一个显式动作** requestSteeringInterrupt —— 输入框第二次回车时才调:
 *   在跑 → 交给 runner 打断在途模型输出; 没在跑 → false, 不碰 runner。
 */

function buildHost(runImpl?: (host: AgentRuntimeHost) => AsyncGenerator<any>) {
  let hostRef: AgentRuntimeHost;
  const runner: any = {
    onHistoryCompacted: undefined,
    getMode: () => 'agent',
    setMode: vi.fn(),
    requestSteeringInterrupt: vi.fn(() => true),
    run: vi.fn(() => (runImpl ? runImpl(hostRef) : (async function* () {
      yield { type: 'iteration_start', iteration: 1 };
    })())),
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
  return { host: hostRef, runner };
}

describe('host.requestSteeringInterrupt', () => {
  it('没在跑 → false, 不碰 runner', () => {
    const { host, runner } = buildHost();
    expect(host.requestSteeringInterrupt()).toBe(false);
    expect(runner.requestSteeringInterrupt).not.toHaveBeenCalled();
  });

  it('在跑时: 插话照常排队 (不自动打断), 第二次回车显式转向才打断在途输出', async () => {
    let steered: boolean | undefined;
    let autoAbortedOnInject = false;
    let runs = 0;
    const { host, runner } = buildHost(async function* (h) {
      yield { type: 'iteration_start', iteration: 1 };
      /* 只在第一段插话 —— 插进去的那句会被 run-end drain 续跑一段, 续跑那段别再插, 否则无限续 */
      if (runs++ > 0) return;
      h.injectUserMessage('现在就插这句');
      autoAbortedOnInject = runner.requestSteeringInterrupt.mock.calls.length > 0;
      steered = h.requestSteeringInterrupt();
    });

    await host.runTask('原始任务');

    expect(autoAbortedOnInject).toBe(false);
    expect(steered).toBe(true);
    expect(runner.requestSteeringInterrupt).toHaveBeenCalledTimes(1);
  });
});
