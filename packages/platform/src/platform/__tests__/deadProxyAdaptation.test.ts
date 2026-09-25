/**
 * 代理环境变量和系统代理状态必须保持一致。
 * ═══════════════════════════════════════════════════════════════════════════
 * 测试覆盖两项约束:
 *
 *   ① 我们自己写进 env 的代理副本, 被下游当成"用户 export 的"。
 *      主进程探到系统代理后写 HTTP_PROXY 转发给子进程/worker; 而 env 的优先级**高于**
 *      系统设置, 于是 worker (env 是 spawn 那一刻的拷贝) 自己再探时永远读到那份开机快照,
 *      用户后来关掉代理也翻不了身 —— axios 每次请求都读 env, 就一直打 127.0.0.1:7897。
 *      转发的环境变量带指纹，子进程重新探测时跳过该副本；代理关闭后副本必须清除。
 *
 *   ② 系统设置里代理还开着, 但那个端口没人监听 (代理客户端崩了/被强杀)。
 *      回环代理拒绝连接时临时隔离并自动重试；远端代理拒连不得静默改为直连。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ENV_KEYS = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'NEOX_PROXY_ENV_SYNTHETIC',
] as const;
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
  const { setGlobalDispatcher, Agent } = await import('undici');
  setGlobalDispatcher(new Agent());
});

async function freshModule() {
  vi.resetModules();
  return import('../systemProxy.js');
}

describe('① 我们转发的 env 副本不算"用户的明确意图"', () => {
  it('带指纹的 env 被跳过 —— 探测继续读真正的系统设置', async () => {
    const { proxyEnvFingerprint, PROXY_ENV_SYNTHETIC_MARKER } = await import('../proxy/types.js');
    process.env.HTTP_PROXY = 'http://127.0.0.1:7897';
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7897';
    process.env[PROXY_ENV_SYNTHETIC_MARKER] = proxyEnvFingerprint(
      'http://127.0.0.1:7897', 'http://127.0.0.1:7897', '',
    );

    vi.resetModules();
    const { detectSystemProxy } = await import('../proxy/detect.js');
    /* 匹配指纹的变量是宿主转发副本，不应被当作用户 env 来源。 */
    expect(detectSystemProxy().source).not.toBe('env');
  });

  it('用户自己 export 的 (指纹对不上) 照旧最高优先', async () => {
    const { PROXY_ENV_SYNTHETIC_MARKER } = await import('../proxy/types.js');
    process.env.HTTP_PROXY = 'http://127.0.0.1:7897';
    /* 指纹不匹配，说明当前值应按用户显式配置处理。 */
    process.env[PROXY_ENV_SYNTHETIC_MARKER] = 'http://127.0.0.1:1111||';

    vi.resetModules();
    const { detectSystemProxy } = await import('../proxy/detect.js');
    const cfg = detectSystemProxy();
    expect(cfg.source).toBe('env');
    expect(cfg.http?.port).toBe(7897);
  });
});

describe('② 死代理隔离', () => {
  it('回环代理 ECONNREFUSED → 隔离, 之后按直连处理', async () => {
    process.env.HTTP_PROXY = 'http://127.0.0.1:59998';
    process.env.HTTPS_PROXY = 'http://127.0.0.1:59998';
    const mod = await freshModule();
    expect(mod.applySystemProxySync().detected).toBe(true);

    const outcome = mod.reportProxyUnreachableFromErrorText(
      'Network error: connect ECONNREFUSED 127.0.0.1:59998',
    );
    expect(outcome).toBe('quarantined');
    expect(mod.getProxyQuarantine().map((q) => q.endpoint)).toContain('127.0.0.1:59998');
    /* 隔离后当前生效配置不再使用该端点。 */
    expect(mod.getSystemProxyResult()?.httpProxy).toBeNull();
    expect(mod.getSystemProxyResult()?.httpsProxy).toBeNull();
  });

  it('远端代理拒连不隔离 —— 不替用户把流量改成直连', async () => {
    process.env.HTTP_PROXY = 'http://proxy.corp.example:8080';
    process.env.HTTPS_PROXY = 'http://proxy.corp.example:8080';
    const mod = await freshModule();
    mod.applySystemProxySync();

    expect(mod.reportProxyUnreachableFromErrorText(
      'connect ECONNREFUSED proxy.corp.example:8080',
    )).toBe('kept');
    expect(mod.getProxyQuarantine()).toHaveLength(0);
  });

  it('跟当前代理无关的 ECONNREFUSED 一律不动 (用户自己的本地服务)', async () => {
    process.env.HTTP_PROXY = 'http://127.0.0.1:59998';
    const mod = await freshModule();
    mod.applySystemProxySync();

    expect(mod.reportProxyUnreachableFromErrorText(
      'connect ECONNREFUSED 127.0.0.1:3000',
    )).toBe('not-proxy');
    expect(mod.getProxyQuarantine()).toHaveLength(0);
  });

  it('文案里没有 ECONNREFUSED 就什么都不做', async () => {
    const mod = await freshModule();
    expect(mod.reportProxyUnreachableFromErrorText('socket hang up')).toBe('not-proxy');
    expect(mod.reportProxyUnreachableFromErrorText(undefined)).toBe('not-proxy');
  });
});
