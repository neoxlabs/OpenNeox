import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ windows: [] as Array<{ isDestroyed: () => boolean }>, ready: true, exit: vi.fn() }));
vi.mock('electron', () => ({
  app: { isReady: () => state.ready, exit: state.exit },
  BrowserWindow: { getAllWindows: () => state.windows },
}));

describe('quitGuards', () => {
  beforeEach(() => {
    vi.resetModules();
    state.windows = [];
    state.ready = true;
    state.exit.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it('没有窗口时重开; 有窗口 / 还没注册建窗函数 / app 未就绪时不动', async () => {
    const g = await import('../quitGuards.js');
    const open = vi.fn(async () => {});
    g.reopenWindowIfNone('before-register');
    expect(open).not.toHaveBeenCalled();

    g.registerWindowOpener(open);
    state.windows = [{ isDestroyed: () => false }];
    g.reopenWindowIfNone('has-window');
    expect(open).not.toHaveBeenCalled();

    state.windows = [{ isDestroyed: () => true }];
    state.ready = false;
    g.reopenWindowIfNone('not-ready');
    expect(open).not.toHaveBeenCalled();

    state.ready = true;
    g.reopenWindowIfNone('second-instance');
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('卡住的等待按超时取 fallback, 出错也取 fallback', async () => {
    vi.useFakeTimers();
    const g = await import('../quitGuards.js');
    const hung = g.withQuitTimeout(new Promise<number>(() => {}), 1_500, 0, 'hung');
    vi.advanceTimersByTime(1_500);
    await expect(hung).resolves.toBe(0);
    await expect(g.withQuitTimeout(Promise.resolve(3), 1_500, 0, 'ok')).resolves.toBe(3);
    await expect(g.withQuitTimeout(Promise.reject(new Error('x')), 1_500, 0, 'err')).resolves.toBe(0);
  });

  it('总闸到点强制退出, 且只布一次', async () => {
    vi.useFakeTimers();
    const g = await import('../quitGuards.js');
    g.armQuitWatchdog(8_000);
    g.armQuitWatchdog(8_000);
    vi.advanceTimersByTime(7_999);
    expect(state.exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(state.exit).toHaveBeenCalledTimes(1);
  });
});
