import { describe, it, expect, vi, beforeEach } from 'vitest';

const appended: Array<{ role: string; content: string }> = [];
vi.mock('@neoxlabs/platform/platform/sessionContext.js', () => ({
  SessionContext: {
    get: () => ({
      appendMessage: (role: string, content: string) => { appended.push({ role, content }); return appended.length; },
      appendCompaction: () => {},
      getAll: () => [],
      get size() { return 0; },
    }),
    reset: () => {},
  },
}));

const { AgentRuntimeHost } = await import('../agentRuntimeHost.js');
const { ShortTermMemory } = await import('@neoxlabs/kernel/memory/shortterm.js');

function hostWith(memory: InstanceType<typeof ShortTermMemory>) {
  return new AgentRuntimeHost({
    runner: { onHistoryCompacted: undefined, getMode: () => 'agent', setMode: vi.fn() } as any,
    memory: memory as any,
    sessionManager: {} as any,
    sessionEnabled: true,
    session: { sessionId: 's-persist' } as any,
    workDir: process.cwd(),
    model: 'test-model',
  });
}

beforeEach(() => { appended.length = 0; });

describe('memory 变短之后新消息照样落库', () => {
  it('add 超上限被裁剪: 裁完之后那句最后的回复也要写进库', async () => {
    vi.useFakeTimers();
    const mem = new ShortTermMemory(6);
    const host = hostWith(mem);
    for (let i = 0; i < 6; i++) mem.add({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` });
    await vi.advanceTimersByTimeAsync(300);
    /* 第 7 条触发裁剪: length 从 7 掉到 4 —— 旧游标停在 6, 下面这句会被当成"已落库" */
    mem.add({ role: 'user', content: 'trigger trim' });
    mem.add({ role: 'assistant', content: '已执行 BRAVO-2。' });
    await vi.advanceTimersByTimeAsync(300);
    vi.useRealTimers();
    expect(appended.map((a) => a.content)).toContain('已执行 BRAVO-2。');
    expect(appended.map((a) => a.content)).toContain('trigger trim');
    void host;
  });

  it('每条只写一次 (连着好几次 flush 也不重复)', async () => {
    vi.useFakeTimers();
    const mem = new ShortTermMemory();
    hostWith(mem);
    mem.add({ role: 'user', content: 'a' });
    await vi.advanceTimersByTimeAsync(300);
    mem.add({ role: 'assistant', content: 'b' });
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(300);
    vi.useRealTimers();
    expect(appended.map((a) => a.content)).toEqual(['a', 'b']);
  });

  it('建 host 之前已经在 memory 里的 (从库里 seed 的历史) 不会被写回去', async () => {
    vi.useFakeTimers();
    const mem = new ShortTermMemory();
    mem.add({ role: 'user', content: 'from-db' });
    hostWith(mem);
    mem.add({ role: 'assistant', content: 'new' });
    await vi.advanceTimersByTimeAsync(300);
    vi.useRealTimers();
    expect(appended.map((a) => a.content)).toEqual(['new']);
  });
});
