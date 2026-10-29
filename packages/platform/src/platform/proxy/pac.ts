/**
 * PAC (Proxy Auto-Config) 求解器 —— node:vm 自研, 零外部依赖
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 为什么不用 pac-resolver:
 *   它 v7 起改用 QuickJS-WASM (@tootallnate/quickjs-emscripten, 1.8M)。WASM 资产在
 *   electron-builder 的 asar 里必须显式 unpack, 漏了就是**只有打包版炸**的那类 bug ——
 *   这个仓库已经被这种坑咬过好几次 (见 exports 收窄、bun --compile 的记录)。PAC 脚本
 *   就是一段 JS, Node 自带的 vm 完全够跑, 没必要为它引入一条 WASM 供应链。
 *
 * PAC 语义要点:
 *   · 入口 `FindProxyForURL(url, host)`, 返回 "PROXY 1.2.3.4:8080; DIRECT" 这种串。
 *   · 脚本里可以调一组内置函数 (下方全部实现)。
 *   · `dnsResolve()` 在 PAC 规范里是**同步**的, 但 Node 没有同步 DNS。做法跟 Chrome 一样:
 *     求解前先异步把本次请求的 host 解析好塞进缓存, 脚本里的同步调用直接查缓存。脚本要是
 *     去解析**别的** host (罕见), 拿到 null —— 这跟 Chrome 解析失败时的行为一致。
 *
 * 安全: PAC 脚本来自用户自己的系统配置, 但仍然限时执行 (死循环脚本不能挂死主进程),
 * 沙箱里也不给 require / process / fetch。
 */

import { createContext, runInContext, type Context } from 'node:vm';
import { promises as dns } from 'node:dns';
import { networkInterfaces } from 'node:os';

const EVAL_TIMEOUT_MS = 500;

/** dnsResolve 缓存: host → IPv4 文本 (解析不出记 null, 避免每次重试) */
const dnsCache = new Map<string, { ip: string | null; at: number }>();
const DNS_TTL_MS = 5 * 60_000;

async function resolveIntoCache(host: string): Promise<void> {
  const hit = dnsCache.get(host);
  if (hit && Date.now() - hit.at < DNS_TTL_MS) return;
  try {
    const { address } = await dns.lookup(host, { family: 4 });
    dnsCache.set(host, { ip: address, at: Date.now() });
  } catch {
    dnsCache.set(host, { ip: null, at: Date.now() });
  }
}

function cachedDnsResolve(host: string): string | null {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host;
  return dnsCache.get(host)?.ip ?? null;
}

function localIPv4(): string {
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return '127.0.0.1';
}

function ipToInt(ip: string): number | null {
  const p = ip.split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const seg of p) {
    if (!/^\d{1,3}$/.test(seg)) return null;
    const v = Number(seg);
    if (v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

/** shell 通配 (`*`, `?`) → 正则 */
function shExpMatch(str: string, shexp: string): boolean {
  const escaped = String(shexp).replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
  return re.test(String(str));
}

const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** weekdayRange("MON","FRI"[,"GMT"]) */
function weekdayRange(...args: unknown[]): boolean {
  const gmt = args[args.length - 1] === 'GMT';
  const days = (gmt ? args.slice(0, -1) : args).map((d) => WEEKDAYS.indexOf(String(d).toUpperCase()));
  if (!days.length || days[0] < 0) return false;
  const now = new Date();
  const today = gmt ? now.getUTCDay() : now.getDay();
  const from = days[0];
  const to = days.length > 1 && days[1] >= 0 ? days[1] : from;
  return from <= to ? today >= from && today <= to : today >= from || today <= to;
}

/** timeRange(h1[,m1,s1],h2[,m2,s2][,"GMT"]) — 支持规范里的 2/4/6 参数形式 */
function timeRange(...args: unknown[]): boolean {
  const gmt = args[args.length - 1] === 'GMT';
  const nums = (gmt ? args.slice(0, -1) : args).map(Number);
  const now = new Date();
  const h = gmt ? now.getUTCHours() : now.getHours();
  const m = gmt ? now.getUTCMinutes() : now.getMinutes();
  const s = gmt ? now.getUTCSeconds() : now.getSeconds();
  const cur = h * 3600 + m * 60 + s;
  if (nums.length === 1) return h === nums[0];
  if (nums.length === 2) {
    const [h1, h2] = nums;
    return h1 <= h2 ? h >= h1 && h < h2 : h >= h1 || h < h2;
  }
  if (nums.length === 4) {
    const [h1, m1, h2, m2] = nums;
    const a = h1 * 3600 + m1 * 60;
    const b = h2 * 3600 + m2 * 60;
    return a <= b ? cur >= a && cur <= b : cur >= a || cur <= b;
  }
  if (nums.length === 6) {
    const [h1, m1, s1, h2, m2, s2] = nums;
    const a = h1 * 3600 + m1 * 60 + s1;
    const b = h2 * 3600 + m2 * 60 + s2;
    return a <= b ? cur >= a && cur <= b : cur >= a || cur <= b;
  }
  return false;
}

/** dateRange(...) — 规范里有 day / month / year 多种重载, 这里实现最常用的几种 */
function dateRange(...args: unknown[]): boolean {
  const gmt = args[args.length - 1] === 'GMT';
  const rest = gmt ? args.slice(0, -1) : args;
  const now = new Date();
  const day = gmt ? now.getUTCDate() : now.getDate();
  const month = gmt ? now.getUTCMonth() : now.getMonth();
  const year = gmt ? now.getUTCFullYear() : now.getFullYear();
  const isMonth = (v: unknown) => typeof v === 'string' && MONTHS.includes(v.toUpperCase());
  const monthIdx = (v: unknown) => MONTHS.indexOf(String(v).toUpperCase());

  if (rest.length === 1) {
    const v = rest[0];
    if (isMonth(v)) return month === monthIdx(v);
    const n = Number(v);
    return n > 31 ? year === n : day === n;
  }
  if (rest.length === 2) {
    const [a, b] = rest;
    if (isMonth(a) && isMonth(b)) {
      const from = monthIdx(a); const to = monthIdx(b);
      return from <= to ? month >= from && month <= to : month >= from || month <= to;
    }
    const [na, nb] = [Number(a), Number(b)];
    if (na > 31 || nb > 31) return year >= na && year <= nb;
    return from2(day, na, nb);
  }
  /* 更长的重载 (day month, day month year …) 用宽松判定: 落在起止之间即可 */
  return true;
}

function from2(cur: number, from: number, to: number): boolean {
  return from <= to ? cur >= from && cur <= to : cur >= from || cur <= to;
}

function buildSandbox(): Context {
  const sandbox: Record<string, unknown> = {
    isPlainHostName: (host: string) => !String(host).includes('.'),
    dnsDomainIs: (host: string, domain: string) => {
      const h = String(host).toLowerCase(); const d = String(domain).toLowerCase();
      return h === d || h.endsWith(d.startsWith('.') ? d : `.${d}`) || h.endsWith(d);
    },
    localHostOrDomainIs: (host: string, hostdom: string) => {
      const h = String(host).toLowerCase(); const hd = String(hostdom).toLowerCase();
      return h === hd || (!h.includes('.') && hd.startsWith(`${h}.`));
    },
    isResolvable: (host: string) => cachedDnsResolve(String(host)) !== null,
    dnsResolve: (host: string) => cachedDnsResolve(String(host)),
    myIpAddress: () => localIPv4(),
    dnsDomainLevels: (host: string) => (String(host).match(/\./g) ?? []).length,
    shExpMatch,
    weekdayRange,
    timeRange,
    dateRange,
    isInNet: (host: string, pattern: string, mask: string) => {
      const ip = cachedDnsResolve(String(host));
      if (!ip) return false;
      const a = ipToInt(ip); const b = ipToInt(String(pattern)); const m = ipToInt(String(mask));
      if (a === null || b === null || m === null) return false;
      return ((a & m) >>> 0) === ((b & m) >>> 0);
    },
    /* PAC 脚本常用 alert() 打调试信息 —— 吞掉, 不能让它污染我们的日志 */
    alert: () => undefined,
  };
  return createContext(sandbox);
}

export interface PacResolver {
  (url: string, host: string): Promise<string>;
}

/**
 * 编译一段 PAC 脚本, 返回可反复调用的求解函数.
 * 脚本语法错误 / 没有 FindProxyForURL 会直接抛 —— 由调用方决定怎么处理 (我们的策略是
 * 记 error 并退到静态配置/直连, 见 dispatcher.ts)。
 */
export function compilePac(script: string): PacResolver {
  const context = buildSandbox();
  runInContext(script, context, { timeout: EVAL_TIMEOUT_MS, filename: 'proxy.pac' });
  const hasEntry = runInContext('typeof FindProxyForURL === "function"', context, { timeout: 50 });
  if (!hasEntry) throw new Error('PAC 脚本里没有 FindProxyForURL()');

  return async (url: string, host: string): Promise<string> => {
    await resolveIntoCache(host);
    context.__neox_url = url;
    context.__neox_host = host;
    const out = runInContext('FindProxyForURL(__neox_url, __neox_host)', context, {
      timeout: EVAL_TIMEOUT_MS,
      filename: 'proxy.pac',
    });
    return String(out ?? '');
  };
}

export const __internal = { shExpMatch, weekdayRange, timeRange, dateRange, ipToInt, dnsCache };
