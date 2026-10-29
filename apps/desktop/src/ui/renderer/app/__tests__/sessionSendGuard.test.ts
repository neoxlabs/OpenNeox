import { describe, expect, it, vi } from 'vitest';
import { SessionSendGuard } from '../sessionSendGuard';

describe('session send ownership', () => {
  it('allows a new conversation to send while another is awaiting IPC', () => {
    const guard = new SessionSendGuard();
    const a = guard.acquire('a')!;
    const b = guard.acquire('b')!;
    expect(guard.owns(a)).toBe(true);
    expect(guard.owns(b)).toBe(true);
    expect(guard.acquire('a')).toBeUndefined();
  });

  it('settling or stopping one conversation does not unlock another', () => {
    const guard = new SessionSendGuard();
    const a = guard.acquire('a')!;
    const b = guard.acquire('b')!;
    guard.settle('a');
    expect(guard.owns(a)).toBe(true);
    a.pending = false;
    guard.settle('a');
    expect(guard.owns(a)).toBe(false);
    expect(guard.owns(b)).toBe(true);
    guard.cancel('a');
    expect(guard.owns(b)).toBe(true);
  });

  it('late completion of a stopped send cannot unlock its replacement', () => {
    const guard = new SessionSendGuard();
    const old = guard.acquire('a')!;
    guard.cancel('a');
    const next = guard.acquire('a')!;
    guard.release(old);
    expect(guard.owns(next)).toBe(true);
  });

  it('binds the initial send to the newly created conversation', () => {
    const guard = new SessionSendGuard();
    const owner = guard.acquire(null)!;
    expect(guard.acquire(null)).toBeUndefined();
    expect(guard.bind(owner, 'new')).toBe(true);
    expect(guard.get(null)).toBeUndefined();
    expect(guard.get('new')).toBe(owner);
    expect(guard.acquire('new')).toBeUndefined();
    expect(guard.acquire('other')).toBeDefined();
  });

  it('cannot resurrect a cancelled owner or replace an existing owner', () => {
    const guard = new SessionSendGuard();
    const owner = guard.acquire(null)!;
    const existing = guard.acquire('a')!;
    expect(guard.bind(owner, 'a')).toBe(false);
    expect(guard.owns(existing)).toBe(true);
    guard.cancel(null);
    expect(guard.bind(owner, 'b')).toBe(false);
  });

  it('cleans up timers independently and on unmount', () => {
    vi.useFakeTimers();
    try {
      const guard = new SessionSendGuard();
      const fn = vi.fn();
      const a = guard.acquire('a')!;
      const b = guard.acquire('b')!;
      a.timer = setTimeout(fn, 1000);
      b.timer = setTimeout(fn, 1000);
      guard.cancel('a');
      expect(vi.getTimerCount()).toBe(1);
      guard.clear();
      vi.runAllTimers();
      expect(fn).not.toHaveBeenCalled();
      expect(guard.get('b')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
