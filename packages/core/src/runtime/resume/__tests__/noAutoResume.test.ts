import { describe, expect, it, vi } from 'vitest';

vi.mock('../repairMessageHistory.js', () => ({
  repairMessageHistory: () => ({ ok: true, repairedToolCalls: 2, droppedPartialMessages: 0, totalMessagesAfter: 10 }),
}));
vi.mock('../../store/PendingAskUserStore.js', () => ({
  getPendingAskUserStore: () => ({ findBySession: () => [] }),
}));

const { runResumeScanner } = await import('../resumeScanner.js');

function setup() {
  const calls = { chat: 0, cancelled: [] as string[], resumed: [] as string[], emittedResumed: [] as string[], failed: [] as string[] };
  const store = {
    findStaleRunning: () => [{ sessionId: 's1', mode: 'agentic', serverToken: 'pid:old', model: 'm', metadata: {} }],
    markCancelled: (id: string) => { calls.cancelled.push(id); },
    markResumed: (id: string) => { calls.resumed.push(id); },
    markErrored: () => {},
  };
  const agenticRuntime = { chat: async () => { calls.chat++; return ''; } };
  const emitter = {
    emitResumed: (id: string) => { calls.emittedResumed.push(id); },
    emitFailed: (id: string) => { calls.failed.push(id); },
  };
  return { calls, opts: { store, agenticRuntime, emitter, currentServerToken: 'pid:new' } as any };
}

describe('重启后扫到被打断的一轮', () => {
  it('修补历史、标成已结束、告诉界面 —— 但不起 chat', async () => {
    const { calls, opts } = setup();
    await runResumeScanner(opts);
    expect(calls.chat).toBe(0);
    expect(calls.cancelled).toEqual(['s1']);
    expect(calls.emittedResumed).toEqual(['s1']);
    expect(calls.failed).toEqual([]);
  });
});
