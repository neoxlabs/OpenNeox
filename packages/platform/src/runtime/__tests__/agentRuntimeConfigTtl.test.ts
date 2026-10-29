import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const loadConfigMock = vi.fn();
vi.mock('../../utils/config.js', () => ({ loadConfig: () => loadConfigMock() }));
vi.mock('@neoxlabs/kernel/platform/cliLogger.js', () => ({
  cliLogger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

beforeEach(() => {
  vi.resetModules();
  loadConfigMock.mockReset();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('agentRuntimeConfig 缓存 TTL', () => {
  it('TTL 内重复读只读一次盘', async () => {
    loadConfigMock.mockReturnValue({ agentRuntime: { pty: { enabled: true } } });
    const m = await import('../agentRuntimeConfig.js');
    expect(m.isPtyEnabled()).toBe(true);
    expect(m.isPtyEnabled()).toBe(true);
    expect(loadConfigMock).toHaveBeenCalledTimes(1);
  });

  it('TTL 过期后重新读盘 —— 别的线程改了配置也能拿到 (本修复的核心)', async () => {
    loadConfigMock.mockReturnValue({ agentRuntime: { pty: { enabled: true } } });
    const m = await import('../agentRuntimeConfig.js');
    expect(m.isPtyEnabled()).toBe(true);

    /* 模拟"另一个线程把配置改了" —— 本线程没人调 refresh */
    loadConfigMock.mockReturnValue({ agentRuntime: { pty: { enabled: false } } });
    expect(m.isPtyEnabled()).toBe(true);          // TTL 内仍是旧值

    vi.advanceTimersByTime(2_001);
    expect(m.isPtyEnabled()).toBe(false);          // 过期后自动拿到新值
  });

  it('refreshAgentRuntimeConfig() 让本线程立刻失效, 不等 TTL', async () => {
    loadConfigMock.mockReturnValue({ agentRuntime: { osSandbox: { enabled: false } } });
    const m = await import('../agentRuntimeConfig.js');
    expect(m.isOsSandboxEnabled()).toBe(false);

    loadConfigMock.mockReturnValue({ agentRuntime: { osSandbox: { enabled: true } } });
    m.refreshAgentRuntimeConfig();
    expect(m.isOsSandboxEnabled()).toBe(true);
  });

  it('读盘失败也记时间戳, 不会每次调用都重试 I/O', async () => {
    loadConfigMock.mockImplementation(() => { throw new Error('disk boom'); });
    const m = await import('../agentRuntimeConfig.js');
    expect(m.isPtyEnabled()).toBe(true);   // 缺省值
    expect(m.isPtyEnabled()).toBe(true);
    expect(loadConfigMock).toHaveBeenCalledTimes(1);
  });
});
