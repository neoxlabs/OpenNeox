import { describe, it, expect, vi, beforeEach } from 'vitest';

const enqueued: Array<{ sessionId: string; text: string }> = [];
vi.mock('../../shell/backgroundTaskNotifier.js', () => ({
  getBackgroundTaskNotifier: () => ({
    enqueueMessageForSession: (sessionId: string, text: string) => {
      enqueued.push({ sessionId, text });
    },
  }),
}));
vi.mock('../../agentThreadContext.js', () => ({
  getAgentThreadContext: () => ({ checkCanSpawnOrThrow: () => {} }),
}));
vi.mock('@neoxlabs/platform/platform/osNotifier.js', () => ({ sendOsNotification: vi.fn() }));

async function freshManager() {
  vi.resetModules();
  enqueued.length = 0;
  const mod = await import('../backgroundAgent.js');
  return new mod.BackgroundAgentManager();
}

/** 假 host —— 只需要记录 interrupt 有没有被叫到 */
function fakeHost() {
  const calls = { interrupt: 0 };
  return {
    calls,
    host: { interrupt: () => { calls.interrupt += 1; } },
  };
}

describe('停止会话时子 agent 的 host 必须被 interrupt', () => {
  beforeEach(() => { enqueued.length = 0; });

  it('abortBySession 会 interrupt 子 agent 的 runtimeHost', async () => {
    const m = await freshManager();
    const task = m.register('a1', '读文件', 'prompt', 'sess-main', 'Agent-1');
    const { host, calls } = fakeHost();
    task.runtimeHost = host as never;

    m.abortBySession('sess-main');

    expect(calls.interrupt).toBe(1);        /* ← 旧实现是 0: 只 abort 了 controller */
    expect(task.status).toBe('aborted');
    expect(task.abortController.signal.aborted).toBe(true);
  });

  it('单个 abort 同样要 interrupt (超时/看门狗判死也得真停下来)', async () => {
    const m = await freshManager();
    const task = m.register('a1', '读文件', 'prompt', 'sess-main', 'Agent-1');
    const { host, calls } = fakeHost();
    task.runtimeHost = host as never;

    m.abort('a1', '硬超时', true, 'watchdog');
    expect(calls.interrupt).toBe(1);
  });

  it('interrupt 抛异常不能挡住状态收尾 —— host 可能已经自己收摊了', async () => {
    const m = await freshManager();
    const task = m.register('a1', '读文件', 'prompt', 'sess-main', 'Agent-1');
    task.runtimeHost = { interrupt: () => { throw new Error('host gone'); } } as never;

    expect(() => m.abortBySession('sess-main')).not.toThrow();
    expect(task.status).toBe('aborted');
  });

  it('没有 runtimeHost 的任务照常中止 (同步前台 agent 可能还没建 host)', async () => {
    const m = await freshManager();
    const task = m.register('a1', '读文件', 'prompt', 'sess-main', 'Agent-1');
    expect(task.runtimeHost).toBeUndefined();
    m.abortBySession('sess-main');
    expect(task.status).toBe('aborted');
  });

  it('别的会话的子 agent 不许被 interrupt', async () => {
    const m = await freshManager();
    const mine = m.register('a1', '任务一', 'p', 'sess-a', 'Agent-1');
    const other = m.register('a2', '任务二', 'p', 'sess-b', 'Agent-2');
    const a = fakeHost(); const b = fakeHost();
    mine.runtimeHost = a.host as never;
    other.runtimeHost = b.host as never;

    m.abortBySession('sess-a');
    expect(a.calls.interrupt).toBe(1);
    expect(b.calls.interrupt).toBe(0);
    expect(other.status).toBe('running');
  });
});
