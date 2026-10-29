import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  acquireDbOpenLock,
  dbOpenLockPath,
  isDbOpenLockStale,
  DbOpenLockTimeoutError,
  withDbOpenLock,
} from '../dbOpenLock.js';


let dir: string | null = null;

afterEach(() => {
  if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } dir = null; }
});

function tmpDir(): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-dblock-'));
  return dir;
}

describe('dbOpenLock', () => {
  it('第二个申请者等待, 释放后拿到', () => {
    const d = tmpDir();
    const dbPath = path.join(d, 'neox.db');
    const release = acquireDbOpenLock(dbPath, { timeoutMs: 200 });
    try {
      expect(fs.existsSync(dbOpenLockPath(dbPath))).toBe(true);
      expect(() => acquireDbOpenLock(dbPath, { timeoutMs: 120, pollMs: 10 }))
        .toThrow(DbOpenLockTimeoutError);
    } finally {
      release();
    }
    expect(fs.existsSync(dbOpenLockPath(dbPath))).toBe(false);
    const release2 = acquireDbOpenLock(dbPath, { timeoutMs: 200 });
    release2();
  });

  it('不会删除别人接管的锁 (释放幂等且只删自己的)', () => {
    const d = tmpDir();
    const dbPath = path.join(d, 'neox.db');
    const release = acquireDbOpenLock(dbPath, { timeoutMs: 200 });
    /* 模拟解锁前锁被别人替换 (stale 接管) */
    fs.writeFileSync(dbOpenLockPath(dbPath), JSON.stringify({ pid: 999999, host: os.hostname(), ts: Date.now() }));
    release();
    expect(fs.existsSync(dbOpenLockPath(dbPath))).toBe(true);
    fs.unlinkSync(dbOpenLockPath(dbPath));
  });

  it('持锁进程已退出 → 判定 stale 并接管', () => {
    const d = tmpDir();
    const dbPath = path.join(d, 'neox.db');
    /* 用一个几乎不可能存在的 PID 模拟崩溃的持锁进程 */
    const lockPath = dbOpenLockPath(dbPath);
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 2 ** 30, host: os.hostname(), ts: Date.now() }));
    expect(isDbOpenLockStale(lockPath)).toBe(true);
    const release = acquireDbOpenLock(dbPath, { timeoutMs: 500, pollMs: 10 });
    release();
  });

  it('锁内容损坏时按锁龄判断, 新鲜锁不会误判为 stale', () => {
    const d = tmpDir();
    const lockPath = dbOpenLockPath(path.join(d, 'neox.db'));
    fs.writeFileSync(lockPath, 'not-json');
    expect(isDbOpenLockStale(lockPath, { staleMs: 60_000 })).toBe(false);
    expect(isDbOpenLockStale(lockPath, { staleMs: 60_000, now: Date.now() + 120_000 })).toBe(true);
  });

  it('withDbOpenLock 出错时也释放锁', () => {
    const d = tmpDir();
    const dbPath = path.join(d, 'neox.db');
    expect(() => withDbOpenLock(dbPath, () => { throw new Error('boom'); })).toThrow('boom');
    expect(fs.existsSync(dbOpenLockPath(dbPath))).toBe(false);
  });
});
