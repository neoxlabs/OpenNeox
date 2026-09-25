import { describe, it, expect, beforeEach } from 'vitest';
import {
  ApprovalCache,
  __resetApprovalCacheForTest,
  getApprovalCache,
} from '@neoxlabs/kernel/core/permissions/approvalCache.js';

describe('ApprovalCache', () => {
  beforeEach(() => { __resetApprovalCacheForTest(); });

  it('get returns undefined for unknown key', () => {
    const c = new ApprovalCache();
    expect(c.get({ command: 'rm x', cwd: '/tmp' })).toBeUndefined();
  });

  it('set + get round-trip', () => {
    const c = new ApprovalCache();
    c.set({ command: 'rm x', cwd: '/tmp' }, 'approved');
    expect(c.get({ command: 'rm x', cwd: '/tmp' })).toBe('approved');
  });

  it('different cwd = different key', () => {
    const c = new ApprovalCache();
    c.set({ command: 'rm x', cwd: '/tmp' }, 'approved');
    expect(c.get({ command: 'rm x', cwd: '/other' })).toBeUndefined();
  });

  it('different profile = different key', () => {
    const c = new ApprovalCache();
    c.set({ command: 'rm x', cwd: '/tmp', profile: 'strict' }, 'approved');
    expect(c.get({ command: 'rm x', cwd: '/tmp', profile: 'moderate' })).toBeUndefined();
    expect(c.get({ command: 'rm x', cwd: '/tmp', profile: 'strict' })).toBe('approved');
  });

  it('TTL expires old entries', () => {
    const c = new ApprovalCache(64, 10); // 10 ms TTL
    c.set({ command: 'x', cwd: '/' }, 'approved');
    expect(c.get({ command: 'x', cwd: '/' })).toBe('approved');
    return new Promise<void>(resolve => {
      setTimeout(() => {
        expect(c.get({ command: 'x', cwd: '/' })).toBeUndefined();
        resolve();
      }, 20);
    });
  });

  it('delete removes entry', () => {
    const c = new ApprovalCache();
    c.set({ command: 'x', cwd: '/' }, 'approved');
    expect(c.delete({ command: 'x', cwd: '/' })).toBe(true);
    expect(c.get({ command: 'x', cwd: '/' })).toBeUndefined();
    // Idempotent
    expect(c.delete({ command: 'x', cwd: '/' })).toBe(false);
  });

  it('LRU eviction at cap', () => {
    const c = new ApprovalCache(2);  // cap = 2
    c.set({ command: 'a', cwd: '/' }, 'approved');
    c.set({ command: 'b', cwd: '/' }, 'approved');
    c.set({ command: 'c', cwd: '/' }, 'approved');
    expect(c.size()).toBe(2);
    // 'a' is oldest,应被驱逐
    expect(c.get({ command: 'a', cwd: '/' })).toBeUndefined();
    expect(c.get({ command: 'b', cwd: '/' })).toBe('approved');
    expect(c.get({ command: 'c', cwd: '/' })).toBe('approved');
  });

  it('clear removes all', () => {
    const c = new ApprovalCache();
    c.set({ command: 'a', cwd: '/' }, 'approved');
    c.set({ command: 'b', cwd: '/' }, 'denied');
    c.clear();
    expect(c.size()).toBe(0);
  });

  it('singleton getApprovalCache', () => {
    const a = getApprovalCache();
    const b = getApprovalCache();
    expect(a).toBe(b);
  });
});
