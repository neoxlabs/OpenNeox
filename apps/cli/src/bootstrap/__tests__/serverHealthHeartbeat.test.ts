import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ServerHealthHeartbeat } from '../serverHealthHeartbeat.js';

/**
 * 心跳的两条命根子 —。
 *
 * 用户现象: CLI 长时间不动之后就废了, 连快捷键都没反应。查到心跳这一层有两个坑,
 * 它们的共同点是**坏掉之后完全没有声音**: 心跳还"在跑", 但已经永远不会再做任何事。
 *
 *  1. 保活头 —— server 侧 /health 默认不计入活跃 (防监控探针续命)。CLI 心跳打的正是
 *     /health, 于是开着 CLI 也不算有人在用, 能拦住 daemon 自杀的只剩 SSE 连接数一个信号。
 *     心跳必须带 x-neox-client, server 才认得出"这是个真客户端"。
 *
 *  2. 恢复超时 —— onServerUnreachable 本身就是在"后端不可用"时跑的, 而不可用常表现为
 *     连接永不返回。没有超时的话 recovering 标志永远不回落, 之后每次 check 都在开头
 *     直接 return —— 心跳事实上死了。
 */

const originalFetch = globalThis.fetch;

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
});

describe('心跳保活标识', () => {
  it('/health 请求必须带 x-neox-client — 否则 server 不认为有人在用', async () => {
    const seen: Array<Record<string, string>> = [];
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      seen.push((init?.headers ?? {}) as Record<string, string>);
      return { ok: true, status: 200 } as any;
    }) as any;

    const hb = new ServerHealthHeartbeat({
      healthUrl: 'http://127.0.0.1:4399/health',
      intervalMs: 1000,
      onServerUnreachable: async () => {},
    });
    hb.start();
    await vi.advanceTimersByTimeAsync(1100);
    hb.stop();

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]['x-neox-client']).toBe('cli-interactive');
  });
});

describe('恢复不会无限期挂住', () => {
  it('恢复卡死时心跳仍能继续 — 不是永久停摆', async () => {
    /* 模拟后端彻底不应答: 健康检查失败, 且恢复动作永不 resolve */
    globalThis.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as any;
    let recoveryStarted = 0;
    const hb = new ServerHealthHeartbeat({
      healthUrl: 'http://127.0.0.1:4399/health',
      intervalMs: 500,
      failThreshold: 1,
      onServerUnreachable: async () => {
        recoveryStarted += 1;
        await new Promise(() => { /* 永远不 resolve —— 正是现场那种情况 */ });
      },
    });
    hb.start();

    /* 第一次触发恢复 */
    await vi.advanceTimersByTimeAsync(600);
    expect(recoveryStarted).toBe(1);

    /* 恢复挂住期间, 推进远超单次恢复上限 (30s) 的时间。
     * 如果没有超时保护, recovering 会永远为 true, 恢复再也不会被触发第二次。 */
    await vi.advanceTimersByTimeAsync(40_000);
    expect(recoveryStarted).toBeGreaterThan(1);

    hb.stop();
  });

  it('stop() 之后不再发起检查', async () => {
    const calls: number[] = [];
    globalThis.fetch = vi.fn(async () => { calls.push(Date.now()); return { ok: true, status: 200 } as any; }) as any;
    const hb = new ServerHealthHeartbeat({
      healthUrl: 'http://127.0.0.1:4399/health',
      intervalMs: 500,
      onServerUnreachable: async () => {},
    });
    hb.start();
    await vi.advanceTimersByTimeAsync(1100);
    const before = calls.length;
    hb.stop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(calls.length).toBe(before);
  });
});
