import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';

/** 指向一个必然没人监听的端口: 走代理就 ECONNREFUSED, 直连则会成功 —— 两者可区分 */
const DEAD_PROXY = 'http://127.0.0.1:59999';

const ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  /* 把全局 dispatcher 还原成无代理, 免得污染同进程里别的用例 */
  const { setGlobalDispatcher, Agent } = await import('undici');
  setGlobalDispatcher(new Agent());
});

/** 每个用例都要一份全新模块 (内部有 cachedResult 幂等缓存) */
async function freshModule() {
  const vitest = await import('vitest');
  vitest.vi.resetModules();
  return import('../systemProxy.js');
}

describe('系统代理同步安装', () => {
  it('同步返回 —— 不是 Promise, 返回时 dispatcher 已就位 (窗口期为 0)', async () => {
    process.env.HTTP_PROXY = DEAD_PROXY;
    process.env.HTTPS_PROXY = DEAD_PROXY;
    const mod = await freshModule();

    const r = mod.applySystemProxySync();
    /* 关键: 拿到的是结果本身而不是 Promise —— 调用方无从"忘记 await" */
    expect(typeof (r as any).then).not.toBe('function');
    expect(r.detected).toBe(true);
    expect(r.source).toBe('env');
    expect(r.dispatcherInstalled).toBe(true);
  });

  it('外部 host 的 fetch 真的走代理 (代理死了就该连不上, 而不是绕过去直连)', async () => {
    process.env.HTTP_PROXY = DEAD_PROXY;
    process.env.HTTPS_PROXY = DEAD_PROXY;
    const mod = await freshModule();
    mod.applySystemProxySync();

    await expect(
      fetch('https://neox-dev.com/', { signal: AbortSignal.timeout(8000) }),
    ).rejects.toThrow();
    /* 若哪天有人把 dispatcher 装回直连, 这里会变成 200 通过 —— 用例即失效告警 */
  }, 15_000);

  it('本地回环仍然绕过代理 —— 塞进 Clash 就是黑洞, 本地 daemon 会永远挂死', async () => {
    process.env.HTTP_PROXY = DEAD_PROXY;
    process.env.HTTPS_PROXY = DEAD_PROXY;
    const mod = await freshModule();
    mod.applySystemProxySync();

    /* 安装时必须自动把 loopback 注进 NO_PROXY (EnvHttpProxyAgent 构造时读, 装完再改就晚了) */
    expect(process.env.NO_PROXY).toMatch(/127\.0\.0\.1/);
    expect(process.env.NO_PROXY).toMatch(/localhost/);

    let srv: Server | null = null;
    try {
      srv = createServer((_q, s) => s.end('local-ok'));
      await new Promise<void>((res) => srv!.listen(0, res));
      const port = (srv.address() as { port: number }).port;
      const text = await (await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(5000) })).text();
      expect(text).toBe('local-ok');
    } finally {
      srv?.close();
    }
  }, 15_000);

  it('没配代理时不装 dispatcher, 老老实实直连', async () => {
    /* env 全空; darwin 上还会去问 scutil, 本机可能真有系统代理 —— 只断言"不崩且给出结论" */
    const mod = await freshModule();
    const r = mod.applySystemProxySync();
    expect(typeof r.detected).toBe('boolean');
    if (!r.detected) expect(r.dispatcherInstalled).toBe(false);
  });
});
