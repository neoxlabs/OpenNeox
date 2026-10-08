import dns from 'node:dns';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

export type EdgeDef = {
  id: string;
  /* 直连这个 IP (Node 用); 不填 = 正常解析 */
  ip?: string;
  /* 原主机名 → 专用入口主机名 (Bun 用) */
  alias?: Record<string, string>;
};

/* 内置只有默认线路; 其它线路来自服务端清单 (GET /api/v1/edges, 测速前拉, 写进缓存),
 * 或由宿主在 installEdgeRouting({ seed }) 时带入。 */
export const DEFAULT_EDGES: EdgeDef[] = [{ id: 'cf' }];

const PROBE_HOST = 'gateway.neox-dev.com';
const PROBE_PATH = '/health';
const PROBE_TIMEOUT_MS = 5_000;
const PROBE_SAMPLES = 3;
const CACHE_TTL_MS = 6 * 3_600_000;
const WATCH_EVERY_MS = 2 * 60_000;
const FAILS_BEFORE_REPROBE = 2;

export type EdgeSample = { ok: number; medianMs: number | null };
export type EdgeDecision = { edge: string; decidedAt: number; samples?: Record<string, EdgeSample>; edges?: EdgeDef[] };

type State = {
  installed: boolean;
  forced: string | null;
  active: string;
  edges: EdgeDef[];
  cacheFile: string;
  fails: number;
  probing: Promise<void> | null;
  origLookup: typeof dns.lookup;
  origFetch: typeof fetch | null;
  timer: ReturnType<typeof setInterval> | null;
};

const G = globalThis as unknown as { __neoxEdgeRoute?: State };

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';

function state(): State {
  if (!G.__neoxEdgeRoute) {
    G.__neoxEdgeRoute = {
      installed: false,
      forced: null,
      active: 'cf',
      edges: DEFAULT_EDGES,
      cacheFile: path.join(os.homedir(), NEOX_HOME_DIRNAME, 'edge-route.json'),
      fails: 0,
      probing: null,
      origLookup: dns.lookup,
      origFetch: typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null,
      timer: null,
    };
  }
  return G.__neoxEdgeRoute;
}

function edgeOf(id: string): EdgeDef | undefined {
  return state().edges.find(e => e.id === id);
}

/** 当前线路 (cf / hk ...) —— 给日志 / 诊断看。 */
export function activeEdge(): string {
  return state().active;
}

/* ── 决策 (纯函数, 有单测) ─────────────────────────────────────────────── */

/**
 * 只在别的线路明显更好时才离开默认线路 (cf): 成功次数更多, 或者一样多但默认线路中位耗时慢一半以上
 * (+150ms 防抖)。全都不通 → 保持现状。
 */
export function chooseEdge(samples: Record<string, EdgeSample>, current: string): string {
  const cf = samples.cf;
  let best = 'cf';
  for (const [id, s] of Object.entries(samples)) {
    if (id === 'cf' || !cf) continue;
    const better = s.ok > cf.ok
      || (s.ok === cf.ok && s.ok > 0 && s.medianMs != null && cf.medianMs != null && cf.medianMs > s.medianMs * 1.5 + 150);
    if (better && (best === 'cf' || (s.medianMs ?? Infinity) < (samples[best].medianMs ?? Infinity))) best = id;
  }
  const anyOk = Object.values(samples).some(s => s.ok > 0);
  return anyOk ? best : current;
}

/* ── 测速 ─────────────────────────────────────────────────────────────── */

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/* 测一次: 新建连接 (不复用), 含 TLS 握手 —— 掉包的网络恰恰卡在建连这一步 */
async function probeOnce(edge: EdgeDef): Promise<number | null> {
  const st = state();
  const t0 = Date.now();
  if (isBun) {
    const host = edge.alias?.[PROBE_HOST] ?? PROBE_HOST;
    if (!st.origFetch) return null;
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
      const r = await st.origFetch(`https://${host}${PROBE_PATH}`, { signal: ctl.signal, keepalive: false });
      clearTimeout(timer);
      return r.ok ? Date.now() - t0 : null;
    } catch {
      return null;
    }
  }
  return new Promise(resolve => {
    const lookup = ((host: string, opts: unknown, cb: (...a: unknown[]) => void) => {
      if (edge.ip) {
        const all = typeof opts === 'object' && opts !== null && (opts as { all?: boolean }).all;
        return all ? cb(null, [{ address: edge.ip, family: 4 }]) : cb(null, edge.ip, 4);
      }
      return (st.origLookup as unknown as (...a: unknown[]) => void).call(dns, host, opts, cb);
    }) as unknown as typeof dns.lookup;
    const req = https.request({
      host: PROBE_HOST, servername: PROBE_HOST, path: PROBE_PATH, method: 'GET',
      agent: false, lookup, timeout: PROBE_TIMEOUT_MS, headers: { 'user-agent': 'neox-edge-probe' },
    }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode === 200 ? Date.now() - t0 : null));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}

async function probeEdge(edge: EdgeDef, n = PROBE_SAMPLES): Promise<EdgeSample> {
  const ms: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = await probeOnce(edge);
    if (r != null) ms.push(r);
  }
  return { ok: ms.length, medianMs: median(ms) };
}

/** 线路清单是否可用: 必须含 cf, 每条要么没有 ip/alias, 要么两个都有且 alias 只指向 neox-dev.com 子域。 */
export function validEdgeList(list: unknown): list is EdgeDef[] {
  if (!Array.isArray(list) || list.length === 0 || list.length > 8) return false;
  if (!list.some(e => e?.id === 'cf')) return false;
  return list.every(e => {
    if (!e || typeof e.id !== 'string' || !/^[a-z0-9-]{1,16}$/.test(e.id)) return false;
    if (e.ip == null && e.alias == null) return true;
    if (typeof e.ip !== 'string' || !/^\d{1,3}(\.\d{1,3}){3}$/.test(e.ip)) return false;
    if (!e.alias || typeof e.alias !== 'object') return false;
    return Object.entries(e.alias).every(([from, to]) =>
      /^([a-z0-9-]+\.)?neox-dev\.com$/.test(from) && typeof to === 'string' && /^([a-z0-9-]+\.)?neox-dev\.com$/.test(to));
  });
}

async function refreshEdgeList(): Promise<void> {
  const st = state();
  try {
    let body: unknown;
    if (isBun) {
      if (!st.origFetch) return;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
      const r = await fetch('https://neox-dev.com/api/v1/edges', { signal: ctl.signal }); /* 经当前线路 */
      clearTimeout(timer);
      if (!r.ok) return;
      body = await r.json();
    } else {
      body = await new Promise((resolve, reject) => {
        const req = https.get('https://neox-dev.com/api/v1/edges', { timeout: PROBE_TIMEOUT_MS }, res => {
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', c => { raw += c; if (raw.length > 64_000) req.destroy(); });
          res.on('end', () => { try { resolve(res.statusCode === 200 ? JSON.parse(raw) : null); } catch (e) { reject(e); } });
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
      });
    }
    const list = (body as { edges?: unknown } | null)?.edges;
    if (validEdgeList(list)) st.edges = list;
  } catch { /* 用现有清单 */ }
}

/** 全部线路各测 3 次 (线路之间并行), 选线并写缓存。 */
export async function probeAllEdges(): Promise<EdgeDecision> {
  const st = state();
  await refreshEdgeList();
  const entries = await Promise.all(st.edges.map(async e => [e.id, await probeEdge(e)] as const));
  const samples = Object.fromEntries(entries);
  const edge = st.forced ?? chooseEdge(samples, st.active);
  const decision: EdgeDecision = { edge, decidedAt: Date.now(), samples, edges: st.edges };
  setActive(edge);
  writeCache(decision);
  return decision;
}

function reprobe(): Promise<void> {
  const st = state();
  if (!st.probing) {
    st.probing = probeAllEdges().then(() => undefined, () => undefined).finally(() => { st.probing = null; });
  }
  return st.probing;
}

/* 每 2 分钟看一眼当前线路; 连着两次不通 → 整体重测。缓存被别的进程更新过就直接采用。 */
async function watchdog(): Promise<void> {
  const st = state();
  const cached = readCache();
  if (cached && cached.edge !== st.active && Date.now() - cached.decidedAt < WATCH_EVERY_MS * 2) {
    setActive(cached.edge);
  }
  const cur = edgeOf(st.active);
  if (!cur) return;
  const ok = (await probeOnce(cur)) != null;
  st.fails = ok ? 0 : st.fails + 1;
  if (st.fails >= FAILS_BEFORE_REPROBE) {
    st.fails = 0;
    await reprobe();
  }
}

/* ── 缓存 ─────────────────────────────────────────────────────────────── */

function readCache(): EdgeDecision | null {
  try {
    const d = JSON.parse(fs.readFileSync(state().cacheFile, 'utf8')) as EdgeDecision;
    if (d && validEdgeList(d.edges)) state().edges = d.edges;
    return d && typeof d.edge === 'string' && typeof d.decidedAt === 'number' && edgeOf(d.edge) ? d : null;
  } catch {
    return null;
  }
}

function writeCache(d: EdgeDecision): void {
  try {
    const f = state().cacheFile;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(d));
    fs.renameSync(tmp, f);
  } catch { /* 缓存写不了只是下次多测一遍 */ }
}

export function readCachedEdge(): EdgeDef | null {
  const d = readCache();
  if (!d || Date.now() - d.decidedAt > CACHE_TTL_MS * 4) return null;
  return edgeOf(d.edge) ?? null;
}

/** Chromium 的 host-resolver-rules 值 ("MAP host ip, ..."); 当前不需要改解析时返回 null。 */
export function hostResolverRulesFor(edge: EdgeDef | null): string | null {
  if (!edge?.ip || !edge.alias) return null;
  return Object.keys(edge.alias).map(h => `MAP ${h} ${edge.ip}`).join(', ');
}

/* ── 接管网络 ─────────────────────────────────────────────────────────── */

function setActive(id: string): void {
  if (edgeOf(id)) state().active = id;
}

function patchDnsLookup(): void {
  const st = state();
  const orig = st.origLookup;
  const patched = function (this: unknown, hostname: string, options: unknown, callback?: unknown) {
    const cb = (typeof options === 'function' ? options : callback) as (...a: unknown[]) => void;
    const opts = typeof options === 'function' ? {} : options;
    const edge = edgeOf(st.active);
    const family = typeof opts === 'number' ? opts : (opts as { family?: number } | undefined)?.family;
    if (edge?.ip && edge.alias && hostname in edge.alias && family !== 6) {
      const all = typeof opts === 'object' && opts !== null && (opts as { all?: boolean }).all;
      process.nextTick(() => (all ? cb(null, [{ address: edge.ip, family: 4 }]) : cb(null, edge.ip, 4)));
      return {} as never;
    }
    return (orig as unknown as (...a: unknown[]) => unknown).call(dns, hostname, options, callback);
  };
  (dns as unknown as { lookup: unknown }).lookup = patched;
  const origP = dns.promises.lookup.bind(dns.promises);
  (dns.promises as unknown as { lookup: unknown }).lookup = (hostname: string, options?: unknown) => {
    const edge = edgeOf(st.active);
    const family = typeof options === 'number' ? options : (options as { family?: number } | undefined)?.family;
    if (edge?.ip && edge.alias && hostname in edge.alias && family !== 6) {
      const all = typeof options === 'object' && options !== null && (options as { all?: boolean }).all;
      return Promise.resolve(all ? [{ address: edge.ip, family: 4 }] : { address: edge.ip, family: 4 });
    }
    return origP(hostname, options as never);
  };
}

/** Bun: 把 URL 主机名换成线路专用入口。 */
export function mapUrlForEdge(url: string, edge: EdgeDef | undefined): string {
  if (!edge?.alias) return url;
  try {
    const u = new URL(url);
    const to = edge.alias[u.hostname];
    if (!to) return url;
    u.hostname = to;
    return u.toString();
  } catch {
    return url;
  }
}

/* Bun 的 node:https 也不走 dns.lookup, 而模型请求走 axios → https.request —— 一样换主机名。
 * 改的是模块对象上的方法: axios 等调用时才取 `https.request`, 改了就生效。 */
function wrapHttpsRequest(): void {
  const st = state();
  const mod = https as unknown as { request: (...a: unknown[]) => unknown; get: (...a: unknown[]) => unknown };
  const origRequest = mod.request;
  const mapArgs = (args: unknown[]): unknown[] => {
    const edge = edgeOf(st.active);
    if (!edge?.alias) return args;
    const [a, ...rest] = args;
    if (typeof a === 'string' || a instanceof URL) return [mapUrlForEdge(String(a), edge), ...rest];
    if (a && typeof a === 'object') {
      const o = a as { hostname?: string; host?: string };
      const from = o.hostname ?? o.host;
      const to = from ? edge.alias[from] : undefined;
      if (to) return [{ ...o, ...(o.hostname ? { hostname: to } : { host: to }), servername: to }, ...rest];
    }
    return args;
  };
  mod.request = function (this: unknown, ...args: unknown[]) {
    return origRequest.apply(this, mapArgs(args));
  };
  mod.get = function (this: unknown, ...args: unknown[]) {
    const req = origRequest.apply(this, mapArgs(args)) as { end: () => void };
    req.end();
    return req;
  };
}

function wrapFetchAndWebSocket(): void {
  const st = state();
  wrapHttpsRequest();
  const origFetch = st.origFetch;
  if (origFetch) {
    globalThis.fetch = Object.assign((input: string | URL | Request, init?: RequestInit) => {
      const edge = edgeOf(st.active);
      if (!edge?.alias) return origFetch(input, init);
      if (typeof input === 'string' || input instanceof URL) return origFetch(mapUrlForEdge(String(input), edge), init);
      const mapped = mapUrlForEdge(input.url, edge);
      return origFetch(mapped === input.url ? input : new Request(mapped, input), init);
    }, origFetch) as typeof fetch;
  }
  const OrigWS = (globalThis as { WebSocket?: new (...a: unknown[]) => unknown }).WebSocket;
  if (OrigWS) {
    const Wrapped = class extends (OrigWS as new (...a: unknown[]) => object) {
      constructor(url: string | URL, ...rest: unknown[]) {
        super(mapUrlForEdge(String(url), edgeOf(st.active)), ...rest);
      }
    };
    (globalThis as { WebSocket?: unknown }).WebSocket = Wrapped;
  }
}

/**
 * 每个 JS 环境 (主进程 / 子进程 / worker 线程) 调一次, 重复调用无副作用。
 * probe=false 时只读缓存、不主动测 (给短命进程用)。seed = 宿主自带的线路清单 (缓存 / 服务端清单会覆盖它)。
 */
export function installEdgeRouting(opts: { probe?: boolean; seed?: EdgeDef[] } = {}): void {
  const st = state();
  if (st.installed) return;
  if (opts.seed && validEdgeList(opts.seed)) st.edges = opts.seed;
  const env = String(process.env.NEOX_EDGE ?? '').trim().toLowerCase();
  if (env === 'off') return;
  /* 单测 / 集成测试里起 worker 时不去外网测速, 也不改解析 */
  if (process.env.VITEST || process.env.NODE_ENV === 'test') return;
  st.installed = true;

  const cached = readCache(); /* 顺带把缓存里的线路清单装上, 下面认强制线路要用 */
  if (env && edgeOf(env)) st.forced = env;
  if (st.forced) setActive(st.forced);
  else if (cached && Date.now() - cached.decidedAt < CACHE_TTL_MS * 4) setActive(cached.edge);

  if (isBun) wrapFetchAndWebSocket();
  else patchDnsLookup();

  if (opts.probe === false || st.forced) return;
  if (!cached || Date.now() - cached.decidedAt > CACHE_TTL_MS) void reprobe();
  st.timer = setInterval(() => { void watchdog(); }, WATCH_EVERY_MS);
  (st.timer as { unref?: () => void }).unref?.();
}
