/**
 * 例外表匹配 —— 按操作系统语义判定某个 host 是否绕过代理
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 系统例外表支持的语法比 undici 的 `NO_PROXY` 更广，因此这里统一解析和匹配:
 *
 *     127.0.0.1/8            ← CIDR, 不认
 *     192.168.0.0/16         ← CIDR, 不认
 *     <local>                ← macOS/Windows 的"简单主机名"记号, 不认
 *     *.local                ← 通配前缀, undici 认 `.local` 不认 `*.local`
 *     http://holymastercard.com  ← 带 scheme, 不认
 *
 * 支持的条目形态 (Chrome / macOS / Windows 的并集):
 *   ·  *                      全部绕过
 *   ·  <local> / <-loopback>  简单主机名 (不含点) / 回环
 *   ·  example.com            该域名及其子域
 *   ·  .example.com           同上 (后缀写法)
 *   ·  *.example.com          同上 (通配写法)
 *   ·  example.com:8080       带端口 —— 仅该端口绕过
 *   ·  http://example.com     带 scheme —— 剥掉 scheme 后按上面规则匹配
 *   ·  10.0.0.0/8             IPv4 CIDR
 *   ·  fd00::/8               IPv6 CIDR
 *   ·  192.168.1.1            单个 IP
 *
 * ── 回环永远绕过 ────────────────────────────────────────────────────────
 * 127.0.0.1 / ::1 / localhost 不是"用户的路由决策", 那是我们**进程内部的 IPC 通道**
 * (CLI 本地 daemon 健康检查、renderer 本地 vite、worker 回环)必须直连；这条规则只作用于
 * 本机 IPC，不改变外部 host 的路由。
 */

/** 用户例外表之外, 我们无条件绕过的回环 host */
const ALWAYS_DIRECT_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (ALWAYS_DIRECT_HOSTS.has(h)) return true;
  if (h.endsWith('.localhost')) return true;   /* RFC 6761: *.localhost 保留给回环 */
  if (/^127\.\d+\.\d+\.\d+$/.test(h)) return true; /* 整个 127/8 都是回环 */
  return false;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out = (out << 8) | n;
  }
  return out >>> 0;
}

/** IPv6 → 16 字节. 支持 :: 压缩与内嵌 IPv4. 认不出返回 null. */
function ipv6ToBytes(input: string): Uint8Array | null {
  let ip = input.toLowerCase().replace(/^\[|\]$/g, '');
  if (ip.includes('%')) ip = ip.slice(0, ip.indexOf('%')); /* 去掉 zone id */
  if (!ip.includes(':')) return null;
  /* 内嵌 IPv4: ::ffff:1.2.3.4 */
  const v4m = ip.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  let tail: number[] = [];
  if (v4m) {
    const v4 = ipv4ToInt(v4m[1]);
    if (v4 === null) return null;
    tail = [(v4 >>> 24) & 0xff, (v4 >>> 16) & 0xff, (v4 >>> 8) & 0xff, v4 & 0xff];
    /* 砍掉末尾的 IPv4 段, 余下的是十六进制部分. "::ffff:1.2.3.4" → "::ffff:" → "::ffff";
     * "::1.2.3.4" → "::" (末尾是 "::" 时不能再削, 否则退化成单个 ':' 解析不了)。 */
    ip = ip.slice(0, ip.length - v4m[1].length);
    if (!ip.endsWith('::')) ip = ip.replace(/:$/, '');
    if (!ip) return null;
  }
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const parseGroups = (s: string): number[] | null => {
    if (!s) return [];
    const out: number[] = [];
    for (const g of s.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parseGroups(halves[0].replace(/:$/, ''));
  const rear = halves.length === 2 ? parseGroups(halves[1].replace(/^:/, '')) : null;
  if (head === null || (halves.length === 2 && rear === null)) return null;
  const headBytes: number[] = [];
  for (const g of head) headBytes.push((g >> 8) & 0xff, g & 0xff);
  const rearBytes: number[] = [];
  for (const g of rear ?? []) rearBytes.push((g >> 8) & 0xff, g & 0xff);
  const known = headBytes.length + rearBytes.length + tail.length;
  if (known > 16) return null;
  if (halves.length === 1 && known !== 16) return null;
  const bytes = new Uint8Array(16);
  bytes.set(headBytes, 0);
  const rearAll = [...rearBytes, ...tail];
  bytes.set(rearAll, 16 - rearAll.length);
  return bytes;
}

function inIpv4Cidr(host: string, network: string, prefix: number): boolean {
  const h = ipv4ToInt(host);
  const n = ipv4ToInt(network);
  if (h === null || n === null) return false;
  if (prefix <= 0) return true;
  if (prefix > 32) return false;
  const mask = prefix === 32 ? 0xffffffff : (~((1 << (32 - prefix)) - 1)) >>> 0;
  return (h & mask) === (n & mask);
}

function inIpv6Cidr(host: string, network: string, prefix: number): boolean {
  const h = ipv6ToBytes(host);
  const n = ipv6ToBytes(network);
  if (!h || !n) return false;
  if (prefix < 0 || prefix > 128) return false;
  const fullBytes = prefix >> 3;
  for (let i = 0; i < fullBytes; i++) if (h[i] !== n[i]) return false;
  const rest = prefix & 7;
  if (rest === 0) return true;
  const mask = (0xff << (8 - rest)) & 0xff;
  return (h[fullBytes] & mask) === (n[fullBytes] & mask);
}

/** 把一条例外表条目规范化: 剥 scheme / 剥路径 / 拆端口 / 去中括号 */
function normalizeEntry(raw: string): { pattern: string; port: number | null } | null {
  let s = raw.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); /* http:// https:// 前缀 */
  s = s.replace(/\/.*$/, (m) => (/^\/\d+$/.test(m) ? m : ''));  /* 去掉路径, 但保留 /24 这种 CIDR 前缀 */
  if (!s) return null;
  /* [::1]:8080 或 host:8080 —— IPv6 裸写法 (含多个冒号且无中括号) 不当端口解析 */
  let port: number | null = null;
  const bracket = s.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracket) {
    s = bracket[1];
    port = bracket[2] ? Number(bracket[2]) : null;
  } else {
    const colonCount = (s.match(/:/g) ?? []).length;
    const m = s.match(/^(.*):(\d+)$/);
    if (m && colonCount === 1) {
      s = m[1];
      port = Number(m[2]);
    }
  }
  if (!s) return null;
  return { pattern: s, port };
}

/**
 * host 是否命中这条例外.
 * @param host 已小写、已去中括号的主机名或 IP
 */
function entryMatches(entry: string, host: string, port: number): boolean {
  if (entry === '*') return true;
  if (entry === '<local>' || entry === '<-loopback>') {
    /* macOS/Windows 语义: 不含点的主机名 (以及回环) 直连 */
    return !host.includes('.') || isLoopbackHost(host);
  }
  const norm = normalizeEntry(entry);
  if (!norm) return false;
  if (norm.port !== null && norm.port !== port) return false;
  let pat = norm.pattern;

  /* CIDR */
  const cidr = pat.match(/^(.+)\/(\d{1,3})$/);
  if (cidr) {
    const [, net, bitsRaw] = cidr;
    const bits = Number(bitsRaw);
    return net.includes(':') ? inIpv6Cidr(host, net, bits) : inIpv4Cidr(host, net, bits);
  }

  /* 通配 / 后缀写法 */
  if (pat.startsWith('*')) pat = pat.slice(1);       /* *.foo.com → .foo.com */
  if (pat.startsWith('.')) {
    const suffix = pat;                               /* .foo.com */
    return host === suffix.slice(1) || host.endsWith(suffix);
  }
  /* 中间带 * 的通配 (少见, Windows 允许 e.g. 10.*.*.*) */
  if (pat.includes('*')) {
    const re = new RegExp(`^${pat.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    return re.test(host);
  }
  /* 精确 host 或其子域 (Chrome: `example.com` 也匹配 www.example.com) */
  return host === pat || host.endsWith(`.${pat}`);
}

export interface BypassInput {
  exceptions: string[];
  excludeSimpleHostnames: boolean;
}

/**
 * 该不该绕过代理直连.
 * @param host 请求目标主机 (可带中括号的 IPv6)
 * @param port 请求目标端口 (例外表里 host:port 形式要用)
 */
export function shouldBypassProxy(host: string, port: number, cfg: BypassInput): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  /* 见文件头: 回环是我们自己的 IPC 通道, 无条件直连 */
  if (isLoopbackHost(h)) return true;
  if (cfg.excludeSimpleHostnames && !h.includes('.') && !h.includes(':')) return true;
  for (const entry of cfg.exceptions) {
    if (entryMatches(entry, h, port)) return true;
  }
  return false;
}

/** 仅供测试 / 诊断用的内部导出 */
export const __internal = { normalizeEntry, entryMatches, ipv6ToBytes, inIpv4Cidr, inIpv6Cidr, isLoopbackHost };
