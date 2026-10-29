import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

/** 实际拉起的浏览器 —— 渲染层用它挑真 brand logo / 文案里的名字。
 *  查找顺序见 findChromeExecutable(), 命中哪个就是哪个, 不是永远 Chrome。 */
export type BrowserBrand = 'chrome' | 'chromium' | 'brave' | 'edge';

export function browserBrandOf(executable: string | null | undefined): BrowserBrand {
  const p = (executable || '').toLowerCase();
  if (p.includes('msedge') || p.includes('microsoft edge')) return 'edge';
  if (p.includes('brave')) return 'brave';
  if (p.includes('chromium')) return 'chromium';
  return 'chrome';
}

/** 定位 Chrome/Chromium 可执行文件 */
export function findChromeExecutable(): string | null {
  const platform = process.platform;

  /* env 显式覆盖优先 —— 自定义安装目录 / 便携版 Chrome 不在候选列表时,
   * 用户可用 NEOX_CHROME_PATH 指定 (win/mac/linux 通用)。 */
  const envOverride = process.env['NEOX_CHROME_PATH'];
  if (envOverride) {
    try {
      if (fs.statSync(envOverride).isFile()) return envOverride;
    } catch { /* 无效路径, 继续候选探测 */ }
  }

  const candidates: string[] = [];

  if (platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      /* Microsoft Edge 也是 Chromium 内核, 走 CDP 一样 */
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    );
  } else if (platform === 'win32') {
    /* 常见安装位置; LOCALAPPDATA/PROGRAMFILES 都可能有 */
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pfx86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const lad = process.env['LOCALAPPDATA'] || path.join(os.homedir(), 'AppData', 'Local');
    candidates.push(
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pfx86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(lad, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pfx86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'Chromium', 'Application', 'chrome.exe'),
    );
  } else {
    /* Linux: 常见路径 */
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    );
  }

  for (const c of candidates) {
    try {
      const st = fs.statSync(c);
      if (st.isFile()) return c;
    } catch { /* not found, next */ }
  }
  return null;
}

/* Playwright 默认参数已含 --no-first-run / --no-default-browser-check / --enable-automation
 * (顶部原生黄条 "受自动测试软件控制" — 给用户权威信号). 这里只追加差异项. */
export const DEFAULT_CHROME_ARGS = [
  /* navigator.webdriver 隐藏 — Cloudflare 之类检测到 automation 会拒服务,
   * agent 场景经常要正常访问这些站点. */
  '--disable-blink-features=AutomationControlled',
  '--test-type',
  /* 显式窗口尺寸/位置, 避免 Chrome 开在屏幕外 / 极小尺寸 (用户"看不到"). */
  '--window-size=1440,900',
  '--window-position=140,120',
];

export function resolveProxyFromEnv(): { server: string; bypass: string } | null {
  const env = process.env;
  const server = env.NEOX_BROWSER_PROXY
    || env.HTTPS_PROXY || env.https_proxy
    || env.HTTP_PROXY || env.http_proxy
    || env.ALL_PROXY || env.all_proxy;
  if (!server) return null;
  const extra = (env.NO_PROXY || env.no_proxy || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const bypass = ['localhost', '127.0.0.1', '<local>', ...extra].join(',');
  return { server, bypass };
}

function profileRoot(): string {
  // Desktop sets this before creating workers; CLI/SDK have their own namespace.
  const namespace = process.env.NEOX_BROWSER_PROFILE_NAMESPACE || 'standalone';
  const safeNamespace = /^[a-zA-Z0-9_-]{1,100}$/.test(namespace)
    ? namespace
    : createHash('sha256').update(namespace).digest('hex').slice(0, 20);
  return path.join(os.homedir(), NEOX_HOME_DIRNAME, 'chrome-profiles', 'v2', safeNamespace);
}

/** Stable channel/workspace profile. Never reuse a legacy pipe-owned directory. */
export function resolveProfileDir(workspacePath?: string): string {
  const base = profileRoot();
  if (!workspacePath) return path.join(base, 'default');
  const canonical = path.resolve(workspacePath);
  const slug = path.basename(canonical)
    .replace(/[^a-zA-Z0-9_\-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'workspace';
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  return path.join(base, `${slug}-${hash}`);
}

export function resolveAgentProfileDir(): string {
  return path.join(profileRoot(), 'agent');
}
