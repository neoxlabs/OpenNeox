
import { setGlobalDispatcher, getGlobalDispatcher, Agent, type Dispatcher } from 'undici';
import { clearShellEnvCache } from './shellEnv.js';
import { detectSystemProxy } from './proxy/detect.js';
import { SystemProxyDispatcher } from './proxy/dispatcher.js';
import {
  endpointToUrl,
  hasAnyProxy,
  proxyEnvFingerprint,
  PROXY_ENV_SYNTHETIC_MARKER,
  sameProxyConfig,
  type SystemProxyConfig,
} from './proxy/types.js';

export type { SystemProxyConfig, ProxyEndpoint } from './proxy/types.js';

export interface ApplyResult {
  detected: boolean;
  source: 'env' | 'system' | 'none';
  /** http:// 请求走的代理 (null = 直连) */
  httpProxy: string | null;
  /** https:// 请求走的代理 (null = 直连) */
  httpsProxy: string | null;
  /** SOCKS 全协议通道 */
  socksProxy: string | null;
  /** PAC 脚本地址 */
  pacUrl: string | null;
  /** 例外表 (系统原文) */
  noProxy: string | null;
  dispatcherInstalled: boolean;
  /** 完整规范化配置 — 诊断用 */
  config: SystemProxyConfig;
}

let cachedConfig: SystemProxyConfig | null = null;
let cachedResult: ApplyResult | null = null;
let installedDispatcher: SystemProxyDispatcher | null = null;

const QUARANTINE_MS = 5 * 60_000;
/** "host:port" → 解除隔离的时刻 */
const quarantined = new Map<string, number>();

function epKey(ep: { host: string; port: number }): string {
  return `${ep.host}:${ep.port}`;
}

function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || h === '0.0.0.0' || /^127\./.test(h);
}

function isQuarantined(ep: { host: string; port: number } | null): boolean {
  if (!ep) return false;
  const until = quarantined.get(epKey(ep));
  if (until === undefined) return false;
  if (Date.now() >= until) {
    quarantined.delete(epKey(ep));
    return false;
  }
  return true;
}

/** 把正在隔离的端点从配置里摘掉 —— 摘光了就是直连。 */
function withoutQuarantined(cfg: SystemProxyConfig): SystemProxyConfig {
  if (quarantined.size === 0) return cfg;
  const http = isQuarantined(cfg.http) ? null : cfg.http;
  const https = isQuarantined(cfg.https) ? null : cfg.https;
  const socks = isQuarantined(cfg.socks) ? null : cfg.socks;
  if (http === cfg.http && https === cfg.https && socks === cfg.socks) return cfg;
  return { ...cfg, http, https, socks };
}

/** 这个端点是不是当前配置正在用的通道 */
function configUses(cfg: SystemProxyConfig | null, host: string, port: number): boolean {
  if (!cfg) return false;
  return [cfg.http, cfg.https, cfg.socks].some(
    (ep) => !!ep && ep.port === port
      && ep.host.replace(/^\[|\]$/g, '').toLowerCase() === host.replace(/^\[|\]$/g, '').toLowerCase(),
  );
}

function toResult(cfg: SystemProxyConfig, dispatcherInstalled: boolean): ApplyResult {
  return {
    detected: hasAnyProxy(cfg),
    source: cfg.source,
    httpProxy: cfg.http ? endpointToUrl(cfg.http) : null,
    httpsProxy: cfg.https ? endpointToUrl(cfg.https) : null,
    socksProxy: cfg.socks ? endpointToUrl(cfg.socks) : null,
    pacUrl: cfg.pacUrl,
    noProxy: cfg.exceptions.length ? cfg.exceptions.join(',') : null,
    dispatcherInstalled,
    config: cfg,
  };
}

/**
 * 把代理信息 fan-out 给子进程 (agent shell / execute_shell / .mjs 里的 curl 和 fetch).
 *
 * 只在**系统设置**来源时写 —— env 来源本来就是用户自己 export 的, 我们不该覆写他的值。
 * 写的是通用惯例名 (HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY), 因为子进程里跑的是
 * curl/git/npm 这些只认 env 的程序。PAC 无法用 env 表达, 跳过 (不猜一个固定代理塞进去)。
 *
 * NO_PROXY 里额外补回环: 子进程里的本地回环通信 (dev server / 本地 daemon) 跟主进程同理。
 */
function exportProxyEnvForChildren(cfg: SystemProxyConfig): void {
  const set = (name: string, value: string) => {
    process.env[name] = value;
    process.env[name.toLowerCase()] = value;
  };

  {
    const cur = proxyEnvFingerprint(
      process.env.HTTP_PROXY || process.env.http_proxy || '',
      process.env.HTTPS_PROXY || process.env.https_proxy || '',
      process.env.ALL_PROXY || process.env.all_proxy || '',
    );
    if (process.env[PROXY_ENV_SYNTHETIC_MARKER] === cur) {
      for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'] as const) {
        delete process.env[k];
      }
      delete process.env[PROXY_ENV_SYNTHETIC_MARKER];
    }
  }

  if (cfg.source === 'system') {
    const http = cfg.http ? endpointToUrl(cfg.http) : '';
    const https = cfg.https ? endpointToUrl(cfg.https) : '';
    const all = cfg.socks ? endpointToUrl(cfg.socks) : '';
    if (http) set('HTTP_PROXY', http);
    if (https) set('HTTPS_PROXY', https);
    if (all) set('ALL_PROXY', all);
    /* 留指纹: 子进程 / worker 拿到这份 env 拷贝后自己再探时, 认出这是"我们转发的副本"
     * 而不是用户 export 的, 于是继续去读真正的系统设置 —— 不会被开机快照永久压住。
     * (见 types.ts 的 PROXY_ENV_SYNTHETIC_MARKER; 这正是 Windows「代理关了还在打 7897」的根。) */
    if (http || https || all) {
      process.env[PROXY_ENV_SYNTHETIC_MARKER] = proxyEnvFingerprint(http, https, all);
    } else {
      delete process.env[PROXY_ENV_SYNTHETIC_MARKER];
    }
  }

  if (!hasAnyProxy(cfg) && cfg.source !== 'env') {
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
    return;
  }
  const exceptions = [...cfg.exceptions];
  for (const loop of ['127.0.0.1', 'localhost', '::1']) {
    if (!exceptions.includes(loop)) exceptions.push(loop);
  }
  if (cfg.excludeSimpleHostnames && !exceptions.includes('<local>')) exceptions.push('<local>');
  set('NO_PROXY', exceptions.join(','));
}

function doApply(force: boolean): ApplyResult {
  if (cachedResult && !force) return cachedResult;

  /* 隔离中的端点在这里就被摘掉 —— 下游 (dispatcher / 子进程 env / 诊断) 全部只看到
   * "现在真正能用的那份配置", 不需要各自再判一遍。 */
  const cfg = withoutQuarantined(detectSystemProxy());
  /* 配置没变就别动全局 dispatcher —— 重装会把在途请求的连接池换掉, 白白抖一次 */
  if (cachedResult && sameProxyConfig(cachedConfig, cfg)) return cachedResult;

  const previous = cachedConfig;
  cachedConfig = cfg;

  if (!hasAnyProxy(cfg)) {
    if (installedDispatcher) {
      setGlobalDispatcher(new Agent());
      void installedDispatcher.close().catch(() => { /* 关旧池失败不影响新路径 */ });
      installedDispatcher = null;
    }
    exportProxyEnvForChildren(cfg);
    if (previous) clearShellEnvCache();
    cachedResult = toResult(cfg, false);
    return cachedResult;
  }

  exportProxyEnvForChildren(cfg);

  const next = new SystemProxyDispatcher(cfg);
  const old = installedDispatcher;
  setGlobalDispatcher(next as unknown as Dispatcher);
  installedDispatcher = next;
  /* 旧 dispatcher 的 keep-alive 连接自然流干后再关, 不打断在途请求 */
  if (old) void old.close().catch(() => { /* 同上 */ });

  if (previous) clearShellEnvCache();
  cachedResult = toResult(cfg, true);
  return cachedResult;
}

/**
 * **同步**主入口 —— 必须在主进程任何 fetch 之前调.
 * 返回时全进程的 Node fetch 已经在按用户的系统代理选路了, 没有窗口期.
 */
export function applySystemProxySync(): ApplyResult {
  return doApply(false);
}

/** 异步签名保留给老调用方 (CLI), 内部就是同步实现. */
export function applySystemProxy(): Promise<ApplyResult> {
  return Promise.resolve(doApply(false));
}

let watchTimer: NodeJS.Timeout | null = null;
type ProxyChangeListener = (before: ApplyResult, after: ApplyResult) => void;
const changeListeners = new Set<ProxyChangeListener>();

/** 动态跟随: 每 intervalMs 重探, 配置变了就换 dispatcher 并通知订阅者. */
export function startSystemProxyWatch(intervalMs = 30000): void {
  if (watchTimer !== null) return;
  watchTimer = setInterval(() => {
    const before = cachedResult;
    const beforeConfig = cachedConfig;
    try {
      const after = doApply(true);
      if (!before || sameProxyConfig(beforeConfig, after.config)) return;
      for (const cb of changeListeners) {
        try { cb(before, after); } catch { /* listener 崩不能带崩 watch */ }
      }
    } catch { /* 单次 tick 失败静默, 下 tick 再试 */ }
  }, intervalMs);
  if (typeof watchTimer.unref === 'function') watchTimer.unref();
}

export function stopSystemProxyWatch(): void {
  if (watchTimer !== null) {
    clearInterval(watchTimer);
    watchTimer = null;
  }
}

/** 订阅代理变化. 返 unsubscribe. */
export function onSystemProxyChange(cb: ProxyChangeListener): () => void {
  changeListeners.add(cb);
  return () => { changeListeners.delete(cb); };
}

export type ProxyUnreachableOutcome =
  /** 这个地址跟当前代理配置无关 (多半是用户自己的本地服务) —— 什么都没做 */
  | 'not-proxy'
  /** 重探后系统已经没有这个代理了 (用户刚关掉) —— 已经切直连, 无需隔离 */
  | 'config-changed'
  /** 系统仍坚持这个端点, 但它是回环且没人监听 —— 已隔离, 暂时直连 */
  | 'quarantined'
  /** 远端代理拒连 —— 不替用户改路由, 只重探一次 */
  | 'kept';

export function reportProxyUnreachable(host: string, port: number): ProxyUnreachableOutcome {
  try {
    if (!configUses(cachedConfig, host, port)) return 'not-proxy';

    /* 先信系统: 用户多半就是刚把代理关了, 只是我们还没到下一个 watch tick */
    const after = doApply(true);
    if (!configUses(after.config, host, port)) {
      console.log(`[systemProxy] ${host}:${port} 连不上, 重探发现系统代理已变更 — 已切到最新配置`);
      return 'config-changed';
    }

    if (!isLoopbackHost(host)) {
      /* 远端代理拒连: 可能只是它忙/防火墙。静默改直连会把用户以为在代理里的流量漏出去,
       * 那比报错严重得多 —— 不动路由, 让错误照常报给用户。 */
      return 'kept';
    }

    quarantined.set(`${host}:${port}`, Date.now() + QUARANTINE_MS);
    doApply(true);
    console.warn(
      `[systemProxy] 本机代理 ${host}:${port} 没有程序在监听 (ECONNREFUSED), `
      + `而系统设置里它还开着 — 多半是代理客户端退出时没把开关关回去。`
      + ` 已暂时按直连处理 ${Math.round(QUARANTINE_MS / 60_000)} 分钟, 之后自动再试一次。`,
    );
    return 'quarantined';
  } catch {
    return 'kept';
  }
}

/**
 * 从错误文案里认出"代理连不上"并上报 —— 给拿不到结构化字段的调用方 (事件流里只有一句话)。
 * Node 的报文形如 `connect ECONNREFUSED 127.0.0.1:7897`。
 */
export function reportProxyUnreachableFromErrorText(text: string | undefined | null): ProxyUnreachableOutcome {
  if (!text) return 'not-proxy';
  const m = /ECONNREFUSED\s+(\[[0-9a-f:]+\]|[0-9a-z.\-]+):(\d{1,5})/i.exec(String(text));
  if (!m) return 'not-proxy';
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port <= 0) return 'not-proxy';
  return reportProxyUnreachable(m[1], port);
}

/** 诊断: 当前被隔离的代理端点 (host:port → 还剩多少毫秒) */
export function getProxyQuarantine(): Array<{ endpoint: string; remainingMs: number }> {
  const now = Date.now();
  return [...quarantined.entries()]
    .filter(([, until]) => until > now)
    .map(([endpoint, until]) => ({ endpoint, remainingMs: until - now }));
}

/** 供别的模块查探测结果. 未 apply 前返 null. */
export function getSystemProxyResult(): ApplyResult | null {
  return cachedResult;
}

/**
 * 诊断: 某个 URL 现在会怎么走 (直连 / 哪个代理).
 * 排查"我明明开了代理为什么没走"时, 这比读日志猜快得多.
 */
export async function explainProxyRoute(url: string): Promise<{ target: string; via: string }> {
  if (!installedDispatcher) return { target: new URL(url).host, via: 'direct' };
  return installedDispatcher.explain(url);
}

/** 仅测试用: 把模块状态与全局 dispatcher 还原到"没装过"的样子. */
export function __resetSystemProxyForTests(): void {
  stopSystemProxyWatch();
  changeListeners.clear();
  cachedConfig = null;
  cachedResult = null;
  installedDispatcher = null;
  quarantined.clear();
  setGlobalDispatcher(new Agent());
}

/** 当前全局 dispatcher 是不是我们装的 —— 诊断用 (别的库也可能覆写它). */
export function isSystemProxyDispatcherActive(): boolean {
  return !!installedDispatcher && getGlobalDispatcher() === (installedDispatcher as unknown as Dispatcher);
}
