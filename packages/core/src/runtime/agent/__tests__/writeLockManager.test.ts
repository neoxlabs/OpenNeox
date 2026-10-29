import { describe, it, expect, afterEach, vi } from 'vitest';
import path from 'node:path';
import {
  WriteLockManager,
  getGlobalWriteLockManager,
  resetGlobalWriteLockManager,
} from '../writeLockManager.js';

const managers: WriteLockManager[] = [];
function make(options: any = {}) {
  const m = new WriteLockManager({ retryInterval: 5, defaultTimeout: 100, lockTTL: 60_000, ...options });
  managers.push(m);
  return m;
}

afterEach(() => {
  while (managers.length) managers.pop()!.destroy();
  resetGlobalWriteLockManager();
  vi.useRealTimers();
});

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('WriteLockManager — 互斥', () => {
  it('首次获取成功，同一 Agent 并发也不能重入', () => {
    const m = make();
    expect(m.tryAcquire('/a.ts', 'agent-1')).toMatchObject({ success: true, waitTime: 0 });
    expect(m.tryAcquire('/a.ts', 'agent-1')).toMatchObject({ success: false, heldBy: 'agent-1' });
  });

  it('不同 Agent 争同一文件失败并带持有者', () => {
    const m = make();
    m.tryAcquire('/a.ts', 'a1');
    expect(m.tryAcquire('/a.ts', 'a2')).toEqual({ success: false, heldBy: 'a1' });
  });

  it('不同文件互不影响', () => {
    const m = make();
    expect(m.tryAcquire('/a.ts', 'a1').success).toBe(true);
    expect(m.tryAcquire('/b.ts', 'a2').success).toBe(true);
    expect(m.getStats().activeLocks).toBe(2);
  });

  it('相对路径与绝对路径指向同一把锁', () => {
    const m = make();
    m.tryAcquire('src/a.ts', 'a1');
    expect(m.tryAcquire(path.resolve('src/a.ts'), 'a2').success).toBe(false);
    expect(m.isLocked('src/a.ts')).toBe(true);
  });

  it('尾部斜杠被归一', () => {
    const m = make();
    m.tryAcquire('/tmp/dir/', 'a1');
    expect(m.tryAcquire('/tmp/dir', 'a2').success).toBe(false);
  });
});

describe('WriteLockManager — acquire 等待', () => {
  it('释放后唤醒等待者并返回 waitTime', async () => {
    const m = make();
    m.tryAcquire('/a.ts', 'a1');
    const pending = m.acquire('/a.ts', 'a2', 1000);
    await wait(10);
    expect(m.getStats().waitingRequests).toBe(1);
    m.release('/a.ts', 'a1');
    const r = await pending;
    expect(r.success).toBe(true);
    expect(r.waitTime).toBeGreaterThanOrEqual(0);
    expect(m.getLockInfo('/a.ts')?.agentId).toBe('a2');
  });

  it('超时返回失败、带持有者并清出队列', async () => {
    const m = make();
    m.tryAcquire('/a.ts', 'a1');
    const r = await m.acquire('/a.ts', 'a2', 20);
    expect(r).toMatchObject({ success: false, heldBy: 'a1' });
    expect(r.waitTime).toBeGreaterThanOrEqual(15);
    expect(m.getStats().waitingRequests).toBe(0);
  });

  it('多个等待者按 FIFO 唤醒', async () => {
    const m = make();
    m.tryAcquire('/a.ts', 'a1');
    const order: string[] = [];
    const p2 = m.acquire('/a.ts', 'a2', 1000).then(r => { if (r.success) order.push('a2'); });
    await wait(5);
    const p3 = m.acquire('/a.ts', 'a3', 1000).then(r => { if (r.success) order.push('a3'); });
    await wait(5);
    m.release('/a.ts', 'a1');
    await p2;
    await wait(5);
    m.release('/a.ts', 'a2');
    await p3;
    expect(order).toEqual(['a2', 'a3']);
  });

  it('destroy 时等待者立即收到失败', async () => {
    const m = make();
    m.tryAcquire('/a.ts', 'a1');
    const pending = m.acquire('/a.ts', 'a2', 5000);
    await wait(5);
    m.destroy();
    await expect(pending).resolves.toMatchObject({ success: false });
  });
});

describe('WriteLockManager — 释放', () => {
  it('释放不存在的锁返回 false', () => {
    expect(make().release('/nope', 'a1')).toBe(false);
  });

  it('不能释放其他 Agent 的锁', () => {
    const m = make();
    m.tryAcquire('/a.ts', 'a1');
    expect(m.release('/a.ts', 'a2')).toBe(false);
    expect(m.getLockInfo('/a.ts')?.agentId).toBe('a1');
  });

  it('releaseAll 只释放指定 Agent 的锁', () => {
    const m = make();
    m.tryAcquire('/a.ts', 'a1');
    m.tryAcquire('/b.ts', 'a1');
    m.tryAcquire('/c.ts', 'a2');
    expect(m.releaseAll('a1')).toBe(2);
    expect(m.getLocksForAgent('a1')).toEqual([]);
    expect(m.getLocksForAgent('a2')).toHaveLength(1);
  });

  it('释放时发出 lock_acquired / lock_released 事件', () => {
    const m = make();
    const events: string[] = [];
    m.on('lock_acquired', () => events.push('acquired'));
    m.on('lock_released', () => events.push('released'));
    m.tryAcquire('/a.ts', 'a1');
    m.release('/a.ts', 'a1');
    expect(events).toEqual(['acquired', 'released']);
  });
});

describe('WriteLockManager — 过期', () => {
  it('TTL 到点后 isLocked=false，可被重新获取', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const m = make({ lockTTL: 1000 });
    m.tryAcquire('/a.ts', 'a1');
    vi.advanceTimersByTime(1001);
    expect(m.isLocked('/a.ts')).toBe(false);
    expect(m.tryAcquire('/a.ts', 'a2').success).toBe(true);
  });

  it('过期锁直接抢占（tryAcquire 会清掉旧锁）', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const m = make({ lockTTL: 1000 });
    m.tryAcquire('/a.ts', 'a1');
    vi.advanceTimersByTime(1001);
    expect(m.tryAcquire('/a.ts', 'a2')).toMatchObject({ success: true });
    expect(m.getLockInfo('/a.ts')?.agentId).toBe('a2');
  });

  it('定期清理过期锁并唤醒等待者', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const m = make({ lockTTL: 1000 });
    m.tryAcquire('/a.ts', 'a1');
    const pending = m.acquire('/a.ts', 'a2', 10_000);
    await vi.advanceTimersByTimeAsync(1501);
    await expect(pending).resolves.toMatchObject({ success: true });
    expect(m.getLockInfo('/a.ts')?.agentId).toBe('a2');
  });
});

describe('WriteLockManager — 查询与单例', () => {
  it('getAllLocks / getLockInfo / getLocksForAgent', () => {
    const m = make();
    m.tryAcquire('/a.ts', 'a1');
    m.tryAcquire('/b.ts', 'a2');
    expect(m.getAllLocks()).toHaveLength(2);
    expect(m.getLockInfo('/a.ts')).toMatchObject({ agentId: 'a1', path: '/a.ts' });
    expect(m.getLocksForAgent('a2').map(l => l.path)).toEqual(['/b.ts']);
    expect(m.getLockInfo('/missing')).toBeUndefined();
  });

  it('getStats 统计锁与等待队列', async () => {
    const m = make();
    m.tryAcquire('/a.ts', 'a1');
    m.tryAcquire('/b.ts', 'a1');
    const pending = m.acquire('/a.ts', 'a2', 1000);
    await wait(5);
    const stats = m.getStats();
    expect(stats.activeLocks).toBe(2);
    expect(stats.waitingRequests).toBe(1);
    expect(stats.locksByAgent.get('a1')).toBe(2);
    m.releaseAll('a1');
    await pending;
  });

  it('全局单例可重置', () => {
    const a = getGlobalWriteLockManager();
    expect(getGlobalWriteLockManager()).toBe(a);
    resetGlobalWriteLockManager();
    expect(getGlobalWriteLockManager()).not.toBe(a);
  });
});
