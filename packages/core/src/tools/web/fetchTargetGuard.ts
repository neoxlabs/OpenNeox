
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { readFileSync } from 'node:fs';
import { neoxHome } from '@neoxlabs/kernel/platform/neoxHome.js';

/** 主机名本身就说明是内网的那几个 */
const INTERNAL_SUFFIXES = ['.local', '.internal', '.localdomain', '.home.arpa'];
const INTERNAL_NAMES = new Set(['localhost', 'metadata.google.internal', 'instance-data']);

/** IPv4 点分/整数/十六进制都归一成 32 位数; 不是 IPv4 返回 null。 */
function toIPv4Number(host: string): number | null {
  if (isIP(host) === 4) {
    const parts = host.split('.').map(Number);
    return ((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!;
  }
  return null;
}

function isPrivateIPv4(n: number): boolean {
  const a = (n >>> 24) & 0xff, b = (n >>> 16) & 0xff;
  if (a === 0) return true;                        // 0.0.0.0/8 —— 有些栈上等于本机
  if (a === 10) return true;                       // 10/8
  if (a === 127) return true;                      // 环回
  if (a === 169 && b === 254) return true;         // link-local, 含 169.254.169.254 云元数据
  if (a === 172 && b >= 16 && b <= 31) return true;// 172.16/12
  if (a === 192 && b === 168) return true;         // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a >= 224) return true;                       // 组播 + 保留
  return false;
}

function isPrivateIPv6(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === '::1' || h === '::') return true;
  /* IPv4 映射地址 ::ffff:127.0.0.1 —— 按里面那个 v4 判 */
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (mapped) {
    const n = toIPv4Number(mapped[1]!);
    return n !== null && isPrivateIPv4(n);
  }
  if (h.startsWith('fe80')) return true;           // link-local
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;   // 唯一本地地址 fc00::/7
  return false;
}

/** 这个地址 (字面 IP 或已解析出的 IP) 是内网吗 */
export function isPrivateAddress(host: string): boolean {
  const v4 = toIPv4Number(host);
  if (v4 !== null) return isPrivateIPv4(v4);
  if (isIP(host) === 6) return isPrivateIPv6(host);
  return false;
}

/** 主机名字面上就该拦的 (不用解析) */
export function isInternalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (INTERNAL_NAMES.has(h)) return true;
  return INTERNAL_SUFFIXES.some((s) => h.endsWith(s));
}

let cache: { at: number; allow: boolean } | null = null;
const CACHE_MS = 3000;

/** 用户显式放开了内网吗 (~/.neox/config.json → webFetch.allowPrivateNetwork) */
export function allowsPrivateNetwork(): boolean {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.allow;
  let allow = false;
  try {
    const cfg = JSON.parse(readFileSync(neoxHome('config.json'), 'utf8')) as { webFetch?: { allowPrivateNetwork?: unknown } };
    allow = cfg?.webFetch?.allowPrivateNetwork === true;
  } catch {
    /* 读不到 = 没开。这一条**必须 fail-closed** —— 它是安全边界, 不是用户偏好。 */
  }
  cache = { at: Date.now(), allow };
  return allow;
}

export interface FetchTargetDenial {
  code: 'private_network_blocked';
  message: string;
}

function denial(where: string, why: string): FetchTargetDenial {
  return {
    code: 'private_network_blocked',
    message: `拒绝访问 ${where}: ${why}。web_fetch 默认不打内网/本机地址 —— `
      + '这类地址不需要凭据就能读到云元数据、内网后台和本地管理端口, 而 URL 可能来自你读过的网页或仓库。'
      + ' 如果你就是想看本机起的服务, 让用户在 ~/.neox/config.json 里加 '
      + '`"webFetch": { "allowPrivateNetwork": true }`。',
  };
}

export interface FetchTargetOptions {
  viaProxy?: boolean;
}

/**
 * 校验一个待请求的 URL。放行返回 null。
 *
 * @param resolveDns 解析域名 (测试可注入)。默认走系统解析, 拿**全部**地址 ——
 *   只看第一个的话, 一个域名解析出 [1.2.3.4, 127.0.0.1] 就能绕过去。
 */
export async function checkFetchTarget(
  url: URL,
  resolveDns: (host: string) => Promise<string[]> = defaultResolve,
  opts: FetchTargetOptions = {},
): Promise<FetchTargetDenial | null> {
  if (allowsPrivateNetwork()) return null;
  const host = url.hostname.replace(/^\[|\]$/g, '');

  if (isInternalHostname(host)) return denial(url.href, `"${host}" 是本机/内网名字`);
  if (isPrivateAddress(host)) return denial(url.href, `${host} 属于内网或环回地址段`);

  /* 走代理 → 本机解析结果不代表目标, 到此为止 (见 FetchTargetOptions.viaProxy) */
  if (opts.viaProxy) return null;

  /* 字面上看不出来的域名: 解析完再判。解析失败**放行** —— 那是 DNS 的事,
   * 请求本来也会失败, 在这里报"内网"是误诊。 */
  let addrs: string[];
  try {
    addrs = await resolveDns(host);
  } catch {
    return null;
  }
  const bad = addrs.find((a) => isPrivateAddress(a));
  if (bad) return denial(url.href, `"${host}" 解析到 ${bad}, 属于内网或环回地址段`);
  return null;
}

async function defaultResolve(host: string): Promise<string[]> {
  const res = await lookup(host, { all: true });
  return res.map((r) => r.address);
}

/** 测试用 */
export function __resetFetchGuardCache(): void {
  cache = null;
}
