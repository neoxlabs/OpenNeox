/**
 * SystemProxyDispatcher —— 按系统配置逐请求选路的 undici dispatcher
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 为什么不能继续用 undici 的 EnvHttpProxyAgent:
 *   · 它只认 HTTP_PROXY/HTTPS_PROXY 环境变量, **不支持 SOCKS** —— 用户只在系统里开
 *     SOCKS (Clash 默认三件套之一) 时, 我们等于完全不走代理。
 *   · 它不支持 PAC。
 *   · 它的 NO_PROXY 匹配只有"后缀/精确 host", 用户例外表里的 CIDR、`<local>`、`*.x`、
 *     带 scheme 的条目全部静默失效 (见 bypass.ts)。
 *
 * 这里自己实现分发:
 *   请求 → 例外表判定 → 直连 / HTTP 代理 / SOCKS 隧道 / PAC 逐 URL 求解
 * 每种上游各持一个子 dispatcher 实例并缓存复用 (连接池不会因为分发而失效)。
 *
 * 关于 https 槽为 null 但 socks 有值: 走 socks。这不是我们的"兜底猜测" —— SOCKS 在
 * macOS/GNOME/WinINET 里的定义就是全协议通道。反过来, http 槽有、https 槽没有时,
 * https 请求**直连**: 用户在系统设置里单独关掉了 HTTPS 代理, 那就是他的决定。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Agent, ProxyAgent, buildConnector, Dispatcher } from 'undici';
/* socks 静态引入 —— 打包器要能看见它 (动态 import 在 esbuild bundle 里可能被留成
 * 外部引用, 打包版运行时才炸, 而那正是"只有用户机器上复现"的那类 bug)。 */
import { SocksClient } from 'socks';
import { shouldBypassProxy } from './bypass.js';
import { endpointToUrl, type ProxyEndpoint, type SystemProxyConfig } from './types.js';

/** PAC 脚本与求解结果的缓存时长 —— Chrome 也是拿到后长期复用, 变更靠系统配置 watch 兜。 */
const PAC_SCRIPT_TTL_MS = 5 * 60_000;
const PAC_RESULT_TTL_MS = 5 * 60_000;

type Decision = { kind: 'direct' } | { kind: 'proxy'; endpoint: ProxyEndpoint };

const DIRECT: Decision = { kind: 'direct' };

/**
 * SOCKS 隧道 connector —— 让 undici (Node 原生 fetch) 能走 SOCKS.
 * undici 自己没有 SOCKS 支持, 但 Agent 允许换掉建连函数: 我们用 socks 建好 TCP 隧道,
 * 再把 socket 交回 undici 的 TLS 层升级 (https 时), 其余 HTTP 语义完全不变。
 */
function socksConnector(ep: ProxyEndpoint): buildConnector.connector {
  const tlsUpgrade = buildConnector({});
  const type = ep.kind === 'socks4' ? 4 : 5;
  return (async (options: any, callback: any) => {
    try {
      const port = Number(options.port) || (options.protocol === 'https:' ? 443 : 80);
      const { socket } = await SocksClient.createConnection({
        proxy: {
          host: ep.host,
          port: ep.port,
          type: type as 4 | 5,
          ...(ep.username ? { userId: ep.username, password: ep.password ?? '' } : {}),
        },
        command: 'connect',
        destination: { host: String(options.hostname).replace(/^\[|\]$/g, ''), port },
        timeout: 30_000,
      });
      if (options.protocol === 'https:') {
        return tlsUpgrade({ ...options, httpSocket: socket }, callback);
      }
      socket.setNoDelay?.(true);
      callback(null, socket);
      return undefined;
    } catch (err) {
      callback(err as Error, null);
      return undefined;
    }
  }) as unknown as buildConnector.connector;
}

function createUpstream(ep: ProxyEndpoint): Dispatcher {
  if (ep.kind === 'socks4' || ep.kind === 'socks5') {
    return new Agent({ connect: socksConnector(ep) });
  }
  /* http/https 代理: undici 自带 CONNECT 实现. URL 里带的用户名密码会被它转成
   * Proxy-Authorization, 所以这里直接把完整 URL 交过去。 */
  return new ProxyAgent({ uri: endpointToUrl(ep) });
}

export class SystemProxyDispatcher extends Dispatcher {
  private readonly cfg: SystemProxyConfig;
  private readonly direct = new Agent();
  private readonly upstreams = new Map<string, Dispatcher>();
  /* PAC */
  private pacScript: { text: string; at: number } | null = null;
  private pacResolver: ((url: string, host: string) => Promise<string>) | null = null;
  private pacResults = new Map<string, { decision: Decision; at: number }>();
  private pacFailedLoggedAt = 0;

  constructor(cfg: SystemProxyConfig) {
    super();
    this.cfg = cfg;
  }

  private upstreamFor(ep: ProxyEndpoint): Dispatcher {
    const key = endpointToUrl(ep);
    let d = this.upstreams.get(key);
    if (!d) {
      d = createUpstream(ep);
      this.upstreams.set(key, d);
    }
    return d;
  }

  private dispatcherFor(decision: Decision): Dispatcher {
    return decision.kind === 'direct' ? this.direct : this.upstreamFor(decision.endpoint);
  }

  /** 静态 (非 PAC) 选路: 严格按 scheme, 不跨槽兜底; SOCKS 是全协议通道所以可作该 scheme 的通道。 */
  private staticDecision(isHttps: boolean): Decision {
    const scheme = isHttps ? this.cfg.https : this.cfg.http;
    if (scheme) return { kind: 'proxy', endpoint: scheme };
    if (this.cfg.socks) return { kind: 'proxy', endpoint: this.cfg.socks };
    return DIRECT;
  }

  /** PAC 返回串 → 决策. 形如 "PROXY 1.2.3.4:8080; SOCKS5 5.6.7.8:1080; DIRECT" */
  private parsePacResult(result: string): Decision {
    for (const rawPart of result.split(';')) {
      const part = rawPart.trim();
      if (!part) continue;
      const [tokenRaw, addr] = part.split(/\s+/, 2);
      const token = tokenRaw.toUpperCase();
      if (token === 'DIRECT') return DIRECT;
      if (!addr) continue;
      const kind = token === 'SOCKS5' ? 'socks5'
        : token === 'SOCKS4' || token === 'SOCKS' ? 'socks4'
        : token === 'HTTPS' ? 'https'
        : token === 'PROXY' || token === 'HTTP' ? 'http'
        : null;
      if (!kind) continue;
      const [host, portRaw] = addr.replace(/^\[|\]$/g, '').split(/:(?=\d+$)/);
      const port = Number(portRaw) || (kind === 'socks4' || kind === 'socks5' ? 1080 : 80);
      if (host) return { kind: 'proxy', endpoint: { kind, host, port } };
    }
    /* 脚本只返回了认不出的东西 —— 按 Chrome 的行为直连, 但这属于异常, 上层会记日志 */
    return DIRECT;
  }

  private async loadPacResolver(): Promise<((url: string, host: string) => Promise<string>) | null> {
    const url = this.cfg.pacUrl;
    if (!url) return null;
    const now = Date.now();
    if (this.pacResolver && this.pacScript && now - this.pacScript.at < PAC_SCRIPT_TTL_MS) {
      return this.pacResolver;
    }
    let text: string;
    if (url.startsWith('file://')) {
      text = readFileSync(fileURLToPath(url), 'utf8');
    } else {
      /* PAC 脚本自己必须直连拿 —— 用代理去拿 PAC 是循环依赖 */
      const res = await this.direct.request({ origin: new URL(url).origin, path: new URL(url).pathname + new URL(url).search, method: 'GET' });
      if (res.statusCode >= 400) throw new Error(`PAC 脚本 HTTP ${res.statusCode}`);
      text = await res.body.text();
    }
    const { compilePac } = await import('./pac.js');
    this.pacResolver = compilePac(text);
    this.pacScript = { text, at: now };
    return this.pacResolver;
  }

  private async pacDecision(target: URL): Promise<Decision> {
    const key = `${target.protocol}//${target.host}`;
    const now = Date.now();
    const hit = this.pacResults.get(key);
    if (hit && now - hit.at < PAC_RESULT_TTL_MS) return hit.decision;
    try {
      const resolver = await this.loadPacResolver();
      if (!resolver) return this.staticDecision(target.protocol === 'https:');
      const raw = await resolver(target.href, target.hostname);
      const decision = this.parsePacResult(String(raw ?? ''));
      this.pacResults.set(key, { decision, at: now });
      return decision;
    } catch (err) {
      /* PAC 拿不到/跑不通: Chrome 的行为是退到直连, 我们跟随 —— 但**必须喊出来**,
       * 否则又是"看起来配了代理、实际全直连"的隐形故障 (每分钟最多一条, 别刷屏)。 */
      if (now - this.pacFailedLoggedAt > 60_000) {
        this.pacFailedLoggedAt = now;
        console.error(`[systemProxy] PAC 求解失败 (${this.cfg.pacUrl}) — 本次按直连处理:`, (err as Error)?.message ?? err);
      }
      /* PAC 挂了但用户同时配了固定代理 (macOS 允许并存) 就用固定的, 否则直连 */
      return this.staticDecision(target.protocol === 'https:');
    }
  }

  /** 供诊断: 给定 URL 会怎么走. */
  async explain(rawUrl: string): Promise<{ target: string; via: string }> {
    const u = new URL(rawUrl);
    const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
    let d: Decision;
    if (shouldBypassProxy(u.hostname, port, this.cfg)) d = DIRECT;
    else if (this.cfg.pacUrl) d = await this.pacDecision(u);
    else d = this.staticDecision(u.protocol === 'https:');
    return { target: u.host, via: d.kind === 'direct' ? 'direct' : endpointToUrl(d.endpoint) };
  }

  dispatch(opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandlers): boolean {
    let target: URL;
    try {
      const origin = typeof opts.origin === 'string' ? opts.origin : opts.origin?.toString();
      target = new URL(origin ?? '');
    } catch {
      /* origin 认不出来 —— 交给直连 dispatcher 去报它自己的错, 别在这里吞 */
      return this.direct.dispatch(opts, handler);
    }
    const port = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);

    if (shouldBypassProxy(target.hostname, port, this.cfg)) {
      return this.direct.dispatch(opts, handler);
    }
    if (this.cfg.pacUrl) {
      /* PAC 求解是异步的, 而 dispatch 必须同步返回. 这里先应下来 (返回 true = 别再塞),
       * 求解完成后再转发给真正的上游 —— 请求在此期间只是排队, 不会漏出去。 */
      this.pacDecision(target)
        .then((decision) => { this.dispatcherFor(decision).dispatch(opts, handler); })
        .catch((err) => { handler.onError?.(err as Error); });
      return true;
    }
    return this.dispatcherFor(this.staticDecision(target.protocol === 'https:')).dispatch(opts, handler);
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.direct.close(), ...[...this.upstreams.values()].map((d) => d.close())]);
  }

  /* undici 的 destroy 有  / (err) / (cb) / (err, cb) 四种重载 —— 全部照搬, 否则
   * 把我们的 dispatcher 交给任何按 callback 形式调用的库都会炸。 */
  destroy(): Promise<void>;
  destroy(err: Error | null): Promise<void>;
  destroy(callback: () => void): void;
  destroy(err: Error | null, callback: () => void): void;
  destroy(errOrCallback?: (Error | null) | (() => void), maybeCallback?: () => void): Promise<void> | void {
    const err = typeof errOrCallback === 'function' ? null : (errOrCallback ?? null);
    const callback = typeof errOrCallback === 'function' ? errOrCallback : maybeCallback;
    const all = Promise.allSettled([
      this.direct.destroy(err),
      ...[...this.upstreams.values()].map((d) => d.destroy(err)),
    ]).then(() => undefined);
    if (callback) {
      void all.then(() => callback());
      return;
    }
    return all;
  }
}
