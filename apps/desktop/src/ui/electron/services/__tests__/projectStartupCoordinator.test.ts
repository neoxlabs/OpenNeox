/**
 * Tests for ProjectStartupCoordinator's DumbService extensions.
 *
 * 关注 P2 新增的 API: onChange, isDumb/isSmart/isFailed, runWhenSmart,
 * 以及合并广播的正确性. 构造完整 scope 成本高 —— 这里用最小 stub, 直接
 * 调 (coord as any).setStatus 模拟 phase 转移, 不跑真实 bootstrap.
 */
import { describe, it, expect, vi } from 'vitest';
import { ProjectStartupCoordinator } from '../projectStartupCoordinator.js';
import { CanceledError } from '@neoxlabs/platform/shared/async/progressContext.js';

function createScope() {
  const controller = new AbortController();
  const send = vi.fn();
  const onDispose = vi.fn();
  return {
    scope: {
      workspacePath: '/tmp/test-ws',
      window: {
        webContents: {
          send,
          isDestroyed: () => false,
        },
      },
      signal: controller.signal,
      onDispose,
      getService: vi.fn(),
      tryGetService: vi.fn(),
      peekService: vi.fn(),
    } as any,
    sendSpy: send,
    abort: () => controller.abort(),
  };
}

function createCoord(): { coord: ProjectStartupCoordinator; sendSpy: ReturnType<typeof vi.fn>; abort: () => void } {
  const { scope, sendSpy, abort } = createScope();
  const coord = new ProjectStartupCoordinator(scope);
  return { coord, sendSpy, abort };
}

/** Direct mutate for tests; in production only run() calls setStatus. */
function setPhase(coord: ProjectStartupCoordinator, partial: Record<string, unknown>): void {
  (coord as any).setStatus(partial);
}

describe('ProjectStartupCoordinator · initial state', () => {
  it('starts in dumb mode (phase=opening)', () => {
    const { coord } = createCoord();
    expect(coord.isDumb()).toBe(true);
    expect(coord.isSmart()).toBe(false);
    expect(coord.isFailed()).toBe(false);
    expect(coord.dumbAwareState()).toBe('dumb');
    expect(coord.getStatus().phase).toBe('opening');
  });
});

describe('ProjectStartupCoordinator · phase classification', () => {
  it('classifies scanning/interactive as dumb', () => {
    const { coord } = createCoord();
    setPhase(coord, { phase: 'interactive' });
    expect(coord.isDumb()).toBe(true);
    setPhase(coord, { phase: 'scanning' });
    expect(coord.isDumb()).toBe(true);
  });

  it('classifies smart/enriching/ready as smart', () => {
    const { coord } = createCoord();
    setPhase(coord, { phase: 'smart' });
    expect(coord.isSmart()).toBe(true);
    setPhase(coord, { phase: 'enriching' });
    expect(coord.isSmart()).toBe(true);
    setPhase(coord, { phase: 'ready' });
    expect(coord.isSmart()).toBe(true);
  });

  it('classifies failed separately', () => {
    const { coord } = createCoord();
    setPhase(coord, { phase: 'failed' });
    expect(coord.isFailed()).toBe(true);
    expect(coord.isDumb()).toBe(false);
    expect(coord.isSmart()).toBe(false);
    expect(coord.dumbAwareState()).toBe('failed');
  });
});

describe('ProjectStartupCoordinator · onChange', () => {
  it('invokes listener on status change (coalesced)', async () => {
    const { coord } = createCoord();
    const listener = vi.fn();
    coord.onChange(listener);

    setPhase(coord, { phase: 'scanning' });
    setPhase(coord, { semantic: 'running' });
    setPhase(coord, { embedding: 'running' });

    await new Promise((r) => setTimeout(r, 30));
    // 合并后只应广播 1 次 (三个 setStatus 都在 scheduler delayMs=8 窗口内)
    expect(listener).toHaveBeenCalledTimes(1);
    const snap = listener.mock.calls[0][0];
    expect(snap.phase).toBe('scanning');
    expect(snap.semantic).toBe('running');
    expect(snap.embedding).toBe('running');
  });

  it('does not invoke when setStatus is a no-op', async () => {
    const { coord } = createCoord();
    const listener = vi.fn();
    coord.onChange(listener);
    setPhase(coord, { phase: 'opening' });  // 已是 opening
    await new Promise((r) => setTimeout(r, 30));
    expect(listener).not.toHaveBeenCalled();
  });

  it('unsubscribe stops callbacks', async () => {
    const { coord } = createCoord();
    const listener = vi.fn();
    const unsub = coord.onChange(listener);
    unsub();
    setPhase(coord, { phase: 'scanning' });
    await new Promise((r) => setTimeout(r, 30));
    expect(listener).not.toHaveBeenCalled();
  });

  it('pushes to webContents.send on every broadcast', async () => {
    const { coord, sendSpy } = createCoord();
    setPhase(coord, { phase: 'scanning' });
    await new Promise((r) => setTimeout(r, 30));
    expect(sendSpy).toHaveBeenCalledWith(
      'project-startup:state-changed',
      expect.objectContaining({ phase: 'scanning' }),
    );
  });
});

describe('ProjectStartupCoordinator · runWhenSmart', () => {
  it('runs immediately when already smart', async () => {
    const { coord } = createCoord();
    setPhase(coord, { phase: 'smart' });
    let receivedCtxCanceled: boolean | null = null;
    const fn = vi.fn(async (ctx: { isCanceled: boolean }) => {
      receivedCtxCanceled = ctx.isCanceled;
      return 'hello';
    });
    const result = await coord.runWhenSmart(fn);
    expect(result).toBe('hello');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(receivedCtxCanceled).toBe(false);
  });

  it('queues in dumb mode, runs on transition to smart', async () => {
    const { coord } = createCoord();
    const fn = vi.fn(async () => 42);

    const promise = coord.runWhenSmart(fn, { label: 'test' });
    // 还在 dumb, fn 未被调用
    await new Promise((r) => setTimeout(r, 10));
    expect(fn).not.toHaveBeenCalled();

    // 转 smart —— flush queue
    setPhase(coord, { phase: 'smart' });

    const result = await promise;
    expect(result).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('rejects pending tasks when phase becomes failed', async () => {
    const { coord } = createCoord();
    const fn = vi.fn();
    const promise = coord.runWhenSmart(fn);

    setPhase(coord, { phase: 'failed', error: 'bootstrap crash' });
    await expect(promise).rejects.toThrow(CanceledError);
    expect(fn).not.toHaveBeenCalled();
  });

  it('rejects immediately when already failed', async () => {
    const { coord } = createCoord();
    setPhase(coord, { phase: 'failed' });
    await expect(coord.runWhenSmart(() => 'x')).rejects.toThrow(CanceledError);
  });

  it('honors external signal and removes task from queue', async () => {
    const { coord } = createCoord();
    const controller = new AbortController();
    const fn = vi.fn();
    const promise = coord.runWhenSmart(fn, { signal: controller.signal });

    controller.abort();
    await expect(promise).rejects.toThrow();

    // 后续转 smart 不应再跑 fn
    setPhase(coord, { phase: 'smart' });
    await new Promise((r) => setTimeout(r, 10));
    expect(fn).not.toHaveBeenCalled();
  });

  it('honors timeoutMs', async () => {
    const { coord } = createCoord();
    const fn = vi.fn();
    const promise = coord.runWhenSmart(fn, { timeoutMs: 20, label: 'tm' });
    await expect(promise).rejects.toThrow(CanceledError);
    expect(fn).not.toHaveBeenCalled();
  });

  it('runs queued tasks in FIFO order', async () => {
    const { coord } = createCoord();
    const order: number[] = [];
    const p1 = coord.runWhenSmart(async () => { order.push(1); });
    const p2 = coord.runWhenSmart(async () => { order.push(2); });
    const p3 = coord.runWhenSmart(async () => { order.push(3); });

    setPhase(coord, { phase: 'smart' });
    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });
});

describe('ProjectStartupCoordinator · dispose', () => {
  it('rejects pending smart tasks', async () => {
    const { coord } = createCoord();
    const fn = vi.fn();
    const promise = coord.runWhenSmart(fn);
    coord.dispose();
    await expect(promise).rejects.toThrow(CanceledError);
    expect(fn).not.toHaveBeenCalled();
  });

  it('clears listeners', async () => {
    const { coord } = createCoord();
    const listener = vi.fn();
    coord.onChange(listener);
    coord.dispose();
    // 直接 mutate: dispose 后 setStatus 不应触发 listener
    setPhase(coord, { phase: 'scanning' });
    await new Promise((r) => setTimeout(r, 30));
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('ProjectStartupCoordinator · broadcast scheduler', () => {
  it('broadcasts at most once per 8ms window for rapid changes', async () => {
    const { coord } = createCoord();
    const listener = vi.fn();
    coord.onChange(listener);

    // 5 次同步修改 → 合并成 1 次广播
    for (let i = 0; i < 5; i += 1) {
      setPhase(coord, {
        semantic: i % 2 === 0 ? 'running' : 'ready',
      });
    }
    await new Promise((r) => setTimeout(r, 30));

    expect(listener).toHaveBeenCalledTimes(1);
  });
});
