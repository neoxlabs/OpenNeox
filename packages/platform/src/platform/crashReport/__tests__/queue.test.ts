
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RateLimiter } from '../dedupe.js';
import { CrashQueue } from '../queue.js';
import { CRASH_LIMITS, type CrashReportPayload } from '../types.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'neox-crash-'));
}

function report(overrides: Partial<CrashReportPayload> = {}): CrashReportPayload {
  return {
    kind: 'js',
    app: 'cli',
    version: '1.0.0',
    platform: 'darwin',
    arch: 'arm64',
    nodeVersion: '20.0.0',
    process: 'main',
    message: 'boom',
    stack: ['at a (a.ts:1:1)'],
    dedupeKey: 'k1',
    occurredAt: new Date(0).toISOString(),
    installId: 'inst-1',
    ...overrides,
  };
}

describe('RateLimiter', () => {
  let dir: string;
  let now = 1_700_000_000_000;
  const clock = () => now;

  beforeEach(() => {
    dir = tmpDir();
    now = 1_700_000_000_000;
  });

  it('同一 key 一天内最多报 3 次', () => {
    const rl = new RateLimiter(path.join(dir, 'rate.json'), clock);
    expect(rl.shouldSend('k1')).toBe(true);
    rl.record('k1');
    expect(rl.shouldSend('k1')).toBe(true);
    rl.record('k1');
    expect(rl.shouldSend('k1')).toBe(true);
    rl.record('k1');
    expect(rl.shouldSend('k1')).toBe(false);
  });

  it('跨过 24h 窗口后重新放开', () => {
    const rl = new RateLimiter(path.join(dir, 'rate.json'), clock);
    for (let i = 0; i < 3; i++) rl.record('k1');
    expect(rl.shouldSend('k1')).toBe(false);
    now += CRASH_LIMITS.dedupeWindowMs + 1;
    expect(rl.shouldSend('k1')).toBe(true);
  });

  it('不同 key 互不影响', () => {
    const rl = new RateLimiter(path.join(dir, 'rate.json'), clock);
    for (let i = 0; i < 3; i++) rl.record('k1');
    expect(rl.shouldSend('k2')).toBe(true);
  });
});

describe('CrashQueue', () => {
  let dir: string;
  let now = 1_700_000_000_000;
  const clock = () => now;

  beforeEach(() => {
    dir = tmpDir();
    now = 1_700_000_000_000;
  });

  it('入队后可列出, 删除后消失', () => {
    const q = new CrashQueue(path.join(dir, 'queue'), clock);
    const file = q.enqueue(report());
    expect(file).toBeTruthy();
    const list = q.list();
    expect(list).toHaveLength(1);
    expect(list[0].report.dedupeKey).toBe('k1');
    q.remove(list[0].file);
    expect(q.list()).toHaveLength(0);
  });

  it('超过 50 条删最旧', () => {
    const q = new CrashQueue(path.join(dir, 'queue'), clock);
    for (let i = 0; i < CRASH_LIMITS.queueMaxFiles + 10; i++) {
      now += 1;
      q.enqueue(report({ dedupeKey: `k${i}` }));
    }
    expect(q.list().length).toBe(CRASH_LIMITS.queueMaxFiles);
    /* 最旧的 k0..k9 被删, 剩下以 k10 开头 */
    expect(q.list()[0].report.dedupeKey).toBe('k10');
  });

  it('超过 7 天清掉', () => {
    const q = new CrashQueue(path.join(dir, 'queue'), clock);
    q.enqueue(report({ dedupeKey: 'old' }));
    now += CRASH_LIMITS.queueTtlMs + 1;
    q.enqueue(report({ dedupeKey: 'fresh' }));
    const keys = q.list().map((x) => x.report.dedupeKey);
    expect(keys).toContain('fresh');
    expect(keys).not.toContain('old');
  });
});
