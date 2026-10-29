
import path from 'node:path';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { getWorkspaceRootFromContext } from '@neoxlabs/kernel/tools/workspaceContext.js';
import { getBrowserSession } from './browserSession.js';
import { getBrowserManager } from './browserManager.js';
import { findChromeExecutable, resolveProfileDir, resolveProxyFromEnv, DEFAULT_CHROME_ARGS, browserBrandOf } from './chromeLauncher.js';
import { readDailyLoginsConfig, syncDailyLogins } from './dailyLogins.js';

const TAG = 'HOSTED_CHROME';

export type BrowserControlOp = 'status' | 'ensure' | 'shutdown' | 'focus';

export interface BrowserControlResult {
  ok: boolean;
  running: boolean;
  browser: string;
  executable?: string | null;
  userDataDir?: string | null;
  error?: string;
}

/** 桌面宿主标记 —— 由宿主在创建 runtime 前设置, worker 继承。 */
export function isDesktopBrowserHost(): boolean {
  return process.env.NEOX_BROWSER_HOST === 'desktop';
}

let consentResolver: (() => Promise<boolean>) | null = null;

export function setDailyLoginsConsentResolver(fn: (() => Promise<boolean>) | null): void {
  consentResolver = fn;
}

async function resolveReuseLogins(): Promise<boolean> {
  if (consentResolver) {
    try { return (await consentResolver()) === true; } catch { return false; }
  }
  return readDailyLoginsConfig().reuseDailyLogins === true;
}

function sameDir(a?: string, b?: string): boolean {
  if (!a || !b) return !a && !b;
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

class HostedChrome {
  private installed = false;
  private defaultWorkspace: string | undefined;
  private currentWorkspace: string | undefined;
  private currentExecutable: string | null = null;
  private currentUserDataDir: string | null = null;
  private ensurePromise: Promise<void> | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private generation = 0;
  private readonly webSurfaceOpens = new Map<string, Promise<void>>();

  /** 装到本线程的 BrowserSession 上。幂等。 */
  install(opts: { workDir?: string } = {}): void {
    if (opts.workDir) this.defaultWorkspace = opts.workDir;
    if (this.installed) return;
    this.installed = true;
    const session = getBrowserSession();
    session.registerLauncher(() => this.ensure());
    session.on((ev) => {
      if (ev.type === 'surface:open') {
        void this.openWebSurface(ev.surfaceId, ev.url).catch((err: any) =>
          cliLogger.warn(TAG, `surface:open failed: ${err?.message ?? err}`));
      }
      /* session:close 故意不关 Chrome —— 用户定的: 一轮结束保活, 复用登录态和页面
       * (agent 用 browser_close_surface / 用户点卡片「关闭」才关)。 */
    });
    cliLogger.info(TAG, `installed (workspace=${this.defaultWorkspace ?? '-'})`);
  }

  isRunning(): boolean {
    return getBrowserManager().hasOwnedContext();
  }

  status(): BrowserControlResult {
    const executable = this.currentExecutable ?? findChromeExecutable();
    return {
      ok: true,
      running: this.isRunning(),
      browser: browserBrandOf(executable),
      executable: this.currentExecutable,
      userDataDir: this.currentUserDataDir,
    };
  }

  /** 幂等启动: 已在就返; 项目变了关旧起新 (profile 按项目隔离)。 */
  async ensure(workspacePath?: string): Promise<void> {
    if (this.shutdownPromise) await this.shutdownPromise;
    const workspace = workspacePath ?? getWorkspaceRootFromContext() ?? this.defaultWorkspace;
    if (this.ensurePromise) {
      await this.ensurePromise;
      return this.ensure(workspace);
    }
    if (this.isRunning() && !sameDir(this.currentWorkspace, workspace)) {
      cliLogger.info(TAG, `workspace 切换 (${this.currentWorkspace} → ${workspace}), 重启 Chrome`);
      await this.shutdown();
      return this.ensure(workspace);
    }
    if (this.isRunning()) return;

    const generation = this.generation;
    this.ensurePromise = (async () => {
      const executable = findChromeExecutable();
      if (!executable) {
        throw new Error('Chrome/Chromium/Edge/Brave not found. 请安装 Google Chrome (推荐), 或用 NEOX_CHROME_PATH 指定浏览器可执行文件路径.');
      }
      const profileDir = resolveProfileDir(workspace);
      const proxy = resolveProxyFromEnv();
      const reuseLogins = await resolveReuseLogins();
      if (generation !== this.generation) throw new Error('Chrome startup cancelled by shutdown');
      cliLogger.info(TAG, `launching Chrome · profile=${profileDir} · proxy=${proxy?.server ?? 'system-default'} · dailyLogins=${reuseLogins}`);
      const manager = getBrowserManager();
      await manager.launchOwned({
        executablePath: executable,
        profileDir,
        args: DEFAULT_CHROME_ARGS,
        proxy: proxy ?? undefined,
        realKeychain: reuseLogins,
        prepareProfile: reuseLogins ? (reservedDir) => {
          const r = syncDailyLogins({
            executablePath: executable,
            agentProfileDir: reservedDir,
            config: { ...readDailyLoginsConfig(), reuseDailyLogins: true },
          });
          if (!r.ok) cliLogger.warn(TAG, `daily sign-ins not synced: ${r.reason}`);
        } : undefined,
        onClosed: () => {
          cliLogger.info(TAG, 'Chrome closed (context close event)');
          this.currentExecutable = null;
          this.currentUserDataDir = null;
          this.webSurfaceOpens.clear();
        },
      });
      if (generation !== this.generation) throw new Error('Chrome startup cancelled by shutdown');
      const userDataDir = manager.getOwnedProfileDir();
      if (!userDataDir) throw new Error('Chrome closed before startup completed');
      this.currentWorkspace = workspace;
      this.currentExecutable = executable;
      this.currentUserDataDir = userDataDir;
      cliLogger.info(TAG, `Chrome ready · profile=${userDataDir}`);
      /* 起完提到前台 —— 否则窗口压在用户自己的 Chrome 后面, 用户看不见 agent 在干什么。
       * 只在启动这一次, 后续每步不抢焦点。 */
      await manager.bringOwnedToFront().catch(() => {});
    })().finally(() => {
      this.ensurePromise = null;
    });
    return this.ensurePromise;
  }

  /** open_surface({kind:'web'}) 的落地: 确保 Chrome 在, 按 surfaceId 建 tab + goto。同一个 surface 只开一次。 */
  openWebSurface(surfaceId: string, url: string): Promise<void> {
    const inflight = this.webSurfaceOpens.get(surfaceId);
    if (inflight) return inflight;
    const task = (async () => {
      await this.ensure();
      await getBrowserManager().resolvePage(surfaceId, { createIfMissing: true, initialUrl: url });
    })();
    this.webSurfaceOpens.set(surfaceId, task);
    task.catch(() => this.webSurfaceOpens.delete(surfaceId));
    return task;
  }

  async focus(): Promise<void> {
    if (this.isRunning()) await getBrowserManager().bringOwnedToFront().catch(() => {});
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.generation++;
    this.webSurfaceOpens.clear();
    const pendingEnsure = this.ensurePromise;
    this.shutdownPromise = (async () => {
      await getBrowserManager().disconnect();
      await pendingEnsure?.catch(() => {});
      this.currentWorkspace = undefined;
      this.currentExecutable = null;
      this.currentUserDataDir = null;
      getBrowserSession().reset();
      cliLogger.info(TAG, 'Chrome shut down');
    })().finally(() => {
      this.shutdownPromise = null;
    });
    return this.shutdownPromise;
  }

  /** 宿主 UI (外置 Chrome 卡片 / browser-tool IPC) 的统一入口 —— 经 runtime bridge 调到这里。 */
  async control(op: BrowserControlOp, opts: { workspacePath?: string } = {}): Promise<BrowserControlResult> {
    try {
      if (op === 'ensure') await this.ensure(opts.workspacePath);
      else if (op === 'shutdown') await this.shutdown();
      else if (op === 'focus') await this.focus();
      return this.status();
    } catch (err: any) {
      return { ...this.status(), ok: false, error: String(err?.message ?? err) };
    }
  }
}

let instance: HostedChrome | null = null;
export function getHostedChrome(): HostedChrome {
  if (!instance) instance = new HostedChrome();
  return instance;
}

/**
 * 桌面端两个 runtime 入口 (worker: runtimeWorkerEntry / 进程内: localRuntimeAdapter) 建好 bridge
 * 后调一次: 桌面宿主下把 Chrome 装到本线程, 并给 bridge 挂上 browserControl (宿主 UI 经它操作)。
 * CLI 没设 NEOX_BROWSER_HOST, 不装, 照旧默认启动器。
 */
export function attachHostedChrome(bridge: { browserControl?: unknown }, workDir: string): void {
  if (!isDesktopBrowserHost()) return;
  const chrome = getHostedChrome();
  chrome.install({ workDir });
  bridge.browserControl = (op: BrowserControlOp, opts?: { workspacePath?: string }) => chrome.control(op, opts ?? {});
}
