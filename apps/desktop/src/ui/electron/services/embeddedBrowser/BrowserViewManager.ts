/**
 * BrowserViewManager — Neox 内嵌浏览器的 OS 层管理者.
 *
 * 设计要点 (见 内部设计文档 §2-3):
 *   · 每个 surface (kind=web) ↔ 一个 Electron BrowserView 实例
 *   · BrowserView 嵌入到 surface tab body, 通过 setBounds 对齐 renderer 的占位 div
 *   · Agent browser_* 工具通过主进程注入的 host controller 控制这些 BrowserView,
 *     只允许访问已注册 surfaceId; 不依赖 Electron 全局 remote-debugging-port
 *   · 切 tab / surface 关闭 → BrowserView removeBrowserView + destroy
 *
 * 跟 <webview> 标签比:
 *   - <webview> 是 guest webContents, OS 层管理和调试桥更绕. 否决.
 *   - BrowserView 是独立 webContents, 主进程可以直接 capture / executeJavaScript / debugger.sendCommand.
 *     选这个.
 *
 * 跟独立 Chromium 子进程比 (C 方案):
 *   - 独立 Chromium = 真的两个窗口, 视觉嵌入感差 ("感觉很奇怪"). 否决.
 *   - BrowserView 是 OS native view in 主窗口 contentView, 完美嵌入. 选这个.
 *
 * BrowserView 的代价: 是 OS 级 native view, DOM overlay 永远盖不住. 我们用 SuppressBrowserView
 * (renderer 端 hook + 主进程 suppressAll/restoreAll) + 平滑 fade (capture snapshot + opacity 渐变)
 * 来处理 — overlay 弹出时假装 BrowserView 淡出.
 */

import { lazyElectron } from '../../lazyElectron.js';
import type { BrowserView as ElectronBrowserView, BrowserWindow as ElectronBrowserWindow, Rectangle } from 'electron';

/* 内嵌浏览器只在 Electron 宿主下才可能用到 —— 极简版走的是外置 Chrome 那一路,
 * 这个类的方法一次都不会被调到。但顶层静态 import 会让**整个 bundle** 在纯 Node
 * 后端里加载失败, 连累同包所有 handler (见 lazyElectron.ts)。改成运行时取:
 * 极简版真调到会拿到一句明确的错, 而不是整包起不来。 */
/* 断言回 electron 的真实类型 —— 否则 Proxy 的 any 会把所有回调参数变成隐式 any。 */
const BrowserView = lazyElectron<typeof import('electron').BrowserView>('BrowserView');
const BrowserWindow = lazyElectron<typeof import('electron').BrowserWindow>('BrowserWindow');
import { createHash } from 'node:crypto';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { loadConfig } from '@neoxlabs/platform/utils/config.js';

function isZhUi(): boolean {
  try { return (loadConfig().language || 'zh') === 'zh'; } catch { return true; }
}

export interface MountOptions {
  surfaceId: string;
  workspaceWindowId: number;   /* renderer 所在的 BrowserWindow.id */
  bounds: Rectangle;
  initialUrl?: string;
  /** workspace 绝对路径 — 用来派生 partition 名, 每个 workspace 一个独立 Chromium 数据分区,
   *  cookies / localStorage / IndexedDB 自动持久化到 Electron 的 Partitions 目录, 跨 Neox 重启保留登录态.
   *  不传时 (无 workspace context) 走 in-memory 临时分区, 关 Neox 数据全没. */
  workspacePath?: string;
}

/** 把字符串安全 inline 到 HTML — 防 cert error 信息里的 < > & 之类破坏警告页结构.
 *  警告页本身就是为了 "host 不受信" 场景, 必须假设 host / url 可能是攻击者构造. */
function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Chrome 风格 "你的连接不是私密连接" 警告页. data: URL inline, 不依赖任何资源/网络.
 *
 *   按钮 "继续访问" 走 location.href = 'neox://trust-cert?host=...&url=...',
 *   BrowserViewManager 的 will-navigate handler 拦这个 scheme → 按警告现场的证书指纹
 *   记 (host → fingerprint) 信任 → 重新 loadURL 原 URL → 第二次 certificate-error
 *   命中同 host 同指纹直接放行 (换证书则重新警告).
 *
 *   "返回上一页" 走 history.back(); 如果没历史 (直接打开就报错) 给 about:blank 兜底.
 */
function buildCertWarningHtml(targetUrl: string, host: string, errorCode: string): string {
  const safeHost = htmlEscape(host);
  const safeUrl = htmlEscape(targetUrl);
  const safeErr = htmlEscape(errorCode);
  const trustHref = `neox://trust-cert?host=${encodeURIComponent(host)}&url=${encodeURIComponent(targetUrl)}`;
  const safeTrustHref = htmlEscape(trustHref);
  const zh = isZhUi();
  return `<!DOCTYPE html>
<html lang="${zh ? 'zh-CN' : 'en'}">
<head>
  <meta charset="utf-8">
  <title>${zh ? '连接不是私密连接' : 'Your connection is not private'} — ${safeHost}</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
      font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      background: #f5f6f8; color: #1f2328;
      padding: 24px;
    }
    @media (prefers-color-scheme: dark) {
      body { background: #16171a; color: #e6e8eb; }
      .card { background: #1f2125; border-color: #2a2d32; }
      .meta { background: #16181c; border-color: #2a2d32; color: #9aa0a6; }
      .btn { background: #2a2d32; color: #e6e8eb; border-color: #3a3d42; }
      .btn:hover { background: #34373d; }
      .btn-danger { color: #f87171; }
    }
    .card {
      max-width: 600px; width: 100%; padding: 36px 40px;
      background: #fff; border: 1px solid #e3e6ea; border-radius: 12px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.06);
    }
    .icon { font-size: 44px; line-height: 1; margin-bottom: 14px; }
    h1 { font-size: 22px; font-weight: 600; margin: 0 0 12px; }
    p { margin: 0 0 12px; }
    .meta {
      margin: 16px 0; padding: 10px 14px; background: #f7f8fa; border: 1px solid #e3e6ea;
      border-radius: 6px; font-family: ui-monospace, "JetBrains Mono", "SF Mono", Menlo, monospace;
      font-size: 12px; color: #57606a; word-break: break-all;
    }
    .actions { display: flex; gap: 10px; margin-top: 24px; flex-wrap: wrap; }
    .btn {
      padding: 8px 16px; border: 1px solid #d0d7de; background: #f6f8fa; color: #1f2328;
      border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500;
      text-decoration: none; display: inline-block;
    }
    .btn:hover { background: #eef0f2; }
    .btn-danger { color: #cf222e; }
    .hint { font-size: 12px; color: #6e7781; margin-top: 18px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">⚠️</div>
    <h1>${zh ? '你的连接不是私密连接' : 'Your connection is not private'}</h1>
    <p>${zh
      ? `攻击者可能正在尝试从 <strong>${safeHost}</strong> 窃取你的信息（例如密码、消息或信用卡信息）。`
      : `Attackers might be trying to steal your information from <strong>${safeHost}</strong> (for example, passwords, messages, or credit cards).`}</p>
    <div class="meta">
      <div>${zh ? '站点' : 'Site'}: ${safeUrl}</div>
      <div>${zh ? '错误' : 'Error'}: ${safeErr}</div>
    </div>
    <p class="hint">${zh
      ? '如果这是你自己的本地 dev server（Vite / Next 等），证书是自签的，可以选择继续访问。如果你不认识这个站点，请返回。'
      : 'If this is your own local dev server (Vite / Next, etc.), the certificate is self-signed and it is safe to continue. If you do not recognise this site, go back.'}</p>
    <div class="actions">
      <a href="javascript:history.length>1?history.back():location.href='about:blank'" class="btn">${zh ? '返回安全位置' : 'Back to safety'}</a>
      <a href="${safeTrustHref}" class="btn btn-danger">${zh ? `继续访问 ${safeHost}（不安全）` : `Continue to ${safeHost} (unsafe)`}</a>
    </div>
  </div>
</body>
</html>`;
}

function buildCertWarningDataUrl(targetUrl: string, host: string, errorCode: string): string {
  const html = buildCertWarningHtml(targetUrl, host, errorCode);
  /* data: URL 用 base64 比 percent-encode 更短, 也不怕 # ? 这类保留字符. */
  const b64 = Buffer.from(html, 'utf8').toString('base64');
  return `data:text/html;charset=utf-8;base64,${b64}`;
}

/** Chromium net error code → 人话. 不在表里返 errorDesc 原文 (英文 net::ERR_XXX 也凑合看). */
function describeNetError(errorCode: number, errorDesc: string): { title: string; body: string } {
  const zh = isZhUi();
  switch (errorCode) {
    case -102: return zh
      ? { title: '服务器拒绝了连接', body: '目标端口可能没启动, 或服务还没监听这个端口.' }
      : { title: 'Connection refused', body: 'The port may not be up yet, or nothing is listening on it.' };
    case -105: return zh
      ? { title: '找不到该域名', body: 'DNS 解析失败 — 检查域名拼写, 或网络是否能访问 DNS.' }
      : { title: 'Site can’t be found', body: 'DNS lookup failed — check the spelling, or whether your network can reach DNS.' };
    case -106: return zh
      ? { title: '网络已断开', body: '检查 WiFi / 网线是否连接.' }
      : { title: 'No internet connection', body: 'Check your Wi-Fi or Ethernet connection.' };
    case -109: return zh
      ? { title: '无法连接到该地址', body: '路由不可达 — 检查 IP 是否在你的网络内.' }
      : { title: 'Address unreachable', body: 'No route to host — check whether the IP is on your network.' };
    case -118: return zh
      ? { title: '连接超时', body: '服务器在合理时间内没响应. 可能是防火墙或服务太慢.' }
      : { title: 'Connection timed out', body: 'The server did not respond in time. A firewall may be blocking it, or the service is slow.' };
    case -7: return zh
      ? { title: '请求超时', body: '操作超时. 试试重新加载.' }
      : { title: 'Request timed out', body: 'The operation timed out. Try reloading.' };
    case -101: return zh
      ? { title: '连接被重置', body: '服务器中断了连接 (RST). 可能服务崩了或重启中.' }
      : { title: 'Connection reset', body: 'The server dropped the connection (RST). It may have crashed or be restarting.' };
    case -100: return zh
      ? { title: '连接已关闭', body: '服务器关闭了连接 (FIN). 可能服务已停止.' }
      : { title: 'Connection closed', body: 'The server closed the connection (FIN). The service may have stopped.' };
    case -104: return zh
      ? { title: '连接失败', body: '底层 socket 失败. 检查目标是否可达.' }
      : { title: 'Connection failed', body: 'The underlying socket failed. Check that the target is reachable.' };
    case -2: return zh
      ? { title: '加载失败', body: errorDesc || '未知错误.' }
      : { title: 'Failed to load', body: errorDesc || 'Unknown error.' };
    default: return zh
      ? { title: '无法访问此网站', body: errorDesc || `net error ${errorCode}` }
      : { title: 'This site can’t be reached', body: errorDesc || `net error ${errorCode}` };
  }
}

/** Chrome 风格 "无法访问此网站" 错误页. 复用 cert 警告页的样式框架, 改文案 + 按钮.
 *  "重新加载" → location = 原 URL; "返回" → history.back fallback about:blank.
 *  data: URL inline 自包含, 不依赖网络. */
function buildNetworkErrorHtml(targetUrl: string, errorCode: number, errorDesc: string): string {
  let host = '';
  try { host = new URL(targetUrl).host; } catch { /* ignore */ }
  const { title, body } = describeNetError(errorCode, errorDesc);
  const safeUrl = htmlEscape(targetUrl);
  const safeHost = htmlEscape(host || targetUrl);
  const safeTitle = htmlEscape(title);
  const safeBody = htmlEscape(body);
  const safeErr = htmlEscape(`${errorDesc} (${errorCode})`);
  const safeReload = htmlEscape(targetUrl);
  const zh = isZhUi();
  return `<!DOCTYPE html>
<html lang="${zh ? 'zh-CN' : 'en'}">
<head>
  <meta charset="utf-8">
  <title>${safeTitle} — ${safeHost}</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
      font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      background: #f5f6f8; color: #1f2328;
      padding: 24px;
    }
    @media (prefers-color-scheme: dark) {
      body { background: #16171a; color: #e6e8eb; }
      .card { background: #1f2125; border-color: #2a2d32; }
      .meta { background: #16181c; border-color: #2a2d32; color: #9aa0a6; }
      .btn { background: #2a2d32; color: #e6e8eb; border-color: #3a3d42; }
      .btn:hover { background: #34373d; }
      .btn-primary { background: #4f8cff; border-color: #4f8cff; color: #fff; }
      .btn-primary:hover { background: #3a7bff; }
    }
    .card {
      max-width: 600px; width: 100%; padding: 36px 40px;
      background: #fff; border: 1px solid #e3e6ea; border-radius: 12px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.06);
    }
    .icon { font-size: 56px; line-height: 1; margin-bottom: 14px; opacity: 0.55; }
    h1 { font-size: 22px; font-weight: 600; margin: 0 0 12px; }
    p { margin: 0 0 12px; }
    .meta {
      margin: 16px 0; padding: 10px 14px; background: #f7f8fa; border: 1px solid #e3e6ea;
      border-radius: 6px; font-family: ui-monospace, "JetBrains Mono", "SF Mono", Menlo, monospace;
      font-size: 12px; color: #57606a; word-break: break-all;
    }
    .actions { display: flex; gap: 10px; margin-top: 24px; flex-wrap: wrap; }
    .btn {
      padding: 8px 16px; border: 1px solid #d0d7de; background: #f6f8fa; color: #1f2328;
      border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500;
      text-decoration: none; display: inline-block;
    }
    .btn:hover { background: #eef0f2; }
    .btn-primary {
      background: #4f8cff; border-color: #4f8cff; color: #fff;
    }
    .btn-primary:hover { background: #3a7bff; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">📡</div>
    <h1>${safeTitle}</h1>
    <p>${safeBody}</p>
    <div class="meta">
      <div>${zh ? '站点' : 'Site'}: ${safeUrl}</div>
      <div>${zh ? '错误' : 'Error'}: ${safeErr}</div>
    </div>
    <div class="actions">
      <a href="${safeReload}" class="btn btn-primary">${zh ? '重新加载' : 'Reload'}</a>
      <a href="javascript:history.length>1?history.back():location.href='about:blank'" class="btn">${zh ? '返回' : 'Back'}</a>
    </div>
  </div>
</body>
</html>`;
}

function buildNetworkErrorDataUrl(targetUrl: string, errorCode: number, errorDesc: string): string {
  const html = buildNetworkErrorHtml(targetUrl, errorCode, errorDesc);
  const b64 = Buffer.from(html, 'utf8').toString('base64');
  return `data:text/html;charset=utf-8;base64,${b64}`;
}

/** workspace path → 稳定 partition name. 取 hash 前 16 位 (足够无碰撞), 加 'persist:' 前缀
 *  Electron 自动持久化数据到 ~/Library/Application Support/<app>/Partitions/persist-nbx-<hash>/. */
function partitionForWorkspace(workspacePath: string | undefined): string {
  if (!workspacePath || !workspacePath.trim()) return ''; /* 空 partition = 默认 (内存) */
  const hash = createHash('sha1').update(workspacePath).digest('hex').slice(0, 16);
  return `persist:nbx-${hash}`;
}

function normalizeBrowserNavigationUrl(input: string): string {
  let target = String(input ?? '').trim();
  if (!target || target.length > 4096) {
    throw new Error('invalid url');
  }
  if (target === 'about:blank') return target;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(target)) {
    target = 'https://' + target;
  }
  const parsed = new URL(target);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`browser navigation protocol not allowed: ${parsed.protocol}`);
  }
  return parsed.toString();
}

function toolError(err: unknown): { ok: false; error: string } {
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

/* ════════════════════════════════════════════════════════════════════════
 * Host-side console / network 采集 + mock —
 *   全走 webContents 事件 + webContents.debugger (per-target CDP session),
 *   不依赖 Electron 全局 remote-debugging-port. 打包版端口关死后这是唯一通道.
 *   shape 对齐 neox-core browserCapture / browserMocks, agent 两条路径拿到
 *   一致的数据结构.
 * ════════════════════════════════════════════════════════════════════════ */

interface HostConsoleLog {
  timestamp: number;
  level: 'log' | 'info' | 'warn' | 'error' | 'debug' | 'trace';
  text: string;
  location?: string;
}

interface HostNetworkLog {
  /** CDP requestId — browser_get_response_body 引用 */
  id: string;
  timestamp: number;
  url: string;
  method: string;
  resourceType: string;
  status?: number;
  statusText?: string;
  mime?: string;
  responseAt?: number;
  durationMs?: number;
  failedReason?: string;
}

interface HostMockEntry {
  pattern: string;
  method: string;             /* 'GET' / 'POST' / '*' */
  status: number;
  body?: string;
  contentType?: string;
  headers?: Record<string, string>;
}

interface HostCapture {
  console: HostConsoleLog[];
  network: HostNetworkLog[];
  /** requestId → entry; ring buffer 挤出时同步删, 防 Map 无界涨 */
  networkById: Map<string, HostNetworkLog>;
}

/* ring buffer 上限 — 跟 neox-core browserCapture 一致 */
const HOST_MAX_CONSOLE = 200;
const HOST_MAX_NETWORK = 200;

/** Playwright 风格 glob → RegExp ('**' 任意含 /, '*' 单段, '?' 单字符). 全 URL 匹配. */
function mockGlobToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const re = escaped
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp('^' + re + '$');
}

function mockKeyOf(method: string, pattern: string): string {
  return `${method.toUpperCase()}|${pattern}`;
}

function domLocatorScript(locator: Record<string, any>, body: string): string {
  const payload = JSON.stringify(locator ?? {});
  return `
(() => {
  const opts = ${payload};
  const isVisible = (el) => {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
  };
  const textOf = (el) => (el?.innerText || el?.textContent || '').trim();
  const nameOf = (el) => (
    el?.getAttribute?.('aria-label')
    || el?.getAttribute?.('title')
    || el?.getAttribute?.('alt')
    || textOf(el)
    || el?.value
    || ''
  ).trim();
  const implicitRole = (el) => {
    const tag = (el?.tagName || '').toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      return 'textbox';
    }
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    return '';
  };
  const matchesRole = (el, role, name) => {
    const actualRole = el.getAttribute?.('role') || implicitRole(el);
    if (actualRole !== role) return false;
    if (name === undefined || name === null || name === '') return true;
    return nameOf(el).includes(String(name));
  };
  const find = () => {
    if (opts.selector) return document.querySelector(opts.selector);
    const all = Array.from(document.querySelectorAll('body *'));
    if (opts.role) return all.find((el) => matchesRole(el, opts.role, opts.name) && isVisible(el)) || null;
    if (opts.text) return all.find((el) => textOf(el).includes(String(opts.text)) && isVisible(el)) || null;
    return document.body;
  };
  const el = find();
  ${body}
})()
`;
}

function domTreeScript(maxDepth: number, pruneGeneric: boolean): string {
  return `
(() => {
  const maxDepth = ${JSON.stringify(maxDepth)};
  const pruneGeneric = ${JSON.stringify(pruneGeneric)};
  const roleOf = (el) => {
    const explicit = el.getAttribute?.('role');
    if (explicit) return explicit;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'body') return 'WebArea';
    if (tag === 'main') return 'main';
    if (tag === 'nav') return 'navigation';
    if (tag === 'form') return 'form';
    if (tag === 'button') return 'button';
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'img') return 'img';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      return 'textbox';
    }
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    return 'generic';
  };
  const nameOf = (el) => (
    el.getAttribute?.('aria-label')
    || el.getAttribute?.('title')
    || el.getAttribute?.('alt')
    || (el.innerText || el.textContent || '').trim()
    || el.value
    || ''
  ).trim().slice(0, 180);
  const visible = (el) => {
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
  };
  const walk = (el, depth) => {
    if (!el || depth > maxDepth || !visible(el)) return null;
    const role = roleOf(el);
    const name = nameOf(el);
    const childNodes = Array.from(el.children || []).map((child) => walk(child, depth + 1)).filter(Boolean);
    if (pruneGeneric && role === 'generic' && !name && childNodes.length === 0) return null;
    if (pruneGeneric && role === 'generic' && !name && childNodes.length === 1) return childNodes[0];
    const out = { role };
    if (name && role !== 'WebArea') out.name = name;
    if (childNodes.length) out.children = childNodes.slice(0, 80);
    return out;
  };
  return walk(document.body || document.documentElement, 0) || { role: 'WebArea' };
})()
`;
}

export interface BrowserViewEntry {
  surfaceId: string;
  view: ElectronBrowserView;
  workspaceWindowId: number;
  /** 内置 BrowserView 调试通道是否已 attach (仅主进程 webContents.debugger, 非全局 CDP 端口). */
  debuggerAttached: boolean;
  /** tab 不在前台 — 视觉应该隐藏 (bounds 推到 off-screen). */
  hidden: boolean;
  /** 全局 overlay (下拉菜单 / 弹窗) 正在显示 — 必须暂时 hide 让 DOM 能盖住 native view.
   *  跟 hidden 是 OR 关系: 任一为 true → off-screen. */
  suppressed: boolean;
  /** 最近一次 renderer ResizeObserver 推过来的"真实可见"坐标. unhide / unsuppress 时还原用. */
  lastRealBounds?: Rectangle;
  /** 等待显示的 cert 警告 — cert-error 时设, did-fail-load 时消费一次 load 警告页. */
  pendingCertError?: { url: string; host: string; errorCode: string; fingerprint: string };
  /** 已展示的 cert 警告 (等用户决定) — "继续访问" 的信任凭据从这里取 (含真实证书指纹),
   *  不信 neox://trust-cert URL 里的参数 (页面内容可自行构造该跳转). */
  lastCertWarning?: { url: string; host: string; errorCode: string; fingerprint: string };
  /** console / network ring buffer — browser_get_console_logs / get_network / get_response_body 数据源. */
  capture: HostCapture;
  /** 网络 mock 注册表, key = `${method}|${pattern}`. */
  mocks: Map<string, HostMockEntry>;
  /** Fetch domain 是否已 enable — 只在有 mock 时开, 避免所有请求白过一遍暂停点. */
  fetchEnabled: boolean;
}

/* 单例 — 一台 Electron 实例就一份 manager. */
class BrowserViewManager {
  private views = new Map<string, BrowserViewEntry>();
  private trustedCertByHost = new Map<string, string>();

  private coerceBoundsForWindow(win: ElectronBrowserWindow | null | undefined, bounds: Rectangle): Rectangle {
    const rawX = Number.isFinite(bounds.x) ? Math.round(bounds.x) : 0;
    const rawY = Number.isFinite(bounds.y) ? Math.round(bounds.y) : 0;
    const rawWidth = Number.isFinite(bounds.width) ? Math.max(0, Math.round(bounds.width)) : 0;
    const rawHeight = Number.isFinite(bounds.height) ? Math.max(0, Math.round(bounds.height)) : 0;
    if (!win || win.isDestroyed()) {
      return {
        x: Math.max(0, rawX),
        y: Math.max(0, rawY),
        width: rawWidth,
        height: rawHeight,
      };
    }

    const content = win.getContentBounds();
    const contentWidth = Math.max(0, Math.round(content.width));
    const contentHeight = Math.max(0, Math.round(content.height));
    const x = Math.min(Math.max(0, rawX), contentWidth);
    const y = Math.min(Math.max(0, rawY), contentHeight);
    return {
      x,
      y,
      width: Math.min(rawWidth, Math.max(0, contentWidth - x)),
      height: Math.min(rawHeight, Math.max(0, contentHeight - y)),
    };
  }

  private getLiveWindow(e: BrowserViewEntry): ElectronBrowserWindow | null {
    const win = BrowserWindow.fromId(e.workspaceWindowId);
    return win && !win.isDestroyed() ? win : null;
  }

  private raiseView(e: BrowserViewEntry): void {
    const win = this.getLiveWindow(e);
    if (!win) return;
    try { win.setTopBrowserView(e.view); } catch { /* ignore */ }
  }

  list(): Array<{
    surfaceId: string;
    url: string;
    title: string;
    hidden: boolean;
    suppressed: boolean;
    bounds?: Rectangle;
  }> {
    return [...this.views.values()].map(e => ({
      surfaceId: e.surfaceId,
      url: e.view.webContents.getURL(),
      title: e.view.webContents.getTitle(),
      hidden: e.hidden,
      suppressed: e.suppressed,
      bounds: e.lastRealBounds,
    }));
  }

  async listSurfaces(): Promise<Array<{
    surfaceId: string;
    url: string;
    title: string;
    hidden: boolean;
    suppressed: boolean;
    bounds?: Rectangle;
  }>> {
    return this.list();
  }

  async diagnose(): Promise<{
    rawTargets: Array<{ id: string; type: string; title: string; url: string }>;
    playwrightPages: Array<{ url: string; title: string; windowName: string; contextIdx: number; frameCount: number }>;
  }> {
    return {
      rawTargets: this.list().map(surface => ({
        id: surface.surfaceId,
        type: 'BrowserView',
        title: surface.title,
        url: surface.url,
      })),
      playwrightPages: this.list().map((surface, idx) => ({
        url: surface.url,
        title: surface.title,
        windowName: `neox-sfc-${surface.surfaceId}`,
        contextIdx: idx,
        frameCount: 1,
      })),
    };
  }

  get(surfaceId: string): BrowserViewEntry | undefined {
    return this.views.get(surfaceId);
  }

  private requireEntry(surfaceId: string): BrowserViewEntry {
    const e = this.views.get(surfaceId);
    if (!e) throw new Error(`surface "${surfaceId}" not mounted`);
    if (e.view.webContents.isDestroyed()) throw new Error(`surface "${surfaceId}" webContents destroyed`);
    return e;
  }

  private async executeJavaScript<T = any>(surfaceId: string, code: string): Promise<T> {
    const e = this.requireEntry(surfaceId);
    return e.view.webContents.executeJavaScript(code, true) as Promise<T>;
  }

  private ensureDebuggerAttached(e: BrowserViewEntry): void {
    const dbg = e.view.webContents.debugger;
    if (dbg.isAttached()) {
      e.debuggerAttached = true;
      return;
    }
    dbg.attach('1.3');
    e.debuggerAttached = true;
    /* 重新 attach (曾被 detach) → domain 状态已丢, 重新 enable. sendCommand 同 session
     * 内按序派发, 不用 await 也保证先于后续命令生效. */
    void this.enableCaptureDomains(e);
  }

  /** Network (+有 mock 时 Fetch) domain enable — attach / re-attach 后调. */
  private async enableCaptureDomains(e: BrowserViewEntry): Promise<void> {
    const dbg = e.view.webContents.debugger;
    try {
      /* buffer 上限: response body 由 Chromium 网络栈缓存 (getResponseBody 数据源), 封顶防内存涨 */
      await dbg.sendCommand('Network.enable', {
        maxTotalBufferSize: 20 * 1024 * 1024,
        maxResourceBufferSize: 5 * 1024 * 1024,
      });
      if (e.mocks.size > 0 && !e.fetchEnabled) {
        await dbg.sendCommand('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
        e.fetchEnabled = true;
      }
    } catch (err: any) {
      cliLogger.warn('BROWSER_VIEW', `enableCaptureDomains surface=${e.surfaceId} 失败: ${err?.message}`);
    }
  }

  /** debugger 'message' 事件分发 — network 采集 + Fetch mock. */
  private onDebuggerMessage(e: BrowserViewEntry, method: string, params: any): void {
    const cap = e.capture;
    switch (method) {
      case 'Network.requestWillBeSent': {
        /* 同 requestId 的 redirect 会再发一次 requestWillBeSent — 复用旧 entry 更新 URL */
        const existing = cap.networkById.get(params.requestId);
        if (existing) {
          existing.url = params.request?.url ?? existing.url;
          existing.timestamp = Date.now();
          return;
        }
        const entry: HostNetworkLog = {
          id: params.requestId,
          timestamp: Date.now(),
          url: params.request?.url ?? '',
          method: params.request?.method ?? 'GET',
          resourceType: String(params.type ?? 'other').toLowerCase(),
        };
        cap.network.push(entry);
        cap.networkById.set(entry.id, entry);
        while (cap.network.length > HOST_MAX_NETWORK) {
          const evicted = cap.network.shift();
          if (evicted) cap.networkById.delete(evicted.id);
        }
        return;
      }
      case 'Network.responseReceived': {
        const entry = cap.networkById.get(params.requestId);
        if (!entry) return;
        entry.responseAt = Date.now();
        entry.durationMs = entry.responseAt - entry.timestamp;
        entry.status = params.response?.status;
        entry.statusText = params.response?.statusText;
        entry.mime = params.response?.mimeType;
        return;
      }
      case 'Network.loadingFailed': {
        const entry = cap.networkById.get(params.requestId);
        if (!entry) return;
        entry.failedReason = params.errorText || 'unknown';
        entry.responseAt = Date.now();
        entry.durationMs = entry.responseAt - entry.timestamp;
        return;
      }
      case 'Fetch.requestPaused': {
        void this.onFetchRequestPaused(e, params);
        return;
      }
      default:
        return;
    }
  }

  /** Fetch.requestPaused → 命中 mock 则 fulfill, 否则放行. 任何异常都必须 continue, 否则页面挂死. */
  private async onFetchRequestPaused(e: BrowserViewEntry, params: any): Promise<void> {
    const dbg = e.view.webContents.debugger;
    try {
      const url: string = params.request?.url ?? '';
      const reqMethod: string = String(params.request?.method ?? 'GET').toUpperCase();
      let hit: HostMockEntry | undefined;
      for (const mock of e.mocks.values()) {
        if (mock.method !== '*' && mock.method !== reqMethod) continue;
        if (mockGlobToRegExp(mock.pattern).test(url)) { hit = mock; break; }
      }
      if (!hit) {
        await dbg.sendCommand('Fetch.continueRequest', { requestId: params.requestId });
        return;
      }
      const responseHeaders: Array<{ name: string; value: string }> = [];
      if (hit.contentType) responseHeaders.push({ name: 'Content-Type', value: hit.contentType });
      for (const [name, value] of Object.entries(hit.headers ?? {})) {
        responseHeaders.push({ name, value: String(value) });
      }
      await dbg.sendCommand('Fetch.fulfillRequest', {
        requestId: params.requestId,
        responseCode: hit.status,
        responseHeaders,
        body: Buffer.from(hit.body ?? '', 'utf-8').toString('base64'),
      });
    } catch {
      /* fulfill 失败 (请求可能已消失) → 尽力放行, 双失败只能忍 */
      try { await dbg.sendCommand('Fetch.continueRequest', { requestId: params.requestId }); } catch { /* ignore */ }
    }
  }

  private async sendDebuggerCommand(surfaceId: string, method: string, params?: Record<string, any>): Promise<any> {
    const e = this.requireEntry(surfaceId);
    this.ensureDebuggerAttached(e);
    return e.view.webContents.debugger.sendCommand(method, params ?? {});
  }

  /** 创建或复用 — 已存在则只 setBounds + bringToFront. */
  ensure(opts: MountOptions): BrowserViewEntry {
    const existing = this.views.get(opts.surfaceId);
    if (existing) {
      this.setBounds(opts.surfaceId, opts.bounds);
      this.bringToFront(opts.surfaceId);
      return existing;
    }

    const win = BrowserWindow.fromId(opts.workspaceWindowId);
    if (!win) {
      throw new Error(`BrowserViewManager.ensure: ElectronBrowserWindow id=${opts.workspaceWindowId} not found`);
    }

    const partition = partitionForWorkspace(opts.workspacePath);
    const view = new BrowserView({
      webPreferences: {
        sandbox: true,              /* 安全: 子页面不能访问 Node */
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        devTools: true,             /* DevTools 入口靠 toolbar 显式开 */
        /* workspace 独立分区 — cookies/localStorage/indexedDB 持久化到分区目录,
         * 跨 Neox 重启保留登录态, 跨 workspace 不串数据. 同 workspace 多 BrowserView 共享. */
        partition: partition || undefined,
      },
    });
    if (partition) {
      cliLogger.info('BROWSER_VIEW', `surface=${opts.surfaceId} partition=${partition} (workspace=${opts.workspacePath})`);
    }

    const initialBounds = this.coerceBoundsForWindow(win, opts.bounds);
    win.addBrowserView(view);
    view.setBounds(initialBounds);

    const entry: BrowserViewEntry = {
      surfaceId: opts.surfaceId,
      view,
      workspaceWindowId: opts.workspaceWindowId,
      debuggerAttached: false,
      hidden: false,
      suppressed: false,
      lastRealBounds: initialBounds,
      capture: { console: [], network: [], networkById: new Map() },
      mocks: new Map(),
      fetchEnabled: false,
    };
    this.views.set(opts.surfaceId, entry);
    if (!entry.hidden && !entry.suppressed && initialBounds.width >= 8 && initialBounds.height >= 8) {
      this.raiseView(entry);
    }

    /* 自签证书 Chrome 风格警告页 —
     *   Vite / Next 等本地 dev server 默认开 https 用自签证书. Electron BrowserView 默认
     *   对自签证书直接拒载没 UI 让用户绕过, 表现是 "外部能打开内置打不开".
     *
     *   流程:
     *     1. cert-error 命中 (host, 证书指纹) 信任表 → callback(true) 放行 (用户已确认过这张证书)
     *     2. 否则 callback(false) 让加载失败, 在 entry 上记下 pendingCertError (含指纹)
     *     3. did-fail-load 触发时 (cert-error 之后必触发) → loadURL 警告页 (data: URL),
     *        并把警告上下文存 lastCertWarning (信任凭据的唯一来源)
     *     4. 用户点 "继续访问" → 警告页 a href = neox://trust-cert?host=...&url=...
     *     5. will-navigate 拦该 scheme → 校验 host 匹配 lastCertWarning → 记 (host → 指纹) → loadURL 原 URL
     *     6. 第二次 loadURL 再触发 cert-error 走步骤 1 放行
     *
     *   只 trust 进程级 (退出清空), 跟 Chrome incognito 行为一致 — 避免长期 trust 被遗忘.
     *   信任按 (host, 指纹) 二元组: 同 host 换证书 (真 MITM 特征) 会重新弹警告, 不吃老信任. */
    view.webContents.on('certificate-error', (event, url, error, cert, callback) => {
      let host = '';
      try { host = new URL(url).host; } catch { /* ignore */ }
      const fingerprint = cert?.fingerprint || '';
      const trustedFp = host ? this.trustedCertByHost.get(host) : undefined;
      if (host && fingerprint && trustedFp === fingerprint) {
        event.preventDefault();
        callback(true);
        cliLogger.info('BROWSER_VIEW',
          `cert-error trusted (user-confirmed cert): ${host} error=${error}`);
        return;
      }
      if (trustedFp && trustedFp !== fingerprint) {
        /* host 曾被信任但证书变了 — MITM 的典型形态, 大声记一笔并强制重新确认. */
        cliLogger.warn('BROWSER_VIEW',
          `cert CHANGED for previously trusted host=${host} (possible MITM) — re-prompting`);
      }
      callback(false);
      entry.pendingCertError = { url, host, errorCode: error, fingerprint };
      cliLogger.warn('BROWSER_VIEW',
        `cert-error pending warning: ${url} host=${host} error=${error}`);
    });

    /* did-fail-load: 加载失败兜底.
     *   1. 有 pendingCertError → 自签证书警告页 (走 user-confirm 流程)
     *   2. 否则 (网络错误 / DNS 解析失败 / 端口拒绝等) → Chrome 风格"无法访问此网站"页
     *   3. ABORTED (-3) 是 用户/我们主动取消导航, 不算错; sub-frame 失败也跳过
     *   4. data: / about: URL 失败不递归 load (避免循环刷错误页)
     */
    view.webContents.on('did-fail-load', (_event, errorCode, errorDesc, validatedURL, isMainFrame) => {
      const pe = entry.pendingCertError;
      if (pe) {
        entry.pendingCertError = undefined;
        /* 警告上下文 (含真实证书指纹) 留在 entry 上 — "继续访问" 只认这里的指纹. */
        entry.lastCertWarning = pe;
        void view.webContents.loadURL(buildCertWarningDataUrl(pe.url, pe.host, pe.errorCode))
          .catch(err => cliLogger.warn('BROWSER_VIEW', `load cert-warning failed: ${err?.message}`));
        return;
      }
      if (!isMainFrame) return;
      if (errorCode === -3) return; /* ABORTED — 主动取消, 不是真错 */
      if (!validatedURL || validatedURL.startsWith('data:') || validatedURL.startsWith('about:')) return;
      cliLogger.info('BROWSER_VIEW',
        `did-fail-load ${validatedURL}: ${errorDesc} (${errorCode}) — showing error page`);
      void view.webContents.loadURL(buildNetworkErrorDataUrl(validatedURL, errorCode, errorDesc))
        .catch(err => cliLogger.warn('BROWSER_VIEW', `load net-error page failed: ${err?.message}`));
    });

    view.webContents.setWindowOpenHandler(({ url }) => {
      try {
        const parsed = new URL(url);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          void view.webContents.loadURL(parsed.toString())
            .catch(() => { /* 加载失败走 did-fail-load 兜底错误页 */ });
        }
      } catch { /* 无效 url, 丢弃 */ }
      return { action: 'deny' };
    });

    /* 拦截警告页的 "继续访问" 链接 — neox://trust-cert?host=...&url=...
     * 信任凭据 (证书指纹) 只从 entry.lastCertWarning 取, 不信 URL 参数 — 任意页面都能
     * location.href 构造这个 scheme, 若按参数直接信任等于页面可自助放行任意 host. */
    view.webContents.on('will-navigate', (event, navUrl) => {
      if (!navUrl.startsWith('neox://trust-cert')) return;
      event.preventDefault();
      try {
        const u = new URL(navUrl);
        const targetHost = u.searchParams.get('host') || '';
        const targetUrl = u.searchParams.get('url') || '';
        const warning = entry.lastCertWarning;
        if (!targetHost || !warning || warning.host !== targetHost) {
          cliLogger.warn('BROWSER_VIEW',
            `trust-cert nav ignored: host=${targetHost} has no matching pending cert warning`);
          return;
        }
        entry.lastCertWarning = undefined;
        if (warning.fingerprint) {
          this.trustedCertByHost.set(targetHost, warning.fingerprint);
          cliLogger.info('BROWSER_VIEW',
            `user trusted cert for host=${targetHost} fp=${warning.fingerprint.slice(0, 24)}… (session-scoped)`);
        } else {
          /* 拿不到指纹 (理论不该发生) — 宁可每次重弹警告也不整 host 放行. */
          cliLogger.warn('BROWSER_VIEW',
            `trust-cert: no fingerprint captured for host=${targetHost}, not persisting trust`);
        }
        if (targetUrl) {
          const safeTargetUrl = normalizeBrowserNavigationUrl(targetUrl);
          if (new URL(safeTargetUrl).host !== targetHost) {
            throw new Error('trusted cert target host mismatch');
          }
          void view.webContents.loadURL(safeTargetUrl).catch(() => { /* 已 log */ });
        }
      } catch (err: any) {
        cliLogger.warn('BROWSER_VIEW', `trust-cert nav parse failed: ${err?.message}`);
      }
    });

    /* console 采集 — webContents 事件即可, 不需要 CDP. Electron 新旧两种 console-message
     * 签名都兼容: 旧 = (event, level:number 0-3, message, line, sourceId), 新 = (event 上带
     * level:'info'|'warning'|'error'|'debug' / message / lineNumber / sourceId). */
    view.webContents.on('console-message', (ev: any, legacyLevel?: any, legacyMessage?: string, legacyLine?: number, legacySource?: string) => {
      let level: HostConsoleLog['level'];
      let text: string;
      let location: string | undefined;
      if (typeof legacyLevel === 'number') {
        level = legacyLevel === 3 ? 'error' : legacyLevel === 2 ? 'warn' : legacyLevel === 0 ? 'debug' : 'log';
        text = legacyMessage ?? '';
        location = legacySource ? `${legacySource}:${legacyLine ?? 0}` : undefined;
      } else {
        const lv = ev?.level;
        level = lv === 'warning' ? 'warn' : lv === 'error' ? 'error' : lv === 'debug' ? 'debug' : lv === 'info' ? 'info' : 'log';
        text = ev?.message ?? '';
        location = ev?.sourceId ? `${ev.sourceId}:${ev.lineNumber ?? 0}` : undefined;
      }
      entry.capture.console.push({ timestamp: Date.now(), level, text, location });
      while (entry.capture.console.length > HOST_MAX_CONSOLE) entry.capture.console.shift();
    });

    /* attach per-view debugger 给内置 browser tools 用 (输入合成 + network 采集 + mock).
     * 失败不致命, UI 仍可用. */
    try {
      const dbg = view.webContents.debugger;
      dbg.on('message', (_ev, method, params) => this.onDebuggerMessage(entry, method, params));
      dbg.on('detach', (_ev, reason) => {
        entry.debuggerAttached = false;
        entry.fetchEnabled = false;   /* domain 状态随 session 丢, 下次 ensureDebuggerAttached 重建 */
        cliLogger.info('BROWSER_VIEW', `CDP debugger detached surface=${opts.surfaceId} reason=${reason}`);
      });
      dbg.attach('1.3');
      entry.debuggerAttached = true;
      void this.enableCaptureDomains(entry);
      cliLogger.info('BROWSER_VIEW', `attached CDP debugger for surface=${opts.surfaceId}`);
    } catch (err: any) {
      cliLogger.warn('BROWSER_VIEW', `debugger.attach 失败 (UI 仍可用): ${err?.message}`);
    }

    /* 初始 URL */
    if (opts.initialUrl) {
      void this.loadURL(opts.surfaceId, opts.initialUrl).catch(() => { /* 已记日志 */ });
    } else {
      void view.webContents.loadURL('about:blank').catch(() => { /* */ });
    }

    /* 页面内身份标识 — 兼容旧 Playwright/CDP 调试路径; host controller 本身不依赖它,
     * 但 dev 模式下打开 NEOX_ENABLE_CDP/remote debugging 时仍可辅助诊断. */
    const reinjectIdentity = () => {
      try {
        view.webContents.executeJavaScript(
          `try { window.name = "neox-sfc-${opts.surfaceId}"; } catch(e){}`,
          true /* userGesture, 绕 some CSP 限制 */,
        ).catch(() => { /* 跨源导航期间页面没就绪, 容忍 */ });
      } catch { /* ignore */ }
    };
    view.webContents.on('did-finish-load', reinjectIdentity);
    view.webContents.on('did-navigate', reinjectIdentity);
    view.webContents.on('did-navigate-in-page', reinjectIdentity);

    /* 父窗口关闭时清理 */
    win.on('closed', () => {
      this.destroy(opts.surfaceId);
    });

    return entry;
  }

  /** 根据 hidden / suppressed flags 把 view 推到正确位置. 单点真相. */
  private applyVisibility(e: BrowserViewEntry): void {
    try {
      if (e.hidden || e.suppressed) {
        /* off-screen — bounds 0×0 才能真正不渲染. 给负坐标避免占像素 */
        e.view.setBounds({ x: -10000, y: -10000, width: 0, height: 0 });
      } else if (e.lastRealBounds) {
        e.view.setBounds(e.lastRealBounds);
      }
    } catch { /* ignore */ }
  }

  /** 把 view 放到顶层 + 取消 hidden (切到该 tab 时调). */
  bringToFront(surfaceId: string): void {
    const e = this.views.get(surfaceId);
    if (!e) return;
    e.hidden = false;
    this.applyVisibility(e);
    if (!e.suppressed) this.raiseView(e);
  }

  /** 显式 show: 用户导航/手动恢复时调用, 可解除 stuck suppression. */
  show(surfaceId: string): void {
    const e = this.views.get(surfaceId);
    if (!e) return;
    e.hidden = false;
    e.suppressed = false;
    this.applyVisibility(e);
    this.raiseView(e);
  }

  /** Hide: tab 切走时调, 暂时不渲染但不销毁. */
  hide(surfaceId: string): void {
    const e = this.views.get(surfaceId);
    if (!e) return;
    e.hidden = true;
    this.applyVisibility(e);
  }

  setBounds(surfaceId: string, bounds: Rectangle): void {
    const e = this.views.get(surfaceId);
    if (!e) return;
    const win = this.getLiveWindow(e);
    const safe = this.coerceBoundsForWindow(win, bounds);
    e.lastRealBounds = safe;
    if (safe.width >= 8 && safe.height >= 8) {
      e.hidden = false;
    }
    this.applyVisibility(e);
    if (!e.hidden && !e.suppressed && safe.width >= 8 && safe.height >= 8) {
      this.raiseView(e);
    }
  }

  /** 整体 suppress / restore — DOM overlay 显示期间用. 计数管理在 renderer 端. */
  suppressAll(): void {
    for (const e of this.views.values()) {
      e.suppressed = true;
      this.applyVisibility(e);
    }
  }
  restoreAll(): void {
    for (const e of this.views.values()) {
      e.suppressed = false;
      this.applyVisibility(e);
      if (!e.hidden) this.raiseView(e);
    }
  }

  /** 单点 suppress / restore — 只藏指定 surface 的 view (做 fade 用, 不影响其他 surface). */
  suppress(surfaceId: string): void {
    const e = this.views.get(surfaceId);
    if (!e) return;
    e.suppressed = true;
    this.applyVisibility(e);
  }
  restore(surfaceId: string): void {
    const e = this.views.get(surfaceId);
    if (!e) return;
    e.suppressed = false;
    this.applyVisibility(e);
    if (!e.hidden) this.raiseView(e);
  }

  async loadURL(surfaceId: string, url: string): Promise<{ ok: boolean; url?: string; title?: string; error?: string }> {
    const e = this.views.get(surfaceId);
    if (!e) return { ok: false, error: 'surface not mounted' };
    try {
      const target = normalizeBrowserNavigationUrl(url);
      await e.view.webContents.loadURL(target);
      if (!e.hidden && !e.suppressed) {
        this.raiseView(e);
      }
      return {
        ok: true,
        url: e.view.webContents.getURL(),
        title: e.view.webContents.getTitle(),
      };
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  async goBack(surfaceId: string): Promise<{ ok: boolean }> {
    const e = this.views.get(surfaceId);
    if (!e) return { ok: false };
    const nh: any = (e.view.webContents as any).navigationHistory;
    if (nh && typeof nh.canGoBack === 'function' && nh.canGoBack()) {
      nh.goBack();
      return { ok: true };
    }
    try { (e.view.webContents as any).goBack?.(); return { ok: true }; } catch { return { ok: false }; }
  }
  async goForward(surfaceId: string): Promise<{ ok: boolean }> {
    const e = this.views.get(surfaceId);
    if (!e) return { ok: false };
    const nh: any = (e.view.webContents as any).navigationHistory;
    if (nh && typeof nh.canGoForward === 'function' && nh.canGoForward()) {
      nh.goForward();
      return { ok: true };
    }
    try { (e.view.webContents as any).goForward?.(); return { ok: true }; } catch { return { ok: false }; }
  }
  async reload(surfaceId: string): Promise<{ ok: boolean }> {
    const e = this.views.get(surfaceId);
    if (!e) return { ok: false };
    e.view.webContents.reload();
    return { ok: true };
  }

  getState(surfaceId: string): {
    url: string; title: string;
    loading: boolean; canGoBack: boolean; canGoForward: boolean;
    hidden: boolean; suppressed: boolean; bounds?: Rectangle;
  } | null {
    const e = this.views.get(surfaceId);
    if (!e) return null;
    const wc: any = e.view.webContents;
    const nh = wc.navigationHistory;
    return {
      url: wc.getURL(),
      title: wc.getTitle(),
      loading: wc.isLoading(),
      canGoBack: nh && typeof nh.canGoBack === 'function' ? nh.canGoBack() : (wc.canGoBack?.() ?? false),
      canGoForward: nh && typeof nh.canGoForward === 'function' ? nh.canGoForward() : (wc.canGoForward?.() ?? false),
      hidden: e.hidden,
      suppressed: e.suppressed,
      bounds: e.lastRealBounds,
    };
  }

  toggleDevTools(surfaceId: string): void {
    const e = this.views.get(surfaceId);
    if (!e) return;
    const wc = e.view.webContents;
    if (wc.isDevToolsOpened()) wc.closeDevTools();
    else wc.openDevTools({ mode: 'detach' });
  }

  /** 截当前 BrowserView 的 PNG, base64 编码. 给 suppress fade 用 (DOM 端贴 snapshot 假装 fade).
   *  也给 agent screenshot 工具用.
   *
   *  checklist 5.11: capturePage 在某些 OS / GPU / 网络场景会无限挂 (例如目标 page 在 paint
   *  时被换 layer, 或网络慢导致 frame 不可用). 加 15s 硬超时, 超时后 reject + 上层
   *  retry/降级. fade suppress 调用方 (DOM) 已有自己的 fallback (直接显白), 不影响. */
  async capture(surfaceId: string): Promise<{ ok: boolean; base64?: string; width?: number; height?: number; error?: string }> {
    const e = this.views.get(surfaceId);
    if (!e) return { ok: false, error: 'surface not mounted' };
    try {
      const CAPTURE_TIMEOUT_MS = 15_000;
      const timeoutPromise = new Promise<never>((_, reject) => {
        const tid = setTimeout(() => {
          clearTimeout(tid);
          reject(new Error(`capturePage timeout after ${CAPTURE_TIMEOUT_MS / 1000}s`));
        }, CAPTURE_TIMEOUT_MS);
      });
      const img = await Promise.race([e.view.webContents.capturePage(), timeoutPromise]);
      const buf = img.toPNG();
      const size = img.getSize();
      return {
        ok: true,
        base64: buf.toString('base64'),
        width: size.width,
        height: size.height,
      };
    } catch (err: any) {
      return { ok: false, error: err?.message };
    }
  }

  async browserNavigate(args: { surfaceId: string; url: string }): Promise<{ ok: boolean; url?: string; title?: string; error?: string }> {
    return this.loadURL(args.surfaceId, args.url);
  }

  async browserScreenshot(args: {
    surfaceId: string;
    clip?: { x: number; y: number; width: number; height: number };
    format?: 'png' | 'jpeg';
    quality?: number;
  }): Promise<{ ok: boolean; base64?: string; width?: number; height?: number; error?: string }> {
    const e = this.views.get(args.surfaceId);
    if (!e) return { ok: false, error: 'surface not mounted' };
    try {
      const img = await e.view.webContents.capturePage(args.clip as any);
      const size = img.getSize();
      const buf = args.format === 'jpeg'
        ? img.toJPEG(Math.max(0, Math.min(100, args.quality ?? 80)))
        : img.toPNG();
      return {
        ok: true,
        base64: buf.toString('base64'),
        width: args.clip?.width ?? size.width,
        height: args.clip?.height ?? size.height,
      };
    } catch (err) {
      return toolError(err);
    }
  }

  async browserGetState(args: { surfaceId: string }): Promise<Record<string, any>> {
    const state = this.getState(args.surfaceId);
    if (!state) return { ok: false, error: 'surface not mounted' };
    return { ok: true, ...state };
  }

  async browserBack(args: { surfaceId: string }): Promise<{ ok: boolean; url?: string; error?: string }> {
    const r = await this.goBack(args.surfaceId);
    const state = this.getState(args.surfaceId);
    return { ...r, url: state?.url };
  }

  async browserForward(args: { surfaceId: string }): Promise<{ ok: boolean; url?: string; error?: string }> {
    const r = await this.goForward(args.surfaceId);
    const state = this.getState(args.surfaceId);
    return { ...r, url: state?.url };
  }

  async browserReload(args: { surfaceId: string }): Promise<{ ok: boolean; url?: string; error?: string }> {
    const r = await this.reload(args.surfaceId);
    const state = this.getState(args.surfaceId);
    return { ...r, url: state?.url };
  }

  async browserGetAriaTree(args: { surfaceId: string; maxDepth?: number; pruneGeneric?: boolean }): Promise<Record<string, any>> {
    try {
      const tree = await this.executeJavaScript(
        args.surfaceId,
        domTreeScript(args.maxDepth ?? 12, args.pruneGeneric ?? true),
      );
      return { ok: true, tree };
    } catch (err) {
      return toolError(err);
    }
  }

  async browserQuery(args: { surfaceId: string; selector: string; limit?: number }): Promise<Record<string, any>> {
    try {
      const result = await this.executeJavaScript(args.surfaceId, `
(() => {
  const nodes = Array.from(document.querySelectorAll(${JSON.stringify(args.selector)}));
  const limit = Math.min(${JSON.stringify(args.limit ?? 10)}, nodes.length);
  return {
    count: nodes.length,
    texts: nodes.slice(0, limit).map((el) => {
      const text = (el.innerText || el.textContent || '').trim();
      return text.length > 200 ? text.slice(0, 197) + '...' : text;
    }),
  };
})()
`);
      return { ok: true, ...(result as any) };
    } catch (err) {
      return toolError(err);
    }
  }

  async browserGetText(args: { surfaceId: string; selector?: string; role?: string; name?: string; text?: string }): Promise<Record<string, any>> {
    try {
      const text = await this.executeJavaScript<string>(
        args.surfaceId,
        domLocatorScript(args, `
  if (!el) throw new Error('element not found');
  return (el.innerText || el.textContent || '').trim();
`),
      );
      return { ok: true, text };
    } catch (err) {
      return toolError(err);
    }
  }

  private async resolveElementCenter(surfaceId: string, locator: Record<string, any>): Promise<{ x: number; y: number }> {
    const point = await this.executeJavaScript<{ x: number; y: number }>(
      surfaceId,
      domLocatorScript(locator, `
  if (!el) throw new Error('element not found');
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const rect = el.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
`),
    );
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      throw new Error('element center unavailable');
    }
    return point;
  }

  async browserClick(args: {
    surfaceId: string;
    selector?: string;
    role?: string;
    name?: string;
    text?: string;
    button?: 'left' | 'right' | 'middle';
    clickCount?: number;
  }): Promise<{ ok: boolean; error?: string }> {
    try {
      const point = await this.resolveElementCenter(args.surfaceId, args);
      await this.browserClickAt({
        surfaceId: args.surfaceId,
        x: point.x,
        y: point.y,
        button: args.button,
        clickCount: args.clickCount,
        humanize: false,
      });
      return { ok: true };
    } catch (err) {
      return toolError(err);
    }
  }

  async browserType(args: {
    surfaceId: string;
    selector?: string;
    role?: string;
    name?: string;
    text: string;
    clear?: boolean;
    submit?: boolean;
  }): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.executeJavaScript(args.surfaceId, domLocatorScript(args, `
  if (!el) throw new Error('element not found');
  el.focus();
  if (${JSON.stringify(args.clear !== false)} && ('value' in el)) {
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  return true;
`));
      await this.browserKeyboardType({ surfaceId: args.surfaceId, text: args.text, delay: 0 });
      if (args.submit) {
        await this.browserKeyboardPress({ surfaceId: args.surfaceId, key: 'Enter' });
      }
      return { ok: true };
    } catch (err) {
      return toolError(err);
    }
  }

  async browserPressKey(args: { surfaceId: string; key: string; selector?: string; role?: string; name?: string }): Promise<{ ok: boolean; error?: string }> {
    try {
      if (args.selector || args.role || args.name) {
        await this.executeJavaScript(args.surfaceId, domLocatorScript(args, `
  if (!el) throw new Error('element not found');
  el.focus();
  return true;
`));
      }
      return this.browserKeyboardPress({ surfaceId: args.surfaceId, key: args.key });
    } catch (err) {
      return toolError(err);
    }
  }

  async browserScroll(args: {
    surfaceId: string;
    selector?: string;
    role?: string;
    name?: string;
    x?: number;
    y?: number;
    direction?: 'up' | 'down' | 'left' | 'right';
    amount?: number;
  }): Promise<{ ok: boolean; error?: string }> {
    try {
      if (args.selector || args.role || args.name) {
        await this.executeJavaScript(args.surfaceId, domLocatorScript(args, `
  if (!el) throw new Error('element not found');
  el.scrollIntoView({ block: 'center', inline: 'center' });
  return true;
`));
        return { ok: true };
      }
      if (typeof args.x === 'number' && typeof args.y === 'number') {
        await this.executeJavaScript(args.surfaceId, `window.scrollTo(${JSON.stringify(args.x)}, ${JSON.stringify(args.y)}); true`);
        return { ok: true };
      }
      const amount = args.amount ?? 400;
      const [dx, dy] =
          args.direction === 'up' ? [0, -amount]
        : args.direction === 'left' ? [-amount, 0]
        : args.direction === 'right' ? [amount, 0]
        : [0, amount];
      await this.executeJavaScript(args.surfaceId, `window.scrollBy(${dx}, ${dy}); true`);
      return { ok: true };
    } catch (err) {
      return toolError(err);
    }
  }

  async browserHover(args: { surfaceId: string; selector?: string; role?: string; name?: string; text?: string }): Promise<{ ok: boolean; error?: string }> {
    try {
      const point = await this.resolveElementCenter(args.surfaceId, args);
      await this.browserMouseMove({ surfaceId: args.surfaceId, x: point.x, y: point.y, steps: 6 });
      return { ok: true };
    } catch (err) {
      return toolError(err);
    }
  }

  async browserSelectOption(args: { surfaceId: string; selector: string; value: string | string[] }): Promise<Record<string, any>> {
    try {
      const selected = await this.executeJavaScript<string[]>(args.surfaceId, `
(() => {
  const el = document.querySelector(${JSON.stringify(args.selector)});
  if (!el) throw new Error('select element not found');
  const wanted = new Set(${JSON.stringify(Array.isArray(args.value) ? args.value : [args.value])});
  for (const option of Array.from(el.options || [])) option.selected = wanted.has(option.value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return Array.from(el.selectedOptions || []).map((o) => o.value);
})()
`);
      return { ok: true, selected };
    } catch (err) {
      return toolError(err);
    }
  }

  async browserFillForm(args: { surfaceId: string; fields: Array<{ selector: string; value: string }>; submit?: boolean }): Promise<Record<string, any>> {
    try {
      const filled = await this.executeJavaScript<number>(args.surfaceId, `
(() => {
  const fields = ${JSON.stringify(args.fields ?? [])};
  let filled = 0;
  for (const field of fields) {
    const el = document.querySelector(field.selector);
    if (!el) throw new Error('field not found: ' + field.selector);
    el.focus();
    el.value = field.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    filled++;
  }
  return filled;
})()
`);
      if (args.submit) {
        await this.browserKeyboardPress({ surfaceId: args.surfaceId, key: 'Enter' });
      }
      return { ok: true, filled };
    } catch (err) {
      return toolError(err);
    }
  }

  async browserWaitFor(args: { surfaceId: string; kind: string; selector?: string; urlPattern?: string; predicate?: string; timeout?: number }): Promise<Record<string, any>> {
    const started = Date.now();
    const timeout = args.timeout ?? 30_000;
    const deadline = Date.now() + timeout;
    try {
      while (Date.now() <= deadline) {
        const state = this.getState(args.surfaceId);
        if (!state) throw new Error('surface not mounted');
        if (args.kind === 'network_idle' && !state.loading) return { ok: true, elapsed: Date.now() - started };
        if (args.kind === 'url' && args.urlPattern) {
          const pattern = '^' + args.urlPattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
          if (new RegExp(pattern).test(state.url)) return { ok: true, elapsed: Date.now() - started };
        }
        if (args.kind === 'selector' && args.selector) {
          const found = await this.executeJavaScript<boolean>(
            args.surfaceId,
            `Boolean(document.querySelector(${JSON.stringify(args.selector)}))`,
          );
          if (found) return { ok: true, elapsed: Date.now() - started };
        }
        if (args.kind === 'function' && args.predicate) {
          const ok = await this.executeJavaScript<boolean>(
            args.surfaceId,
            `Boolean((() => { const fn = ${args.predicate.includes('=>') || args.predicate.startsWith('function') ? `(${args.predicate})` : `() => (${args.predicate})`}; return fn(); })())`,
          ).catch(() => false);
          if (ok) return { ok: true, elapsed: Date.now() - started };
        }
        await new Promise(r => setTimeout(r, 200));
      }
      return { ok: false, elapsed: Date.now() - started, error: `timeout after ${timeout}ms` };
    } catch (err) {
      return { ...toolError(err), elapsed: Date.now() - started };
    }
  }

  async browserWaitForNavigation(args: { surfaceId: string; timeout?: number }): Promise<Record<string, any>> {
    return this.browserWaitFor({ surfaceId: args.surfaceId, kind: 'network_idle', timeout: args.timeout });
  }

  async browserExpect(args: { surfaceId: string; kind: string; selector?: string; text?: string; pattern?: string; count?: number; value?: string; timeout?: number }): Promise<Record<string, any>> {
    const started = Date.now();
    const timeout = args.timeout ?? 5000;
    const deadline = Date.now() + timeout;
    try {
      while (Date.now() <= deadline) {
        let actual: any;
        if (args.kind === 'url') {
          actual = this.getState(args.surfaceId)?.url ?? '';
          const pattern = args.pattern ?? '*';
          const re = pattern.startsWith('/') && pattern.endsWith('/')
            ? new RegExp(pattern.slice(1, -1))
            : new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
          if (re.test(actual)) return { ok: true, actual };
        } else if (args.kind === 'count' && args.selector) {
          actual = await this.executeJavaScript<number>(args.surfaceId, `document.querySelectorAll(${JSON.stringify(args.selector)}).length`);
          if (actual === args.count) return { ok: true, actual };
        } else if (args.kind === 'value' && args.selector) {
          actual = await this.executeJavaScript<string>(args.surfaceId, `(document.querySelector(${JSON.stringify(args.selector)})?.value ?? '')`);
          if (String(actual).includes(args.value ?? '')) return { ok: true, actual };
        } else if (args.kind === 'text') {
          actual = await this.browserGetText({ surfaceId: args.surfaceId, selector: args.selector, text: args.text });
          const actualText = String((actual as any).text ?? '');
          if (actualText.includes(args.text ?? '')) return { ok: true, actual: actualText };
        } else if (args.kind === 'visible' && args.selector) {
          actual = await this.executeJavaScript<boolean>(args.surfaceId, `
(() => {
  const el = document.querySelector(${JSON.stringify(args.selector)});
  if (!el) return false;
  const style = getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
})()
`);
          if (actual === true) return { ok: true, actual };
        }
        await new Promise(r => setTimeout(r, 200));
      }
      return { ok: false, message: `expect timeout after ${timeout}ms` };
    } catch (err) {
      return { ...toolError(err), message: `expect failed after ${Date.now() - started}ms` };
    }
  }

  async browserEval(args: { surfaceId: string; js: string; args?: any[]; timeout?: number }): Promise<Record<string, any>> {
    try {
      const source = String(args.js ?? '');
      const isFunc = source.includes('=>') || /^\s*function\b/.test(source);
      const code = `
(async () => {
  const __args = ${JSON.stringify(args.args ?? [])};
  const __src = ${JSON.stringify(source)};
  if (${JSON.stringify(isFunc)}) {
    const fn = (0, eval)('(' + __src + ')');
    return await fn(...__args);
  }
  return await (0, eval)(__src);
})()
`;
      const result = await Promise.race([
        this.executeJavaScript(args.surfaceId, code),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('browser_eval timeout')), args.timeout ?? 10_000)),
      ]);
      return { ok: true, result };
    } catch (err) {
      return toolError(err);
    }
  }

  async browserGetLocalStorage(args: { surfaceId: string; key?: string }): Promise<Record<string, any>> {
    try {
      const result = await this.executeJavaScript(args.surfaceId, `
(() => {
  const key = ${JSON.stringify(args.key)};
  if (key) return { value: localStorage.getItem(key) };
  const all = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k) all[k] = localStorage.getItem(k) || '';
  }
  return { all };
})()
`);
      return { ok: true, ...(result as any) };
    } catch (err) {
      return toolError(err);
    }
  }

  async browserSetLocalStorage(args: { surfaceId: string; key: string; value: string | null }): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.executeJavaScript(args.surfaceId, `
(() => {
  const key = ${JSON.stringify(args.key)};
  const value = ${JSON.stringify(args.value)};
  if (value === null) localStorage.removeItem(key);
  else localStorage.setItem(key, value);
  return true;
})()
`);
      return { ok: true };
    } catch (err) {
      return toolError(err);
    }
  }

  async browserGetCookies(args: { surfaceId: string; urls?: string[] }): Promise<Record<string, any>> {
    try {
      const e = this.requireEntry(args.surfaceId);
      const cookies = await e.view.webContents.session.cookies.get(
        args.urls?.[0] ? { url: args.urls[0] } : {},
      );
      return { ok: true, cookies };
    } catch (err) {
      return toolError(err);
    }
  }

  async browserSetCookies(args: { surfaceId: string; cookies: Array<Record<string, any>> }): Promise<{ ok: boolean; error?: string }> {
    try {
      const e = this.requireEntry(args.surfaceId);
      for (const cookie of args.cookies ?? []) {
        await e.view.webContents.session.cookies.set(cookie as any);
      }
      return { ok: true };
    } catch (err) {
      return toolError(err);
    }
  }

  async browserClearCookies(args: { surfaceId: string; urls?: string[] }): Promise<{ ok: boolean; error?: string }> {
    try {
      const e = this.requireEntry(args.surfaceId);
      const cookies = await e.view.webContents.session.cookies.get(
        args.urls?.[0] ? { url: args.urls[0] } : {},
      );
      for (const cookie of cookies) {
        if (!cookie.domain) continue;
        const protocol = cookie.secure ? 'https://' : 'http://';
        const domain = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
        await e.view.webContents.session.cookies.remove(`${protocol}${domain}${cookie.path}`, cookie.name);
      }
      return { ok: true };
    } catch (err) {
      return toolError(err);
    }
  }

  /* ── console / network 观察 — 数据源是 ensure() 时挂的 ring buffer ── */

  async browserGetConsoleLogs(args: {
    surfaceId: string;
    level?: 'log' | 'info' | 'warn' | 'error' | 'debug' | 'trace';
    since?: number;
    limit?: number;
  }): Promise<Record<string, any>> {
    try {
      const e = this.requireEntry(args.surfaceId);
      let arr = e.capture.console;
      if (args.level) arr = arr.filter(l => l.level === args.level);
      if (typeof args.since === 'number') arr = arr.filter(l => l.timestamp >= args.since!);
      const total = arr.length;
      const limit = args.limit ?? 100;
      if (arr.length > limit) arr = arr.slice(-limit);
      return { ok: true, logs: arr, total };
    } catch (err) {
      return toolError(err);
    }
  }

  async browserGetNetwork(args: {
    surfaceId: string;
    urlContains?: string;
    method?: string;
    statusGte?: number;
    statusLte?: number;
    resourceType?: string;
    failedOnly?: boolean;
    since?: number;
    limit?: number;
  }): Promise<Record<string, any>> {
    try {
      const e = this.requireEntry(args.surfaceId);
      let arr = e.capture.network;
      if (args.urlContains) arr = arr.filter(n => n.url.includes(args.urlContains!));
      if (args.method) arr = arr.filter(n => n.method.toUpperCase() === args.method!.toUpperCase());
      if (args.resourceType) arr = arr.filter(n => n.resourceType === args.resourceType);
      if (typeof args.statusGte === 'number') arr = arr.filter(n => typeof n.status === 'number' && n.status >= args.statusGte!);
      if (typeof args.statusLte === 'number') arr = arr.filter(n => typeof n.status === 'number' && n.status <= args.statusLte!);
      if (args.failedOnly) arr = arr.filter(n => n.failedReason || (typeof n.status === 'number' && n.status >= 400));
      if (typeof args.since === 'number') arr = arr.filter(n => n.timestamp >= args.since!);
      const total = arr.length;
      const limit = args.limit ?? 50;
      if (arr.length > limit) arr = arr.slice(-limit);
      return { ok: true, requests: arr, total };
    } catch (err) {
      return toolError(err);
    }
  }

  async browserGetResponseBody(args: {
    surfaceId: string;
    requestId: string;
    maxBytes?: number;
  }): Promise<Record<string, any>> {
    try {
      const e = this.requireEntry(args.surfaceId);
      const logEntry = e.capture.networkById.get(args.requestId);
      if (!logEntry) return { ok: false, error: `request id "${args.requestId}" 未在 ring buffer 中找到 (可能已被挤出)` };
      if (logEntry.failedReason) return { ok: false, error: `request 失败 (${logEntry.failedReason}), 无 response body` };
      /* body 由 Chromium 网络栈缓存 (Network.enable 的 buffer), 页面导航后会失效 */
      const res = await this.sendDebuggerCommand(args.surfaceId, 'Network.getResponseBody', { requestId: args.requestId });
      const buf = res.base64Encoded
        ? Buffer.from(String(res.body ?? ''), 'base64')
        : Buffer.from(String(res.body ?? ''), 'utf-8');
      const mime = logEntry.mime || 'application/octet-stream';
      const maxBytes = args.maxBytes ?? 64 * 1024;
      const truncated = buf.length > maxBytes;
      const sliced = truncated ? buf.subarray(0, maxBytes) : buf;
      const isText = /^(text\/|application\/(json|javascript|xml|.*\+xml|.*\+json|x-www-form-urlencoded))/.test(mime);
      return {
        ok: true,
        body: isText ? sliced.toString('utf-8') : sliced.toString('base64'),
        isBase64: !isText,
        mime,
        truncated,
        size: buf.length,
      };
    } catch (err) {
      return toolError(err);
    }
  }

  /* ── 网络 mock — Fetch domain 按需 enable, 无 mock 时零开销 ── */

  async browserMockResponse(args: {
    surfaceId: string;
    urlPattern: string;
    status?: number;
    body?: string;
    contentType?: string;
    headers?: Record<string, string>;
    method?: string;
  }): Promise<Record<string, any>> {
    try {
      const e = this.requireEntry(args.surfaceId);
      const method = (args.method || '*').toUpperCase();
      /* contentType 默认推断 — 跟 neox-core 老路径同逻辑 */
      let contentType = args.contentType;
      if (!contentType && typeof args.body === 'string') {
        const trimmed = args.body.trim();
        contentType = (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))
          ? 'application/json'
          : 'text/plain';
      }
      e.mocks.set(mockKeyOf(method, args.urlPattern), {
        pattern: args.urlPattern,
        method,
        status: args.status ?? 200,
        body: args.body,
        contentType,
        headers: args.headers,
      });
      if (!e.fetchEnabled) {
        await this.sendDebuggerCommand(args.surfaceId, 'Fetch.enable', { patterns: [{ urlPattern: '*' }] });
        e.fetchEnabled = true;
      }
      return { ok: true, pattern: args.urlPattern, method };
    } catch (err) {
      return toolError(err);
    }
  }

  async browserClearMocks(args: {
    surfaceId: string;
    urlPattern?: string;
    method?: string;
  }): Promise<Record<string, any>> {
    try {
      const e = this.requireEntry(args.surfaceId);
      let cleared = 0;
      if (!args.urlPattern) {
        cleared = e.mocks.size;
        e.mocks.clear();
      } else if (args.method) {
        cleared = e.mocks.delete(mockKeyOf(args.method, args.urlPattern)) ? 1 : 0;
      } else {
        for (const [k, mock] of [...e.mocks.entries()]) {
          if (mock.pattern === args.urlPattern) {
            e.mocks.delete(k);
            cleared++;
          }
        }
      }
      if (e.mocks.size === 0 && e.fetchEnabled) {
        await this.sendDebuggerCommand(args.surfaceId, 'Fetch.disable');
        e.fetchEnabled = false;
      }
      return { ok: true, cleared };
    } catch (err) {
      return toolError(err);
    }
  }

  async browserListMocks(args: { surfaceId: string }): Promise<Record<string, any>> {
    try {
      const e = this.views.get(args.surfaceId);
      /* 列表只读 — surface 没 mount 也返空, 跟老路径行为一致 */
      return { ok: true, mocks: e ? [...e.mocks.values()] : [] };
    } catch (err) {
      return toolError(err);
    }
  }

  /* ── 文件上传 — DOM.setFileInputFiles 是 CDP 独有能力, 纯 JS 做不了 ── */

  async browserSetInputFiles(args: {
    surfaceId: string;
    selector: string;
    paths: string[];
    timeout?: number;
  }): Promise<Record<string, any>> {
    try {
      if (!args.paths || args.paths.length === 0) {
        return { ok: false, error: 'paths 不能为空' };
      }
      const doc = await this.sendDebuggerCommand(args.surfaceId, 'DOM.getDocument', { depth: 0 });
      const found = await this.sendDebuggerCommand(args.surfaceId, 'DOM.querySelector', {
        nodeId: doc?.root?.nodeId,
        selector: args.selector,
      });
      if (!found?.nodeId) {
        return { ok: false, error: `element not found: ${args.selector}` };
      }
      await this.sendDebuggerCommand(args.surfaceId, 'DOM.setFileInputFiles', {
        files: args.paths,
        nodeId: found.nodeId,
      });
      return { ok: true, uploaded: args.paths.length };
    } catch (err) {
      return toolError(err);
    }
  }

  async browserClickAt(args: {
    surfaceId: string;
    x: number;
    y: number;
    button?: 'left' | 'right' | 'middle';
    clickCount?: number;
    humanize?: boolean;
  }): Promise<{ ok: boolean; error?: string }> {
    try {
      const button = args.button ?? 'left';
      await this.sendDebuggerCommand(args.surfaceId, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: args.x,
        y: args.y,
        button: 'none',
      });
      await this.sendDebuggerCommand(args.surfaceId, 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: args.x,
        y: args.y,
        button,
        clickCount: args.clickCount ?? 1,
      });
      await this.sendDebuggerCommand(args.surfaceId, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: args.x,
        y: args.y,
        button,
        clickCount: args.clickCount ?? 1,
      });
      return { ok: true };
    } catch (err) {
      return toolError(err);
    }
  }

  async browserMouseMove(args: { surfaceId: string; x: number; y: number; steps?: number }): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.sendDebuggerCommand(args.surfaceId, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: args.x,
        y: args.y,
        button: 'none',
      });
      return { ok: true };
    } catch (err) {
      return toolError(err);
    }
  }

  async browserDrag(args: { surfaceId: string; fromX: number; fromY: number; toX: number; toY: number }): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.sendDebuggerCommand(args.surfaceId, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: args.fromX,
        y: args.fromY,
        button: 'none',
      });
      await this.sendDebuggerCommand(args.surfaceId, 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: args.fromX,
        y: args.fromY,
        button: 'left',
        clickCount: 1,
      });
      await this.sendDebuggerCommand(args.surfaceId, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: args.toX,
        y: args.toY,
        button: 'left',
      });
      await this.sendDebuggerCommand(args.surfaceId, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: args.toX,
        y: args.toY,
        button: 'left',
        clickCount: 1,
      });
      return { ok: true };
    } catch (err) {
      return toolError(err);
    }
  }

  async browserKeyboardType(args: { surfaceId: string; text: string; delay?: number }): Promise<{ ok: boolean; error?: string }> {
    try {
      const e = this.requireEntry(args.surfaceId);
      await e.view.webContents.insertText(args.text);
      return { ok: true };
    } catch (err) {
      return toolError(err);
    }
  }

  async browserKeyboardPress(args: { surfaceId: string; key: string }): Promise<{ ok: boolean; error?: string }> {
    try {
      const key = String(args.key);
      const parts = key.split('+').map(p => p.trim()).filter(Boolean);
      const finalKey = parts.pop() || key;
      const modifiers = parts.map(p => p === 'Control' ? 'Ctrl' : p);
      await this.sendDebuggerCommand(args.surfaceId, 'Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: finalKey,
        windowsVirtualKeyCode: finalKey.length === 1 ? finalKey.toUpperCase().charCodeAt(0) : 0,
        modifiers: this.cdpModifierMask(modifiers),
      });
      await this.sendDebuggerCommand(args.surfaceId, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: finalKey,
        windowsVirtualKeyCode: finalKey.length === 1 ? finalKey.toUpperCase().charCodeAt(0) : 0,
        modifiers: this.cdpModifierMask(modifiers),
      });
      return { ok: true };
    } catch (err) {
      return toolError(err);
    }
  }

  private cdpModifierMask(modifiers: string[]): number {
    let mask = 0;
    for (const mod of modifiers) {
      if (mod === 'Alt') mask |= 1;
      if (mod === 'Ctrl' || mod === 'Control') mask |= 2;
      if (mod === 'Meta' || mod === 'Command') mask |= 4;
      if (mod === 'Shift') mask |= 8;
    }
    return mask;
  }

  destroy(surfaceId: string): void {
    const e = this.views.get(surfaceId);
    if (!e) return;
    this.views.delete(surfaceId);
    try {
      if (e.debuggerAttached) {
        try { e.view.webContents.debugger.detach(); } catch { /* ignore */ }
      }
      const win = BrowserWindow.fromId(e.workspaceWindowId);
      if (win) {
        try { win.removeBrowserView(e.view); } catch { /* ignore */ }
        try { if (win.isFocused()) win.webContents.focus(); } catch { /* ignore */ }
      }
      try { e.view.webContents.removeAllListeners(); } catch { /* ignore */ }
      try { (e.view.webContents as any).forcefullyCrashRenderer?.(); } catch { /* ignore */ }
      try { (e.view.webContents as any).destroy?.(); } catch { /* ignore */ }
    } catch (err: any) {
      cliLogger.warn('BROWSER_VIEW', `destroy surface=${surfaceId} 部分清理失败: ${err?.message}`);
    }
  }

  destroyAll(): void {
    for (const id of [...this.views.keys()]) this.destroy(id);
  }
}

let instance: BrowserViewManager | null = null;
export function getBrowserViewManager(): BrowserViewManager {
  if (!instance) instance = new BrowserViewManager();
  return instance;
}
