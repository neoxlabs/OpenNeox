import { ipcMain, net } from 'electron';
import type { ClientRequest, IncomingMessage } from 'electron';

export interface LinkPreview {
  ok: boolean;
  url: string;
  finalUrl?: string;
  title?: string;
  description?: string;
  image?: string;
  icon?: string;
  site?: string;
  error?: string;
}

const TTL_MS = 60 * 60 * 1000;
const CACHE_MAX = 500;
const cache = new Map<string, { at: number; value: LinkPreview }>();
const inflight = new Map<string, Promise<LinkPreview>>();

function toIPv4(host: string): number | null {
  const parts = host.split('.');
  if (parts.length === 0 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const raw of parts) {
    if (raw === '') return null;
    let n: number;
    if (/^0[xX][0-9a-fA-F]+$/.test(raw)) n = parseInt(raw.slice(2), 16);
    else if (/^0[0-7]+$/.test(raw)) n = parseInt(raw.slice(1), 8);
    else if (/^\d+$/.test(raw)) n = parseInt(raw, 10);
    else return null;
    if (!Number.isFinite(n) || n < 0) return null;
    nums.push(n);
  }
  /* a / a.b / a.b.c / a.b.c.d —— 最后一段吃掉剩下的所有字节 (inet_aton 的口径) */
  const last = nums[nums.length - 1]!;
  const headMax = 256;
  for (let i = 0; i < nums.length - 1; i++) if (nums[i]! >= headMax) return null;
  const remainingBytes = 4 - (nums.length - 1);
  if (last >= 2 ** (8 * remainingBytes)) return null;
  let value = 0;
  for (let i = 0; i < nums.length - 1; i++) value = (value << 8 >>> 0) + nums[i]!;
  value = value * 2 ** (8 * remainingBytes) + last;
  return value >>> 0;
}

/** 32 位整数落在保留 / 内网段里吗 */
function isPrivateIPv4(v: number): boolean {
  const a = (v >>> 24) & 0xff;
  const b = (v >>> 16) & 0xff;
  if (a === 0 || a === 10 || a === 127) return true;                 /* 本机 / 私网 A */
  if (a === 169 && b === 254) return true;                           /* 链路本地 — 云元数据 169.254.169.254 */
  if (a === 172 && b >= 16 && b <= 31) return true;                  /* 私网 B */
  if (a === 192 && b === 168) return true;                           /* 私网 C */
  if (a === 100 && b >= 64 && b <= 127) return true;                 /* CGNAT 100.64/10 */
  if (a === 198 && (b === 18 || b === 19)) return true;              /* 基准测试 198.18/15 */
  if (a === 192 && b === 0) return true;                             /* 192.0.0/24 + 192.0.2/24 (TEST-NET-1) */
  if (a >= 224) return true;                                         /* 组播 224/4 + 保留 240/4 */
  return false;
}

function isPrivateHost(host: string): boolean {
  let h = host.toLowerCase().trim();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);      /* IPv6 字面量的方括号 */
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;

  if (h.includes(':')) {
    /* IPv4-mapped / -compatible: ::ffff:127.0.0.1 这种要按里面那个 IPv4 判 */
    const mapped = /(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/.exec(h);
    if (mapped) {
      const v = toIPv4(mapped[1]!);
      if (v !== null && isPrivateIPv4(v)) return true;
    }
    if (h === '::' || h === '::1') return true;
    if (/^fe80:/i.test(h)) return true;                              /* 链路本地 */
    if (/^f[cd][0-9a-f]{2}:/i.test(h)) return true;                  /* 唯一本地 fc00::/7 */
    return false;
  }

  const v = toIPv4(h);
  if (v === null) return false;                                      /* 普通域名 —— 放行 (DNS 重绑定不在这层解决) */
  return isPrivateIPv4(v);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&ndash;/g, '–').replace(/&mdash;/g, '—').replace(/&hellip;/g, '…')
    .replace(/&middot;/g, '·').replace(/&laquo;/g, '«').replace(/&raquo;/g, '»').replace(/&copy;/g, '©')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/\s+/g, ' ').trim();
}

/** <meta property|name="key" content="…"> 两种属性顺序都认 */
function metaOf(html: string, key: string): string | undefined {
  const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']*)["']`, 'i');
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${key}["']`, 'i');
  const m = re1.exec(html) ?? re2.exec(html);
  return m?.[1] ? decodeEntities(m[1]) : undefined;
}

function iconOf(html: string): string | undefined {
  const re = /<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*href=["']([^"']+)["']/i;
  const re2 = /<link[^>]+href=["']([^"']+)["'][^>]*rel=["'][^"']*icon[^"']*["']/i;
  return (re.exec(html) ?? re2.exec(html))?.[1];
}

function absolute(base: string, ref?: string): string | undefined {
  if (!ref) return undefined;
  try {
    const u = new URL(ref, base);
    return /^https?:$/.test(u.protocol) ? u.toString() : undefined;
  } catch { return undefined; }
}

export function parseLinkPreview(url: string, html: string, finalUrl = url): LinkPreview {
  const head = html.slice(0, 256 * 1024);
  const title = metaOf(head, 'og:title') ?? metaOf(head, 'twitter:title')
    ?? (/<title[^>]*>([^<]*)<\/title>/i.exec(head)?.[1] ? decodeEntities(/<title[^>]*>([^<]*)<\/title>/i.exec(head)![1]) : undefined);
  const description = metaOf(head, 'og:description') ?? metaOf(head, 'twitter:description') ?? metaOf(head, 'description');
  const image = absolute(finalUrl, metaOf(head, 'og:image') ?? metaOf(head, 'og:image:url') ?? metaOf(head, 'twitter:image'));
  const icon = absolute(finalUrl, iconOf(head)) ?? absolute(finalUrl, '/favicon.ico');
  const site = metaOf(head, 'og:site_name');
  return { ok: true, url, finalUrl, title, description, image, icon, site };
}

/** 一次抓取的结果 —— 只暴露 preview 需要的那几样 */
interface SafeFetchResult {
  status: number;
  contentType: string;
  body: string;
  finalUrl: string;
}

const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 256 * 1024;

function followSafely(startUrl: string, timeoutMs: number): Promise<SafeFetchResult> {
  return new Promise((resolve, reject) => {
    let hops = 0;
    let settled = false;
    const req: ClientRequest = net.request({ url: startUrl, method: 'GET', redirect: 'manual' });
    let finalUrl = startUrl;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { req.abort(); } catch { /* ignore */ }
      reject(Object.assign(new Error('timeout'), { name: 'AbortError' }));
    }, timeoutMs);

    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    req.setHeader('User-Agent',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36');
    req.setHeader('Accept', 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5');
    req.setHeader('Accept-Language', 'zh-CN,zh;q=0.9,en;q=0.8');

    req.on('redirect', (_status: number, _method: string, redirectUrl: string) => {
      if (settled) return;
      if (++hops > MAX_REDIRECTS) {
        done(() => { try { req.abort(); } catch { /* ignore */ } reject(new Error('too many redirects')); });
        return;
      }
      let next: URL;
      try { next = new URL(redirectUrl); } catch {
        done(() => { try { req.abort(); } catch { /* ignore */ } reject(new Error('bad redirect url')); });
        return;
      }
      if (!/^https?:$/.test(next.protocol) || isPrivateHost(next.hostname)) {
        done(() => { try { req.abort(); } catch { /* ignore */ } reject(new Error('redirect to private host')); });
        return;
      }
      finalUrl = next.toString();
      req.followRedirect();
    });

    req.on('response', (res: IncomingMessage) => {
      const headers = res.headers as Record<string, string | string[]>;
      const rawCt = headers['content-type'];
      const contentType = Array.isArray(rawCt) ? (rawCt[0] ?? '') : (rawCt ?? '');
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on('data', (c: Buffer) => {
        if (settled) return;
        bytes += c.length;
        /* 只读前 256KB —— meta 全在 <head>, 不需要整页 (也别让一个大文件把内存吃了) */
        if (bytes <= MAX_BODY_BYTES) chunks.push(c);
        else { done(() => resolve({ status: res.statusCode, contentType, body: Buffer.concat(chunks).toString('utf-8'), finalUrl })); try { req.abort(); } catch { /* ignore */ } }
      });
      res.on('end', () => {
        done(() => resolve({ status: res.statusCode, contentType, body: Buffer.concat(chunks).toString('utf-8'), finalUrl }));
      });
      res.on('error', (e: Error) => done(() => reject(e)));
    });

    req.on('error', (e: Error) => done(() => reject(e)));
    req.end();
  });
}

async function fetchPreview(url: string): Promise<LinkPreview> {
  let u: URL;
  try { u = new URL(url); } catch { return { ok: false, url, error: 'bad url' }; }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, url, error: 'unsupported scheme' };
  if (isPrivateHost(u.hostname)) return { ok: false, url, error: 'private host' };
  try {
    const res = await followSafely(u.toString(), 6000);
    const ct = res.contentType;
    if (res.status < 200 || res.status >= 300) return { ok: false, url, error: `http ${res.status}` };
    if (!/text\/html|application\/xhtml/i.test(ct)) {
      /* 直链图片: 自己就是预览图 */
      if (/^image\//i.test(ct)) return { ok: true, url, finalUrl: res.finalUrl || url, image: res.finalUrl || url };
      return { ok: false, url, error: `not html (${ct.split(';')[0]})` };
    }
    return parseLinkPreview(url, res.body, res.finalUrl || url);
  } catch (err) {
    return { ok: false, url, error: (err as Error)?.name === 'AbortError' ? 'timeout' : String((err as Error)?.message ?? err) };
  }
}

export async function getLinkPreview(url: string): Promise<LinkPreview> {
  const key = String(url ?? '').trim();
  if (!key) return { ok: false, url: key, error: 'empty' };
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const running = inflight.get(key);
  if (running) return running;
  const p = fetchPreview(key).then((v) => {
    if (cache.size >= CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { at: Date.now(), value: v });
    inflight.delete(key);
    return v;
  });
  inflight.set(key, p);
  return p;
}

export function registerLinkPreviewIpcHandlers(): void {
  ipcMain.handle('link:preview', async (_event, url: string) => getLinkPreview(url));
}

/* 仅供测试 —— 内网判定是这个文件里唯一的安全边界, 必须能单独跑用例。
 * (整个模块 import electron, 但 isPrivateHost 本身不碰它。) */
export const __ssrfTestSurface = { isPrivateHost, toIPv4, isPrivateIPv4 };
