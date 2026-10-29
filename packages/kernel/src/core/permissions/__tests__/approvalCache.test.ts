import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ApprovalCache, getApprovalCache, __resetApprovalCacheForTest } from '../approvalCache.js';
import { runWithSessionScope } from '../../sessionScope.js';

const key = (overrides: Partial<{ command: string; cwd: string; profile: string; scope: string }> = {}) => ({
  command: 'echo hi',
  cwd: '/tmp',
  profile: 'moderate',
  ...overrides,
});

beforeEach(() => {
  __resetApprovalCacheForTest();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ApprovalCache 基础命中', () => {
  it('未写入时 miss', () => {
    expect(new ApprovalCache().get(key())).toBeUndefined();
  });

  it('记住 approved / denied', () => {
    const c = new ApprovalCache();
    c.set(key(), 'approved');
    c.set(key({ command: 'rm x' }), 'denied');
    expect(c.get(key())).toBe('approved');
    expect(c.get(key({ command: 'rm x' }))).toBe('denied');
  });

  it('command / cwd / profile 任一不同就 miss', () => {
    const c = new ApprovalCache();
    c.set(key(), 'approved');
    expect(c.get(key({ command: 'echo bye' }))).toBeUndefined();
    expect(c.get(key({ cwd: '/var' }))).toBeUndefined();
    expect(c.get(key({ profile: 'strict' }))).toBeUndefined();
  });

  it('profile 缺省与显式空串等价', () => {
    const c = new ApprovalCache();
    const base = { command: 'x', cwd: '/tmp' };
    c.set(base, 'approved');
    expect(c.get({ ...base, profile: '' })).toBe('approved');
  });

  it('scope 隔离：不同会话互不命中', () => {
    const c = new ApprovalCache();
    c.set(key({ scope: 's1' }), 'approved');
    expect(c.get(key({ scope: 's2' }))).toBeUndefined();
  });

  it('不传 scope 时跟随当前 SessionScope', () => {
    const c = new ApprovalCache();
    runWithSessionScope({ sessionId: 'scope-a' } as any, () => {
      c.set(key(), 'approved');
      expect(c.get(key())).toBe('approved');
    });
    runWithSessionScope({ sessionId: 'scope-b' } as any, () => {
      expect(c.get(key())).toBeUndefined();
    });
  });
});

describe('ApprovalCache TTL 与 LRU', () => {
  it('超过 TTL 后失效并删除', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const c = new ApprovalCache(64, 1000);
    c.set(key(), 'approved');
    vi.advanceTimersByTime(1001);
    expect(c.get(key())).toBeUndefined();
    expect(c.size()).toBe(0);
  });

  it('TTL 内仍然命中，TTL 从批准时间算', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const c = new ApprovalCache(64, 1000);
    c.set(key(), 'approved');
    vi.advanceTimersByTime(500);
    expect(c.get(key())).toBe('approved');
    vi.advanceTimersByTime(501);
    expect(c.get(key())).toBeUndefined();
  });

  it('超过容量时淘汰最久未访问的条目', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const c = new ApprovalCache(2, 60_000);
    const a = key({ command: 'a' });
    const b = key({ command: 'b' });
    const d = key({ command: 'd' });
    c.set(a, 'approved');
    vi.advanceTimersByTime(1);
    c.set(b, 'approved');
    vi.advanceTimersByTime(1);
    expect(c.get(a)).toBe('approved'); // a 变成最近访问
    vi.advanceTimersByTime(1);
    c.set(d, 'approved');
    expect(c.size()).toBe(2);
    expect(c.get(b)).toBeUndefined(); // b 最久未访问
    expect(c.get(a)).toBe('approved');
    expect(c.get(d)).toBe('approved');
  });
});

describe('ApprovalCache 删除与清理', () => {
  it('delete 只删指定 key', () => {
    const c = new ApprovalCache();
    c.set(key(), 'approved');
    c.set(key({ command: 'other' }), 'approved');
    expect(c.delete(key())).toBe(true);
    expect(c.delete(key())).toBe(false);
    expect(c.get(key())).toBeUndefined();
    expect(c.get(key({ command: 'other' }))).toBe('approved');
  });

  it('clear 清空全部', () => {
    const c = new ApprovalCache();
    c.set(key(), 'approved');
    c.set(key({ command: 'x' }), 'denied');
    c.clear();
    expect(c.size()).toBe(0);
    expect(c.get(key())).toBeUndefined();
  });

  it('clearScope 只清一个会话并返回删除数', () => {
    const c = new ApprovalCache();
    c.set(key({ scope: 's1' }), 'approved');
    c.set(key({ command: 'x', scope: 's1' }), 'approved');
    c.set(key({ scope: 's2' }), 'approved');
    expect(c.clearScope('s1')).toBe(2);
    expect(c.get(key({ scope: 's1' }))).toBeUndefined();
    expect(c.get(key({ scope: 's2' }))).toBe('approved');
  });

  it('clearScope 缺省参数清除当前会话', () => {
    const c = new ApprovalCache();
    runWithSessionScope({ sessionId: 'current' } as any, () => {
      c.set(key(), 'approved');
      expect(c.clearScope()).toBe(1);
    });
  });
});

describe('全局单例', () => {
  it('getApprovalCache 返回同一实例，reset 后换新', () => {
    const a = getApprovalCache();
    expect(getApprovalCache()).toBe(a);
    __resetApprovalCacheForTest();
    expect(getApprovalCache()).not.toBe(a);
  });
});
