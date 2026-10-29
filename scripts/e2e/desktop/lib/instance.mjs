/**
 * 桌面端 E2E 实例: 起一个隔离的 Electron 开发实例, 全部端口固定, 收尾时连同 vite 一起收掉。
 *
 * 端口固定 (而不是随机) 是为了排障时能直接拿 scripts/app-ui.mjs --port 41811 接上去看现场;
 * 三个端口都不同意再换 —— 换端口会让「复现同一个现场」变成碰运气。
 *
 * 隔离方式:
 * - NEOX_HOME_DIRNAME=.neox-e2e → 会话库 / 设置 / 技能落在 ~/.neox-e2e, 跑完删掉
 * - --user-data-dir=~/.neox-e2e/userdata → 独立的单实例锁与登录态目录, 不会踢掉用户开着的客户端
 * - 登录态从 ~/Library/Application Support/Neox 复制 auth.enc / gateway-key.enc / machine-id
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const REPO_ROOT = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const require = createRequire(join(REPO_ROOT, 'packages/core/package.json'));
const { chromium } = require('playwright-core');

const ELECTRON_BIN = join(REPO_ROOT, 'node_modules/.bin/electron');
const VITE_BIN = join(REPO_ROOT, 'node_modules/.bin/vite');
const MAIN_JS = join(REPO_ROOT, 'apps/cli/dist/ui-electron/electron/main.js');
const DESKTOP_USERDATA = join(homedir(), 'Library/Application Support/Neox');

/* 默认端口固定 —— 见文件头。
 * E2E_* 环境变量只在**同一台机器上并行跑两个实例**时用 (另一个会话可能已经占着默认端口);
 * 不设就仍是 5191 / 4511 / 41811, 排障脚本照常能接上。 */
const portFromEnv = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
export const PORTS = {
  vite: portFromEnv('E2E_VITE_PORT', 5191),
  server: portFromEnv('E2E_SERVER_PORT', 4511),
  cdp: portFromEnv('E2E_CDP_PORT', 41811),
};
export const HOME_DIRNAME = process.env.E2E_HOME_DIRNAME || '.neox-e2e';
export const HOME_DIR = join(homedir(), HOME_DIRNAME);

export function killTree(child, signal = 'SIGTERM') {
  if (!child || child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* 已经退了 */
    }
  }
}

async function portFree(port) {
  return new Promise((res) => {
    const srv = createServer();
    srv.once('error', () => res(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => res(true)));
  });
}

async function assertPortsFree() {
  for (const [what, port] of Object.entries(PORTS)) {
    if (!(await portFree(port))) {
      throw new Error(
        `端口 ${port} (${what}) 被占用 —— 先关掉占用者再跑。` +
          `查: lsof -iTCP:${port} -sTCP:LISTEN -n -P`,
      );
    }
  }
}

async function waitHttp(url, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
      lastErr = `HTTP ${res.status}`;
    } catch (e) {
      lastErr = e.message;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${what} 未就绪 (${url}): ${lastErr}`);
}

async function connectApp(cdpUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      const browser = await chromium.connectOverCDP(cdpUrl);
      const pages = browser.contexts().flatMap((c) => c.pages());
      if (pages.length > 0) return { browser, pages };
      await browser.close();
      lastErr = '没有页面';
    } catch (e) {
      lastErr = e.message;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`连不上 CDP (${cdpUrl}): ${lastErr}`);
}

/** 主窗口页面: 排除覆盖层 (桌宠 / 语音球 / 悬浮窗) */
function pickMainPage(pages) {
  return pages.find((p) => !/overlay|pet|float|call\.html/i.test(p.url()));
}

const SHELL_SEL = '.neox-mode-seg__btn';
const TOUR_DONE_KEY = 'neox-tour-shell-v1-done';

/**
 * 把实例推进到主界面。
 * 新 home 首启会停在引导页, 引导页的「完成」要写设置库; 直接调 preload 的开关最快。
 * 单次 IPC 偶尔赶在设置库初始化前, 所以重试几轮, 最后退回点 UI 走完引导。
 */
async function settleIntoShell(page) {
  const hasShell = () =>
    page.evaluate(() => !!document.querySelector('.neox-mode-seg__btn')).catch(() => false);

  for (let attempt = 0; attempt < 4; attempt++) {
    if (await hasShell()) return;
    /* 首屏还没渲染完时 innerText 是空的, 不能据此判断「没有引导页」 */
    await page
      .waitForFunction(
        () => !!document.querySelector('.neox-mode-seg__btn') || document.body.innerText.trim().length > 0,
        undefined,
        { timeout: 20_000 },
      )
      .catch(() => {});
    if (await hasShell()) return;

    const marked = await page
      .evaluate(async () => {
        try {
          await window.neox.setOnboardingCompleted(true);
          return true;
        } catch {
          return false;
        }
      })
      .catch(() => false);

    if (marked) {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector(SHELL_SEL, { timeout: 25_000 }).catch(() => {});
      if (await hasShell()) return;
    } else {
      await walkThroughOnboarding(page);
    }
    await page.waitForTimeout(800);
  }
  const body = await page.evaluate(() => document.body.innerText).catch(() => '');
  throw new Error(`实例没进到主界面 (停在: ${body.trim().slice(0, 200) || '空白页'})`);
}

/** 兜底: 按引导页真实步骤点一遍 (用途 → 模型 → 开始使用) */
async function walkThroughOnboarding(page) {
  await page.getByText('工作', { exact: true }).first().click({ timeout: 5_000 }).catch(() => {});
  await page.getByRole('button', { name: '下一步' }).click({ timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(600);
  await page.getByText('用订阅', { exact: false }).first().click({ timeout: 5_000 }).catch(() => {});
  await page.getByRole('button', { name: '开始使用' }).click({ timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(1_500);
}

/** 首次进入主界面 900ms 后会弹 3 步导览, 它盖住侧栏和设置; 用 localStorage 标记跳过 */
async function suppressTour(page) {
  const already = await page
    .evaluate((key) => {
      try {
        return localStorage.getItem(key) === '1';
      } catch {
        return false;
      }
    }, TOUR_DONE_KEY)
    .catch(() => false);
  if (already) return;
  await page
    .evaluate((key) => {
      try {
        localStorage.setItem(key, '1');
      } catch {
        /* 隐私模式写不了, 后面靠点「跳过」兜底 */
      }
    }, TOUR_DONE_KEY)
    .catch(() => {});
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector(SHELL_SEL, { timeout: 25_000 });
}

/**
 * 起实例。onboarding 是否已经走完由调用方判断 (见 waitForReady)。
 * @param {{ cleanHome?: boolean, keepHome?: boolean }} opts
 */
export async function launchInstance(opts = {}) {
  if (!existsSync(MAIN_JS)) throw new Error(`缺少 ${MAIN_JS}; 先跑 \`npm run ui:build-electron\``);
  if (!existsSync(ELECTRON_BIN) || !existsSync(VITE_BIN)) {
    throw new Error('缺少 electron / vite 可执行文件, 先跑 `npm install`');
  }
  await assertPortsFree();

  const userDataDir = join(HOME_DIR, 'userdata');
  if (opts.cleanHome !== false) await rm(HOME_DIR, { recursive: true, force: true });
  await mkdir(userDataDir, { recursive: true });
  /* 登录态: 三个文件缺一个都解不开 (key 由 machine-id 派生) */
  for (const file of ['auth.enc', 'gateway-key.enc', 'machine-id']) {
    await copyFile(join(DESKTOP_USERDATA, file), join(userDataDir, file)).catch(() => {});
  }

  const logs = [];
  let vite;
  let electron;
  let browser;

  const env = {
    ...process.env,
    NODE_ENV: 'development',
    NEOX_HOME_DIRNAME: HOME_DIRNAME,
    NEOX_SERVER_PORT: String(PORTS.server),
    NEOX_CDP_PORT: String(PORTS.cdp),
    NEOX_ENABLE_CDP: '1',
    NEOX_SKIP_ANTI_DEBUG: '1',
    NEOX_DEV_ALLOW: '1',
    NEOX_OS_NOTIFICATIONS: 'off',
    /* 不以用户的设备身份配对手机 / 上传会话索引 (10-18 第一遍跑往手机传了 48 条测试会话) */
    NEOX_DISABLE_MOBILE_BRIDGE: '1',
    NEOX_LANGUAGE: 'zh-CN',
    VITE_DEV_SERVER_URL: `http://127.0.0.1:${PORTS.vite}`,
  };
  /* 本机代理会吞掉 localhost 的请求 */
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
    delete env[k];
  }

  const stop = async () => {
    try {
      await browser?.close();
    } catch {
      /* CDP 断开即可 */
    }
    killTree(electron);
    killTree(vite);
    await new Promise((r) => setTimeout(r, 800));
    killTree(electron, 'SIGKILL');
    killTree(vite, 'SIGKILL');
    if (!opts.keepHome) await rm(HOME_DIR, { recursive: true, force: true }).catch(() => {});
  };

  try {
    vite = spawn(VITE_BIN, ['--config', 'vite.config.ui.ts', '--port', String(PORTS.vite), '--strictPort'], {
      cwd: REPO_ROOT,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    vite.stdout?.on('data', (d) => logs.push(String(d)));
    vite.stderr?.on('data', (d) => logs.push(String(d)));
    await waitHttp(`http://127.0.0.1:${PORTS.vite}/`, 120_000, 'vite dev server');

    electron = spawn(ELECTRON_BIN, [`--user-data-dir=${userDataDir}`, MAIN_JS], {
      cwd: REPO_ROOT,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    electron.stdout?.on('data', (d) => logs.push(String(d)));
    electron.stderr?.on('data', (d) => logs.push(String(d)));

    const cdpUrl = `http://127.0.0.1:${PORTS.cdp}`;
    await waitHttp(`${cdpUrl}/json/version`, 120_000, 'electron CDP');
    const conn = await connectApp(cdpUrl, 30_000);
    browser = conn.browser;
    const page = pickMainPage(conn.pages);
    if (!page) throw new Error('没找到主窗口页面');

    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await settleIntoShell(page);
    await suppressTour(page);
    return {
      page,
      browser,
      pages: conn.pages,
      cdpUrl,
      homeDir: HOME_DIR,
      logs: () => logs.join('').split('\n').slice(-60).join('\n'),
      stop,
    };
  } catch (err) {
    await stop();
    throw new Error(`${err.message}\n--- 实例日志(尾部) ---\n${logs.join('').split('\n').slice(-40).join('\n')}`);
  }
}
