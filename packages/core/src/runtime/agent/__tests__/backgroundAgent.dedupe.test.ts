import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../shell/backgroundTaskNotifier.js', () => ({
  getBackgroundTaskNotifier: () => ({ enqueueMessageForSession: vi.fn() }),
}));
vi.mock('../../agentThreadContext.js', () => ({
  getAgentThreadContext: () => ({ checkCanSpawnOrThrow: () => {} }),
}));
vi.mock('@neoxlabs/platform/platform/osNotifier.js', () => ({ sendOsNotification: vi.fn() }));

async function freshManager(env: Record<string, string> = {}) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const mod = await import('../backgroundAgent.js');
  return new mod.BackgroundAgentManager();
}

describe('findDuplicateRunning — 防重复派发', () => {
  beforeEach(() => {
    delete process.env.NEOX_AGENT_NO_PROGRESS_MS;
    delete process.env.NEOX_AGENT_HARD_TIMEOUT_MS;
  });

  it('同 description 且在跑 → 命中既有 task', async () => {
    const mgr = await freshManager();
    const first = mgr.register('Agent-1', '重构宠物成长', 'prompt A', 'sess-1');
    const dup = mgr.findDuplicateRunning('重构宠物成长', 'prompt B', 'sess-1');
    expect(dup?.agentId).toBe(first.agentId);
  });

  it('归一化: 空格与标点差异仍算同一任务', async () => {
    const mgr = await freshManager();
    mgr.register('Agent-1', '重构宠物成长', 'p', 'sess-1');
    expect(mgr.findDuplicateRunning('重构 宠物成长。', 'other', 'sess-1')).not.toBeNull();
  });

  it('同 prompt 但 description 不同 → 仍算重复', async () => {
    const mgr = await freshManager();
    mgr.register('Agent-1', '描述一', '完全一样的任务正文', 'sess-1');
    expect(mgr.findDuplicateRunning('描述二', '完全一样的任务正文', 'sess-1')).not.toBeNull();
  });

  it('不同任务 → 不拦截(保住正当的分区并行)', async () => {
    const mgr = await freshManager();
    mgr.register('Agent-1', '改 views 模板', 'prompt A', 'sess-1');
    expect(mgr.findDuplicateRunning('改 routes 参数', 'prompt B', 'sess-1')).toBeNull();
  });

  it('已完成的 task 不算重复(允许重跑)', async () => {
    const mgr = await freshManager();
    const t = mgr.register('Agent-1', '重构宠物成长', 'p', 'sess-1');
    mgr.complete(t.agentId, 'done');
    expect(mgr.findDuplicateRunning('重构宠物成长', 'p', 'sess-1')).toBeNull();
  });

  it('跨 session 不算重复', async () => {
    const mgr = await freshManager();
    mgr.register('Agent-1', '重构宠物成长', 'p', 'sess-1');
    expect(mgr.findDuplicateRunning('重构宠物成长', 'p', 'sess-2')).toBeNull();
  });
});

describe('停滞判死 (idle 判据)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    delete process.env.NEOX_AGENT_NO_PROGRESS_MS;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** 把 task 摆成"启动于 ranMs 前, 最后一次动静在 idleMs 前" */
  function backdate(task: any, ranMs: number, idleMs: number) {
    task.startedAt = Date.now() - ranMs;
    task.progress.lastProgressAt = Date.now() - idleMs;
  }

  it('从头到尾没动静 → 判死', async () => {
    const mgr = await freshManager({
      NEOX_AGENT_NO_PROGRESS_MS: '60000',
      NEOX_AGENT_HARD_TIMEOUT_MS: '3600000', // 硬超时设很大, 确保命中的是停滞分支
    });
    const task = mgr.register('Agent-stall', '卡死的任务', 'p', 'sess-1');
    backdate(task, 5 * 60_000, 5 * 60_000);

    await vi.advanceTimersByTimeAsync(31_000); // 触发一次 30s 扫描

    expect(task.status).toBe('aborted');
    expect(task.error).toContain('停滞');
    expect(task.abortOrigin).toBe('watchdog');
  });

  it('干过活但已经卡了很久 → 照样判死 (旧的"全程零进展"判据抓不到这种)', async () => {
    const mgr = await freshManager({
      NEOX_AGENT_NO_PROGRESS_MS: '60000',
      NEOX_AGENT_HARD_TIMEOUT_MS: '3600000',
    });
    const task = mgr.register('Agent-half-dead', '干了两下就挂了', 'p', 'sess-1');
    task.progress.toolUseCount = 2;
    task.progress.outputTokens = 800;
    backdate(task, 10 * 60_000, 5 * 60_000); // 跑了 10 分钟, 但最后 5 分钟一动不动

    await vi.advanceTimersByTimeAsync(31_000);

    expect(task.status).toBe('aborted');
    expect(task.error).toContain('停滞');
  });

  it('一直在动 → 跑再久也不判死 (大任务不误杀)', async () => {
    const mgr = await freshManager({
      NEOX_AGENT_NO_PROGRESS_MS: '60000',
      NEOX_AGENT_HARD_TIMEOUT_MS: '3600000',
    });
    const task = mgr.register('Agent-busy', '很大但一直在干', 'p', 'sess-1');
    backdate(task, 30 * 60_000, 5_000); // 跑了半小时, 5 秒前还有动静

    await vi.advanceTimersByTimeAsync(31_000);

    expect(task.status).toBe('running');
  });

  it('任何 runtime event 都算动静 —— updateProgress 刷新 lastProgressAt', async () => {
    const mgr = await freshManager({
      NEOX_AGENT_NO_PROGRESS_MS: '60000',
      NEOX_AGENT_HARD_TIMEOUT_MS: '3600000',
    });
    const task = mgr.register('Agent-talking', '正在吐一大段文本', 'p', 'sess-1');
    backdate(task, 10 * 60_000, 5 * 60_000);
    // 一条既不是工具调用、也不带 token 的普通事件, 同样要续命
    mgr.updateProgress('Agent-talking', { type: 'text_delta', text: '…' });

    await vi.advanceTimersByTimeAsync(31_000);

    expect(task.status).toBe('running');
  });

  it('还没到阈值 → 不动它', async () => {
    const mgr = await freshManager({
      NEOX_AGENT_NO_PROGRESS_MS: '600000', // 10 分钟
      NEOX_AGENT_HARD_TIMEOUT_MS: '3600000',
    });
    const task = mgr.register('Agent-young', '刚起步', 'p', 'sess-1');
    task.startedAt = Date.now() - 60_000; // 才 1 分钟

    await vi.advanceTimersByTimeAsync(31_000);

    expect(task.status).toBe('running');
  });

  it('设 0 可关闭该护栏', async () => {
    const mgr = await freshManager({
      NEOX_AGENT_NO_PROGRESS_MS: '0',
      NEOX_AGENT_HARD_TIMEOUT_MS: '3600000',
    });
    const task = mgr.register('Agent-off', '关闭护栏', 'p', 'sess-1');
    /* 30 分钟: 远超零进展阈值(已关闭), 又不到 60 分钟硬超时 —— 确保测的是本护栏 */
    task.startedAt = Date.now() - 30 * 60_000;

    await vi.advanceTimersByTimeAsync(31_000);

    expect(task.status).toBe('running');
  });
});
