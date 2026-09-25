/**
 * 系统代理 · 规范化配置类型
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 设计立场 (用户定调):
 *
 *   「用户开了代理就走代理, 不开就不走。用户配的路由规则, 能走通就能, 走不通就走不通,
 *     我们不应该关心这个事。」
 *
 * 所以这一层的职责只有一个: **把操作系统当前的代理配置原样读出来**, 不增不减 ——
 *   · 不替用户合成他没开的通道 (旧代码 `httpsProxy || httpProxy` 就是: 用户在系统设置里
 *     单独关掉了 HTTPS 代理, 我们照样把 HTTPS 推进代理, 这是替用户做路由决策)
 *   · 不忽略他开了的通道 (旧代码完全不读 SOCKS / PAC / Windows 系统设置 —— 只开 SOCKS
 *     的用户被我们判成"无代理"直连)
 *
 * 唯一的例外是回环地址, 见 bypass.ts 顶部说明。
 */

/** 代理通道类型. 'http' 覆盖 http:// 与 https:// 两种代理服务器 URL (都是 HTTP CONNECT 语义). */
export type ProxyKind = 'http' | 'https' | 'socks4' | 'socks5';

export interface ProxyEndpoint {
  kind: ProxyKind;
  host: string;
  port: number;
  /** 代理服务器自身的认证 (env 里 http://user:pass@host:port 形式带的) */
  username?: string;
  password?: string;
}

/**
 * 规范化后的系统代理配置 —— 逐 scheme 独立, 不互相兜底.
 *
 * `http` / `https` 为 null 表示 **用户没为这个 scheme 开代理**, 该 scheme 就该直连;
 * 只有 `socks` 是系统语义上的"全协议通道"(macOS SOCKS / env ALL_PROXY), 在对应 scheme
 * 没单独配代理时才作为该 scheme 的通道 —— 这不是我们发明的兜底, 是 SOCKS 本来的定义.
 */
export interface SystemProxyConfig {
  /** 配置来自哪 —— env (用户 shell export) 优先于系统设置, 跟 curl/git 的惯例一致 */
  source: 'env' | 'system' | 'none';
  /** http:// 请求走的代理 */
  http: ProxyEndpoint | null;
  /** https:// 请求走的代理 */
  https: ProxyEndpoint | null;
  /** 全协议 SOCKS 通道 (macOS SOCKSEnable / env ALL_PROXY) */
  socks: ProxyEndpoint | null;
  /** PAC 脚本地址 (macOS ProxyAutoConfigEnable / Windows AutoConfigURL). 有它时逐 URL 求解. */
  pacUrl: string | null;
  /** 系统例外表原文 (macOS ExceptionsList / Windows ProxyOverride / env NO_PROXY 拆项) */
  exceptions: string[];
  /** macOS ExcludeSimpleHostnames / Windows `<local>` —— 不含点的主机名直连 */
  excludeSimpleHostnames: boolean;
}

/**
 * 主进程转发系统代理到子进程时写入此指纹。worker 和子进程拿到的是 spawn 时的环境副本；
 * 探测看到匹配指纹时跳过这组副本，继续读取真正的系统设置。指纹不匹配时按用户明确设置
 * 处理，保持环境变量的最高优先级。
 */
export const PROXY_ENV_SYNTHETIC_MARKER = 'NEOX_PROXY_ENV_SYNTHETIC';

/** 指纹 = 我们写进去的那三个值原样拼接 (顺序固定) */
export function proxyEnvFingerprint(http: string, https: string, all: string): string {
  return `${http}|${https}|${all}`;
}

export function emptyProxyConfig(): SystemProxyConfig {
  return {
    source: 'none',
    http: null,
    https: null,
    socks: null,
    pacUrl: null,
    exceptions: [],
    excludeSimpleHostnames: false,
  };
}

/** 有没有任何一条通道 —— 全空就是"用户没开代理", 我们一个字节都不该改. */
export function hasAnyProxy(cfg: SystemProxyConfig): boolean {
  return !!(cfg.http || cfg.https || cfg.socks || cfg.pacUrl);
}

/** 端点 → URL 文本 (写回 env / 日志 / 传给 undici ProxyAgent 都用它) */
export function endpointToUrl(ep: ProxyEndpoint): string {
  const scheme = ep.kind === 'socks5' ? 'socks5' : ep.kind === 'socks4' ? 'socks4' : ep.kind;
  const auth = ep.username
    ? `${encodeURIComponent(ep.username)}:${encodeURIComponent(ep.password ?? '')}@`
    : '';
  const host = ep.host.includes(':') && !ep.host.startsWith('[') ? `[${ep.host}]` : ep.host;
  return `${scheme}://${auth}${host}:${ep.port}`;
}

/** 判两份配置是否等价 —— watch 里用它决定要不要重装 dispatcher. */
export function sameProxyConfig(a: SystemProxyConfig | null, b: SystemProxyConfig | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const ep = (x: ProxyEndpoint | null) => (x ? endpointToUrl(x) : '');
  return a.source === b.source
    && ep(a.http) === ep(b.http)
    && ep(a.https) === ep(b.https)
    && ep(a.socks) === ep(b.socks)
    && (a.pacUrl ?? '') === (b.pacUrl ?? '')
    && a.excludeSimpleHostnames === b.excludeSimpleHostnames
    && a.exceptions.join(',') === b.exceptions.join(',');
}

/**
 * 解析代理 URL 文本 (env 值 / PAC 返回 / 注册表值).
 * 容忍无 scheme 的裸 `host:port` (Windows 注册表 / 老 .zshrc 常见) —— 按 http 代理处理.
 * 解析不出来返回 null: **绝不猜**, 猜错等于把用户流量发到错误的地方.
 */
export function parseProxyUrl(raw: string | undefined | null, defaultKind: ProxyKind = 'http'): ProxyEndpoint | null {
  if (!raw) return null;
  const text = raw.trim();
  if (!text) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `${defaultKind}://${text}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  const scheme = u.protocol.replace(':', '').toLowerCase();
  let kind: ProxyKind;
  switch (scheme) {
    case 'http': kind = 'http'; break;
    case 'https': kind = 'https'; break;
    case 'socks5': case 'socks5h': case 'socks': kind = 'socks5'; break;
    case 'socks4': case 'socks4a': kind = 'socks4'; break;
    default: return null; /* 认不出的 scheme 一律当没配 —— 不猜 */
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host) return null;
  const port = u.port
    ? Number(u.port)
    : kind === 'https' ? 443
    : kind === 'http' ? 80
    : 1080;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const ep: ProxyEndpoint = { kind, host, port };
  if (u.username) {
    ep.username = decodeURIComponent(u.username);
    ep.password = decodeURIComponent(u.password || '');
  }
  return ep;
}
