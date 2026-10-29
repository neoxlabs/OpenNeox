import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { GitStatusCache, type GitStatusCacheTuning, type GitStatusComputed } from '../gitStatusCache';

const ROOT = path.resolve('/repo');

interface Val { v: string; version?: number }

function makeHarness(tuning?: Partial<GitStatusCacheTuning>) {
  let value = 'v1';
  let duration = 0;
  let calls = 0;
  let onEvent: ((s: 'tree' | 'meta') => void) | null = null;
  let disposed = 0;
  let seq = 0;
  const pushed: Array<{ cwds: string[]; value: Val; prev: Val }> = [];
  const cache = new GitStatusCache<Val>({
    compute: async (): Promise<GitStatusComputed<Val>> => {
      calls++;
      const v = value;
      if (duration > 0) await new Promise((r) => setTimeout(r, duration));
      return { value: { v }, root: ROOT, metaDirs: [path.join(ROOT, '.git')] };
    },
    signature: (x) => x.v,
    stamp: (x) => ({ ...x, version: ++seq }),
    onChanged: (cwds, _root, next, prev) => { pushed.push({ cwds, value: next, prev }); },
    watch: (_cwd, cb) => { onEvent = cb; return { setMetaDirs() {}, dispose() { disposed++; } }; },
  }, tuning);
  return {
    cache,
    computeCalls: () => calls,
    setValue: (v: string) => { value = v; },
    setDuration: (ms: number) => { duration = ms; },
    pushed,
    fire: (s: 'tree' | 'meta' = 'tree') => onEvent?.(s),
    disposed: () => disposed,
  };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('没变就不算', () => {
  it('缓存有效时重复 get 不起 compute', async () => {
    const h = makeHarness();
    await h.cache.get(ROOT);
    await h.cache.get(ROOT);
    await h.cache.get(ROOT);
    expect(h.computeCalls()).toBe(1);
  });

  it('多个消费方同时 get → 单飞, 只算一次', async () => {
    const h = makeHarness();
    h.setDuration(100);
    const ps = [h.cache.get(ROOT), h.cache.get(ROOT), h.cache.get(ROOT)];
    await vi.advanceTimersByTimeAsync(100);
    const out = await Promise.all(ps);
    expect(out.map((x) => x.v)).toEqual(['v1', 'v1', 'v1']);
    expect(h.computeCalls()).toBe(1);
  });

  it('重算后签名没变: 保留旧对象 (版本号不动), 不通知', async () => {
    const h = makeHarness();
    const a = await h.cache.get(ROOT);
    const b = await h.cache.get(ROOT, { fresh: true });
    expect(h.computeCalls()).toBe(2);
    expect(b).toBe(a);
    expect(h.pushed).toEqual([]);
  });

  it('TTL 到了 get 才重算', async () => {
    const h = makeHarness({ minTtlMs: 60_000 });
    await h.cache.get(ROOT);
    await vi.advanceTimersByTimeAsync(59_000);
    await h.cache.get(ROOT);
    expect(h.computeCalls()).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000);
    await h.cache.get(ROOT);
    expect(h.computeCalls()).toBe(2);
  });
});

describe('写操作之后必须是新值', () => {
  it('hard 失效后 get 立刻重算, 版本号前进并通知', async () => {
    const h = makeHarness();
    const a = await h.cache.get(ROOT);
    h.setValue('v2');
    h.cache.invalidate(ROOT, 'hard');
    const b = await h.cache.get(ROOT);
    expect(b.v).toBe('v2');
    expect(b.version).toBeGreaterThan(a.version!);
    expect(h.pushed.map((p) => [p.prev.version, p.value.version])).toEqual([[a.version, b.version]]);
  });

  it('fresh 请求撞上正在算的一轮 → 等补跑的那一轮, 不拿旧值', async () => {
    const h = makeHarness();
    h.setDuration(100);
    const first = h.cache.get(ROOT);
    await vi.advanceTimersByTimeAsync(10);
    h.setValue('v2');
    const fresh = h.cache.get(ROOT, { fresh: true });
    await vi.advanceTimersByTimeAsync(300);
    expect((await fresh).v).toBe('v2');
    await first;
    expect(h.computeCalls()).toBe(2);
  });

  it('子目录 cwd 的写操作也让同根的缓存失效', async () => {
    const h = makeHarness();
    await h.cache.get(ROOT);
    h.setValue('v2');
    h.cache.invalidate(path.join(ROOT, 'packages', 'a'), 'hard');
    expect((await h.cache.get(ROOT)).v).toBe('v2');
  });
});

describe('事件驱动: 有人在看才后台算, 变了才通知', () => {
  it('树事件 → 防抖后后台重算 → 签名变了通知原始 cwd', async () => {
    const h = makeHarness({ debounceMs: 300 });
    const raw = ROOT + path.sep;                 /* 调用方传的原始字符串 */
    h.cache.retain(raw);
    await h.cache.get(raw);
    h.setValue('v2');
    h.fire('tree');
    await vi.advanceTimersByTimeAsync(299);
    expect(h.computeCalls()).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.computeCalls()).toBe(2);
    expect(h.pushed.map((p) => p.cwds)).toEqual([[raw]]);
  });

  it('.git 元数据事件同样触发 (终端里 commit / checkout)', async () => {
    const h = makeHarness();
    h.cache.retain(ROOT);
    await h.cache.get(ROOT);
    await vi.advanceTimersByTimeAsync(1_000);
    h.setValue('v2');
    h.fire('meta');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.pushed.length).toBe(1);
  });

  it('自己算的那一下引起的 .git 抖动不算', async () => {
    const h = makeHarness({ selfEventTailMs: 150 });
    h.cache.retain(ROOT);
    await h.cache.get(ROOT);
    h.fire('meta');                              /* 刚算完 0ms */
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.computeCalls()).toBe(1);
  });

  it('soft 脏且后台重算已排队时, get 先给旧值 —— N 个消费方不各自打穿', async () => {
    const h = makeHarness({ debounceMs: 300 });
    h.cache.retain(ROOT);
    await h.cache.get(ROOT);
    h.setValue('v2');
    h.fire('tree');
    expect((await h.cache.get(ROOT)).v).toBe('v1');
    expect((await h.cache.get(ROOT)).v).toBe('v1');
    expect(h.computeCalls()).toBe(1);
  });

  it('没人 retain 时事件只标脏不后台算; 下次 get 当场算', async () => {
    const h = makeHarness({ minTtlMs: 10 * 60_000 });
    await h.cache.get(ROOT);
    h.setValue('v2');
    h.fire('tree');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.computeCalls()).toBe(1);
    expect((await h.cache.get(ROOT)).v).toBe('v2');
  });

  it('release 到 0 之后不再后台算; 重新 retain 时补算攒下的脏', async () => {
    const h = makeHarness({ minTtlMs: 10 * 60_000 });
    h.cache.retain(ROOT);
    await h.cache.get(ROOT);
    h.cache.release(ROOT);
    h.setValue('v2');
    h.fire('tree');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.computeCalls()).toBe(1);
    h.cache.retain(ROOT);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.computeCalls()).toBe(2);
    expect(h.pushed.length).toBe(1);
  });
});

describe('大仓节流: 风暴不许变成连续重算', () => {
  it('一次算 1.5s → 两次后台重算间隔 ≥ gapFactor × 耗时', async () => {
    const h = makeHarness({ gapFactor: 8, maxGapMs: 30_000, debounceMs: 300 });
    h.cache.retain(ROOT);
    h.setDuration(1_500);
    const p = h.cache.get(ROOT);
    await vi.advanceTimersByTimeAsync(1_500);
    await p;
    /* 之后 60 秒里每 100ms 一个 fs 事件 */
    for (let t = 0; t < 60_000; t += 100) {
      h.fire('tree');
      await vi.advanceTimersByTimeAsync(100);
    }
    /* 每轮 1.5s 计算 + ≥12s 间隔 → 60s 里最多 5 轮 (无节流时是 40 轮) */
    expect(h.computeCalls() - 1).toBeLessThanOrEqual(5);
    expect(h.computeCalls() - 1).toBeGreaterThanOrEqual(3);
  });

  it('计算过程中来的树事件不立刻补跑, 结束后按间隔排', async () => {
    const h = makeHarness({ gapFactor: 8, debounceMs: 300 });
    h.cache.retain(ROOT);
    h.setDuration(1_000);
    const p = h.cache.get(ROOT);
    await vi.advanceTimersByTimeAsync(500);
    h.fire('tree');
    await vi.advanceTimersByTimeAsync(500);
    await p;
    expect(h.computeCalls()).toBe(1);
    await vi.advanceTimersByTimeAsync(7_000);
    expect(h.computeCalls()).toBe(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.computeCalls()).toBe(2);
  });
});

describe('回收', () => {
  it('release 后超过 disposeMs → entry 和 watcher 一起回收; 有人 retain 的不回收', async () => {
    const h = makeHarness({ disposeMs: 60_000, minTtlMs: 10 * 60_000 });
    h.cache.retain(ROOT);
    await h.cache.get(ROOT);
    await vi.advanceTimersByTimeAsync(120_000);
    await h.cache.get(path.resolve('/other'));
    expect(h.disposed()).toBe(0);
    h.cache.release(ROOT);
    await vi.advanceTimersByTimeAsync(61_000);
    await h.cache.get(path.resolve('/other'));
    expect(h.disposed()).toBe(2);
    expect(h.cache.size()).toBe(1);
  });
});
