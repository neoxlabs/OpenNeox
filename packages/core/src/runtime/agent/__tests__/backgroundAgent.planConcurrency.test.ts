import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../shell/backgroundTaskNotifier.js', () => ({
  getBackgroundTaskNotifier: () => ({ enqueueMessageForSession: vi.fn() }),
}));
vi.mock('../../agentThreadContext.js', () => ({
  getAgentThreadContext: () => ({ checkCanSpawnOrThrow: () => {} }),
}));
vi.mock('@neoxlabs/platform/platform/osNotifier.js', () => ({ sendOsNotification: vi.fn() }));

/** 缓存读取整体替身 —— 每个用例自己决定这台机器"当前档位"返什么 */
const planValue = { current: null as number | null };
vi.mock('../../../platform/membershipCacheRead.js', () => ({
  readPlanMaxConcurrentAgents: () => planValue.current,
  readCachedMembershipModels: () => [],
  readAvailableCloudImageModels: () => [],
}));

async function freshGetter(): Promise<() => number> {
  vi.resetModules();
  const mod = await import('../backgroundAgent.js');
  mod.__resetMaxConcurrentAgentsForTest();
  return mod.getMaxConcurrentAgents;
}

describe('getMaxConcurrentAgents — 按档位', () => {
  beforeEach(() => {
    delete process.env.NEOX_MAX_CONCURRENT_AGENTS;
    planValue.current = null;
  });
  afterEach(() => {
    delete process.env.NEOX_MAX_CONCURRENT_AGENTS;
  });

  it('读不到缓存时回落 3 —— 未登录 / BYOK 用户行为与改动前一致', async () => {
    planValue.current = null;
    const get = await freshGetter();
    expect(get()).toBe(3);
  });

  it('档位下发多少就用多少 (ultra = 10)', async () => {
    planValue.current = 10;
    const get = await freshGetter();
    expect(get()).toBe(10);
  });

  it('档位可以比默认更小 (free = 2) —— 不是只能往上加', async () => {
    planValue.current = 2;
    const get = await freshGetter();
    expect(get()).toBe(2);
  });

  it('env 显式设了就压过档位 —— 自建/压测的逃生口', async () => {
    planValue.current = 10;
    process.env.NEOX_MAX_CONCURRENT_AGENTS = '1';
    const get = await freshGetter();
    expect(get()).toBe(1);
  });

  it('非法档位值 (0 / NaN) 回落 3, 不会把并发压成 0 让所有派发都失败', async () => {
    for (const bad of [0, Number.NaN, -5]) {
      planValue.current = bad;
      const get = await freshGetter();
      expect(get()).toBe(3);
    }
  });

  it('同一进程内只解析一次 —— 中途档位变了也不改, 否则会废掉 prompt cache', async () => {
    planValue.current = 3;
    const get = await freshGetter();
    expect(get()).toBe(3);

    planValue.current = 10;          // 用户在别处升了档, 缓存文件被刷新
    expect(get()).toBe(3);           // 本进程仍是 3, 下次启动才生效
  });
});
