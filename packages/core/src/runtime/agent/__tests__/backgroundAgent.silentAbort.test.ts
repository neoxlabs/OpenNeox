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

describe('用户停止 → 子 agent 静默中止, 不得唤醒主会话', () => {
  beforeEach(() => { enqueued.length = 0; });

  it('abortBySession 不投递任何完成通知', async () => {
    const m = await freshManager();
    m.register('a1', '读文件', 'prompt', 'sess-main', 'Agent-1');
    expect(enqueued).toHaveLength(0);

    m.abortBySession('sess-main');
    expect(enqueued).toHaveLength(0);          /* ← 旧实现在这里会有 1 条, 主 Agent 就是被它复活的 */
  });

  it('abortAll 同样静默 (runtime 关停不该唤醒任何人)', async () => {
    const m = await freshManager();
    m.register('a1', '任务一', 'p', 'sess-a', 'Agent-1');
    m.register('a2', '任务二', 'p', 'sess-b', 'Agent-2');
    m.abortAll();
    expect(enqueued).toHaveLength(0);
  });

  it('单个 agent 因超时/程序原因中止时**仍要**告知 —— 那是模型需要的信息', async () => {
    const m = await freshManager();
    m.register('a1', '读文件', 'prompt', 'sess-main', 'Agent-1');
    m.abort('a1', '硬超时');                    /* 不传 silent */
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].sessionId).toBe('sess-main');
  });

  it('静默中止后不会被后续路径补一条唤醒 (notified 已置位)', async () => {
    const m = await freshManager();
    m.register('a1', '读文件', 'prompt', 'sess-main', 'Agent-1');
    m.abortBySession('sess-main');
    m.abort('a1', '再来一次');                  /* 已是 aborted, 应当直接 false */
    expect(enqueued).toHaveLength(0);
  });

  it('只中止目标会话, 别的会话的 agent 不受影响', async () => {
    const m = await freshManager();
    m.register('a1', '任务一', 'p', 'sess-a', 'Agent-1');
    m.register('a2', '任务二', 'p', 'sess-b', 'Agent-2');
    m.abortBySession('sess-a');
    const active = m.listActive();
    expect(active.map((t: { agentId: string }) => t.agentId)).toEqual(['a2']);
  });
});
