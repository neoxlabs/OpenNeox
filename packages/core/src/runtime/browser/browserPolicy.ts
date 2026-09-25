/**
 * 站点级授权 —— 用户自己钉的网址名单。跟 computerPolicy 是同一套形状, 换成 origin。
 *
 *     "browserUse": {
 *       "policy": "open",                       // open(默认) | allowlist
 *       "allow": ["github.com", "*.google.com", "http://localhost:3000"],
 *       "deny":  ["mail.google.com", "*.bank.example"]
 *     }
 *
 * · open      —— 除了 deny 名单都能开 (默认)
 * · allowlist —— 只有 allow 名单里的能开
 * deny 永远优先于 allow —— 同时命中按"拒"算, 不按写的顺序算。
 *
 * ─── 怎么比 (每一条都是踩出来的, 别"简化") ────────────────────────────────────
 * ① 比的是 **origin 的 host**, 不是整条 URL 做包含匹配。
 *    `url.includes("github.com")` 会把 `evil.com/?x=github.com` 放进来 —— 这是
 *    这类名单最经典的绕过, 而且它"看起来能用"。
 * ② 子域要用 `*.` 显式声明。写 `google.com` 只匹配 google.com 本身;
 *    要连子域就写 `*.google.com` (它同时匹配 google.com 自己)。
 *    默认吃掉子域的话, 用户写 `example.com` 会连一个陌生人注册的
 *    `evil.example.com` 一起放行, 而他并不知道自己放行了。
 * ③ 端口只在名单条目写了端口时才比 —— 本地开发 `localhost:3000` 要能精确钉,
 *    但写 `github.com` 的人不该因为 `:443` 被拒。
 * ④ **about:blank / devtools 这类非 http(s) 一律不拦**: 它们不是站点, 拦了只会
 *    让浏览器在起步阶段就死掉 (新标签页就是 about:blank)。
 */

import { readFileSync } from 'node:fs';
import { neoxHome } from '@neoxlabs/kernel/platform/neoxHome.js';

export interface BrowserUsePolicy {
  policy: 'open' | 'allowlist';
  allow: string[];
  deny: string[];
}

const DEFAULT_POLICY: BrowserUsePolicy = { policy: 'open', allow: [], deny: [] };

const CACHE_MS = 3000;
let cache: { at: number; value: BrowserUsePolicy } | null = null;

/** 纯函数 —— 好测, 且不碰磁盘 */
export function parseBrowserUsePolicy(raw: unknown): BrowserUsePolicy {
  const cfg = (raw ?? {}) as { browserUse?: unknown };
  const bu = (cfg.browserUse ?? {}) as Record<string, unknown>;
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()) : [];
  return {
    policy: bu.policy === 'allowlist' ? 'allowlist' : 'open',
    allow: list(bu.allow),
    deny: list(bu.deny),
  };
}

export function readBrowserUsePolicy(): BrowserUsePolicy {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  let value = DEFAULT_POLICY;
  try {
    value = parseBrowserUsePolicy(JSON.parse(readFileSync(neoxHome('config.json'), 'utf8')));
  } catch {
    /* 配置读不了 / 不是 JSON —— 回默认的 open。这一层是用户偏好, 不是安全边界:
     * 一个 JSON 语法错就让浏览器整个停摆, 代价远大于收益。 */
  }
  cache = { at: Date.now(), value };
  return value;
}

/** 把用户写的一条名单项拆成 {host, port?, subdomains}。写错了返回 null (整条忽略)。 */
function parseEntry(raw: string): { host: string; port?: string; subdomains: boolean } | null {
  let s = raw.trim().toLowerCase();
  if (!s) return null;
  /* 允许用户直接粘一整条 URL —— 他手上有的往往就是 URL */
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split('/')[0];
  if (!s) return null;
  let subdomains = false;
  if (s.startsWith('*.')) { subdomains = true; s = s.slice(2); }
  /* IPv6 (`[::1]:3000`) 的冒号是地址的一部分, 不能当端口分隔符 */
  let port: string | undefined;
  if (!s.startsWith('[')) {
    const i = s.lastIndexOf(':');
    if (i > 0 && /^\d+$/.test(s.slice(i + 1))) { port = s.slice(i + 1); s = s.slice(0, i); }
  }
  return s ? { host: s, port, subdomains } : null;
}

function hit(list: string[], host: string, port: string): boolean {
  const h = host.toLowerCase();
  return list.some((raw) => {
    const e = parseEntry(raw);
    if (!e) return false;
    if (e.port && e.port !== port) return false;
    /* `*.google.com` 同时匹配 google.com 自己 —— 用户写它的意思是"这个站",
     * 而不是"这个站的子域但不包括它本身"。 */
    return e.subdomains ? (h === e.host || h.endsWith('.' + e.host)) : h === e.host;
  });
}

export interface BrowserPolicyDenial {
  code: 'site_denied_by_policy' | 'site_not_in_allowlist';
  message: string;
}

/**
 * 这个 URL 能开吗。
 *
 * @param url 目标网址。非 http(s) (about:blank / data: / devtools:) 一律放行 —— 见文件头 ④。
 */
export function checkBrowserUsePolicy(url: string | undefined, override?: BrowserUsePolicy): BrowserPolicyDenial | null {
  const raw = (url ?? '').trim();
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    /* 解不开的不在这层拦: 导航本身会失败并给出真正的原因, 在这里报"策略拒绝"是误诊。 */
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

  const p = override ?? readBrowserUsePolicy();
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');

  if (hit(p.deny, host, port)) {
    return {
      code: 'site_denied_by_policy',
      message: `Refused: the user's browser policy denies "${u.hostname}". `
        + 'This is a user setting (browserUse.deny in ~/.neox/config.json), not a bug — '
        + 'do something else, or tell the user which site you needed and why.',
    };
  }
  if (p.policy === 'allowlist' && !hit(p.allow, host, port)) {
    return {
      code: 'site_not_in_allowlist',
      message: `Refused: the browser is in allowlist mode and "${u.hostname}" is not on the list `
        + `(currently allowed: ${p.allow.length ? p.allow.join(', ') : 'nothing'}). `
        + 'Tell the user which site you needed — they can add it to browserUse.allow.',
    };
  }
  return null;
}

/** 测试用 —— 生产路径不该清缓存 */
export function __resetBrowserPolicyCache(): void {
  cache = null;
}

/** page.route 需要的最小面 —— 不 import playwright 的类型, 免得把它拖进这层。 */
interface RoutablePage {
  route(pattern: string, handler: (route: any, request: any) => unknown): Promise<void>;
  mainFrame(): unknown;
}

export async function enforceBrowserPolicyOnPage(page: RoutablePage): Promise<void> {
  const p = readBrowserUsePolicy();
  if (p.policy === 'open' && p.deny.length === 0) return;
  await page.route('**/*', (route: any, request: any) => {
    try {
      /* 只拦**主框架的导航**。子资源 (图片/接口/iframe) 不在这层管:
       * 一个站点的资源本来就散在 CDN 上, 按 origin 拦子资源等于把正常网页拦烂。 */
      if (!request.isNavigationRequest?.() || request.frame?.() !== page.mainFrame()) {
        void route.continue();
        return;
      }
      if (checkBrowserUsePolicy(request.url(), p)) {
        void route.abort('blockedbyclient');
        return;
      }
      void route.continue();
    } catch {
      /* 判不了就放行 —— 这一层是用户偏好。判定本身出错就把页面卡死, 比放行更糟。 */
      void route.continue();
    }
  });
}
