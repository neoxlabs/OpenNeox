
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { getOrAttachCapture } from './browserCapture.js';
import { getBrowserHostController } from './browserHostController.js';
import {
  DEFAULT_CHROME_ARGS,
  findChromeExecutable,
  resolveAgentProfileDir,
  resolveProxyFromEnv,
} from './chromeLauncher.js';
import { hasDailyLoginsMarker } from './dailyLogins.js';
import { installBrowserTakeover } from './browserTakeoverController.js';
import { getBrowserSession } from './browserSession.js';
import { acquireBrowserProfile, isBrowserProfileConflict } from './browserProfileLease.js';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

/* 接管视觉的公开出口 —— desktop 的 externalChromeManager 跟这里是同一份脚本的两个使用者,
 * 但 runtime/browser/agentTakeoverBanner.js 是内部路径 (包边界闸的深引棘轮盯着)。
 * 从 browserManager 这个已公开的入口再导出, 外部包不必钻进内部实现。改视觉仍只改那一处。 */
export {
  AGENT_TAKEOVER_BANNER_SCRIPT,
  bannerSetDetailExpr,
  bannerSetActiveExpr,
  bannerSetLabelExpr,
  TAKEOVER_GUARD_PAUSE_EXPR,
} from './agentTakeoverBanner.js';

/* page.evaluate(() => window.xxx) 的回调被 Playwright 序列化送到浏览器执行,
 * 浏览器侧有 window/localStorage, 但 server 是 Node 没 DOM lib. 这里 ambient 让 tsc 闭嘴. */
declare const window: any;

export interface LaunchOwnedOptions {
  /** Chrome/Chromium/Edge/Brave 可执行文件绝对路径. */
  executablePath: string;
  /** persistent profile 目录 (登录态保留在这). */
  profileDir: string;
  /** 追加启动参数 (Playwright 默认参数之外). */
  args?: string[];
  /** context 级注入脚本 — 每个 page 每次导航都会跑 (banner 之类). 在任何页面创建前装上. */
  initScripts?: string[];
  /** 代理 — Playwright 独立 profile 不带用户浏览器的代理配置, 上层从 env 解析透传.
   *  不传则 Chrome 用系统代理设置 (macOS 系统代理开着时天然可用). */
  proxy?: { server: string; bypass?: string };
  realKeychain?: boolean;
  /** Runs only after Chrome has opened and cleanly closed the reserved profile. */
  prepareProfile?: (profileDir: string) => void | Promise<void>;
  /** Chrome 进程死了 / 用户手动关窗口时回调 — 上层清 UI 状态用. */
  onClosed?: () => void;
}

type BackendState =
  | { kind: 'owned'; context: BrowserContext; profileDir: string }
  | { kind: 'attached'; browser: Browser };

class BrowserManager {
  private backend: BackendState | null = null;
  /** surfaceId → Page 映射. cache 持续到 page.isClosed(). */
  private pages = new Map<string, Page>();
  private connectPromise: Promise<void> | null = null;
  private launchPromise: Promise<BrowserContext> | null = null;
  private disconnectPromise: Promise<void> | null = null;
  private lifecycleGeneration = 0;
  private preferredProfiles = new Map<string, string>();
  /** 最近一次 connect 失败的真实错误（透传给 hint, 便于诊断浏览器后端为何起不来）. */
  lastConnectError: string | null = null;

  /* ────────────────────────────── OWNED ────────────────────────────── */

  /**
   * 启动并拥有一个 Chrome (launchPersistentContext). 幂等 — 已在跑直接返.
   * desktop externalChromeManager 通过 BrowserSession launcher 调这里.
   */
  async launchOwned(opts: LaunchOwnedOptions): Promise<BrowserContext> {
    if (this.disconnectPromise) await this.disconnectPromise;
    const owned = this.ownedContext();
    if (owned) return owned;
    if (this.launchPromise) return this.launchPromise;

    const generation = this.lifecycleGeneration;
    const assertLaunching = () => {
      if (generation !== this.lifecycleGeneration) throw new Error('Browser launch cancelled by shutdown');
    };
    this.launchPromise = (async () => {
      const { chromium } = await import('playwright-core');
      assertLaunching();
      const baseDir = resolve(opts.profileDir);
      const excluded = new Set<string>();
      const launchOnce = (profileDir: string) => chromium.launchPersistentContext(profileDir, {
        executablePath: opts.executablePath,
        headless: false,
        /* viewport:null = 用真实窗口尺寸, 不做 1280x720 viewport 仿真 — 用户看到的
         * 窗口和 agent 操作的 viewport 必须是同一个. */
        viewport: null,
        args: opts.args ?? [],
        ...(opts.realKeychain || hasDailyLoginsMarker(profileDir)
          ? { ignoreDefaultArgs: ['--use-mock-keychain'] } : {}),
        proxy: opts.proxy,
        /* Playwright 默认加 --no-sandbox, 这是用户自己看的真窗口: 顶部会常驻
         * "unsupported command-line flag" 警告条, 也白白关掉了渲染进程沙箱. */
        chromiumSandbox: true,
        /* Electron 主进程里跑 — 进程退出流程自己管, 不让 Playwright 抢 signal. */
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
      });
      for (let attempt = 0; attempt < 4; attempt++) {
        assertLaunching();
        // After repeated native-lock conflicts (e.g. old Windows launchers),
        // use a fresh persistent slot instead of walking an unbounded pool.
        const preferred = attempt === 3
          ? `${baseDir}-instance-${randomUUID()}`
          : this.preferredProfiles.get(baseDir);
        const lease = acquireBrowserProfile(baseDir, preferred, excluded);
        const profileDir = lease.profileDir;
        let context: BrowserContext | undefined;
        let initializing = true;
        let closed = false;
        let preparing = false;
        try {
          cliLogger.info('BROWSER_MGR', `launchPersistentContext exec=${opts.executablePath} profile=${profileDir}`);
          context = await launchOnce(profileDir);
          assertLaunching();
          if (opts.prepareProfile) {
            // Native Chrome locking is the final availability check, including
            // Windows. Never copy cookies before successfully owning the profile.
            await context.close();
            context = undefined;
            assertLaunching();
            preparing = true;
            await opts.prepareProfile(profileDir);
            preparing = false;
            assertLaunching();
            context = await launchOnce(profileDir);
            assertLaunching();
          }
          const ownedContext = context;
          context.on('close', () => {
            closed = true;
            if (!initializing) lease.release();
            if (this.backend?.kind === 'owned' && this.backend.context === ownedContext) {
              this.backend = null;
              this.pages.clear();
              cliLogger.info('BROWSER_MGR', 'owned Chrome closed');
              try { opts.onClosed?.(); } catch { /* ignore */ }
            }
          });
          for (const script of opts.initScripts ?? []) {
            await context.addInitScript({ content: script }).catch((e: any) =>
              cliLogger.warn('BROWSER_MGR', `addInitScript failed: ${e?.message}`));
          }
          await installBrowserTakeover(context);
          assertLaunching();
          if (closed || context.browser()?.isConnected() === false) {
            throw new Error('Browser closed during initialization');
          }
          this.backend = { kind: 'owned', context, profileDir };
          this.preferredProfiles.set(baseDir, profileDir);
          initializing = false;
          cliLogger.info('BROWSER_MGR', `owned Chrome ready · ${context.pages().length} initial page(s) · profile=${profileDir}`);
          return context;
        } catch (error) {
          await context?.close().catch(() => {});
          lease.release();
          assertLaunching();
          if (preparing || !isBrowserProfileConflict(error) || attempt === 3) throw error;
          excluded.add(profileDir);
          cliLogger.warn('BROWSER_MGR', `profile occupied; preserving its owner and choosing another profile: ${profileDir}`);
        }
      }
      throw new Error('Unable to launch an owned browser');
    })().finally(() => {
      this.launchPromise = null;
    });

    return this.launchPromise;
  }

  hasOwnedContext(): boolean {
    return this.ownedContext() !== null;
  }

  getOwnedProfileDir(): string | null {
    return this.backend?.kind === 'owned' ? this.backend.profileDir : null;
  }

  getPreferredProfileDir(baseDir: string): string {
    return this.preferredProfiles.get(resolve(baseDir)) ?? resolve(baseDir);
  }

  private ownedContext(): BrowserContext | null {
    if (this.backend?.kind !== 'owned') return null;
    const ctx = this.backend.context;
    /* browser() 断了说明 Chrome 死了但 close 事件还没到 — 视为不在. */
    const b = ctx.browser();
    if (b && !b.isConnected()) return null;
    return ctx;
  }

  /* ───────────────────────────── connect ───────────────────────────── */

  /**
   * 保证有可用后端. 幂等.
   * 顺序: OWNED 活着 → 返; 有 launcher → 让它 launchOwned; 显式 env 端口 → attach; 都没有 → throw.
   */
  async connect(): Promise<void> {
    if (this.disconnectPromise) await this.disconnectPromise;
    if (this.isConnected()) return;
    if (this.connectPromise) return this.connectPromise;
    const generation = this.lifecycleGeneration;

    /* launcher 优先于 env attach — dev 模式 Electron 自己也会设 NEOX_BROWSER_CDP_PORT
     * (指向 Neox 自身), 若先走 env 就会把 Neox 窗口当浏览器操控. launcher 在
     * external 模式下总是注册的, 保证这里先起真 Chrome. */
    const { getBrowserSession } = await import('./browserSession.js');
    if (generation !== this.lifecycleGeneration) throw new Error('Browser connection cancelled by shutdown');
    const session = getBrowserSession();
    if (session.hasLauncher()) {
      await session.ensureLaunched(); /* → externalChromeManager.ensure → launchOwned */
      if (this.isConnected()) return;
      throw new Error('浏览器启动器跑完了但没有可用后端 — 看 EXTERNAL_CHROME 日志');
    }

    const port = process.env.NEOX_BROWSER_CDP_PORT;
    if (port) {
      this.connectPromise = (async () => {
        try {
          const { chromium } = await import('playwright-core');
          const endpointURL = `http://127.0.0.1:${port}`;
          try {
            const ver = await fetch(`${endpointURL}/json/version`).then(r => r.json()) as { 'User-Agent'?: string };
            if (/Electron/i.test(ver?.['User-Agent'] || '')) {
              throw new Error(`NEOX_BROWSER_CDP_PORT=${port} 指向的是 Neox/Electron 自己, 不是浏览器 — 拒绝附加 (清掉这个 env 或指向真 Chrome 的调试端口)`);
            }
          } catch (probeErr: any) {
            if (/Electron 自己/.test(probeErr?.message || '')) throw probeErr;
            /* 探测失败 (老浏览器无该端点等) 不拦 — connectOverCDP 自己会报 */
          }
          cliLogger.info('BROWSER_MGR', `connectOverCDP ${endpointURL}`);
          const browser = await chromium.connectOverCDP(endpointURL);
          if (generation !== this.lifecycleGeneration) {
            await browser.close().catch(() => {});
            throw new Error('Browser connection cancelled by shutdown');
          }
          this.backend = { kind: 'attached', browser };
          const ctxs = browser.contexts();
          const totalPages = ctxs.reduce((n, c) => n + c.pages().length, 0);
          cliLogger.info('BROWSER_MGR', `attached, ${ctxs.length} context(s), ${totalPages} page(s) total`);
        } catch (err: any) {
          cliLogger.warn('BROWSER_MGR', `attach failed: ${err?.message}`);
          this.backend = null;
          throw err;
        } finally {
          this.connectPromise = null;
        }
      })();
      return this.connectPromise;
    }

    await this.launchOwnedDefault();
    if (this.isConnected()) return;
    throw new Error('没有浏览器后端: 未注册 launcher 且 NEOX_BROWSER_CDP_PORT 未设置');
  }

  /**
   * 内置默认启动器: 探测 Chrome 可执行文件 + 独立 agent profile, launchOwned 自启.
   * 幂等 (launchOwned 内部已去重). 自启成功后挂 session:close → disconnect, 让
   * turn 结束时自动关 Chrome (对齐 desktop externalChromeManager 的生命周期).
   */
  private async launchOwnedDefault(): Promise<void> {
    if (this.isConnected()) return;
    const executable = findChromeExecutable();
    if (!executable) {
      cliLogger.warn('BROWSER_MGR', '默认启动器: 未找到 Chrome/Chromium/Edge/Brave');
      throw new Error(
        'Chrome/Chromium/Edge/Brave not found. 请安装 Google Chrome (推荐), 或用 NEOX_CHROME_PATH 指定浏览器可执行文件路径.',
      );
    }
    const profileDir = resolveAgentProfileDir();
    const proxy = resolveProxyFromEnv();
    cliLogger.info('BROWSER_MGR', `默认启动器: exec=${executable} profile=${profileDir}`);
    const generation = this.lifecycleGeneration;
    const { syncDailyLogins, readDailyLoginsConfig } = await import('./dailyLogins.js');
    if (generation !== this.lifecycleGeneration) throw new Error('Browser launch cancelled by shutdown');
    const cfg = readDailyLoginsConfig();
    /* launchOwned 统一安装控制层，桌面与默认启动器共享状态同步。 */
    await this.launchOwned({
      executablePath: executable,
      profileDir,
      args: DEFAULT_CHROME_ARGS,
      proxy: proxy ?? undefined,
      realKeychain: !!cfg.reuseDailyLogins,
      prepareProfile: cfg.reuseDailyLogins ? (reservedDir) => {
        try {
          const r = syncDailyLogins({ executablePath: executable, agentProfileDir: reservedDir, config: cfg });
          if (!r.ok) cliLogger.warn('BROWSER_MGR', `日常登录态没带上: ${r.reason}`);
        } catch (err: any) {
          cliLogger.warn('BROWSER_MGR', `日常登录态同步出错: ${err?.message || err}`);
        }
      } : undefined,
      onClosed: () => this.onOwnedChromeClosed(),
    });
    this.ensureAutoLifecycle();
    /* Only on launch: pulling it forward on every step would keep stealing focus. */
    await this.bringOwnedToFront();
  }

  /**
   * Bring the agent's own Chrome window forward.
   *
   * On macOS this has to target the process, not the app: `open -a "Google Chrome.app"`
   * resolves to the user's everyday Chrome when it is running and raises *its* windows over
   * the agent's, and launches it with the last session restored when it is not. Either way
   * the user sees their old pages and thinks the agent's browser never opened.
   * The pid comes from CDP (SystemInfo.getProcessInfo), then `lsappinfo setfront` raises
   * exactly that process; no Accessibility permission is needed.
   */
  async bringOwnedToFront(): Promise<void> {
    const ctx = this.ownedContext();
    if (!ctx) return;
    const page = ctx.pages().find(p => !p.isClosed());
    if (page) {
      try {
        const cdp = await ctx.newCDPSession(page);
        const { windowId } = await cdp.send('Browser.getWindowForTarget' as any) as any;
        if (windowId != null) await cdp.send('Browser.setWindowBounds' as any, { windowId, bounds: { windowState: 'normal' } });
        await cdp.send('Page.bringToFront' as any).catch(() => {});
        await cdp.detach().catch(() => {});
      } catch (err: any) {
        cliLogger.warn('BROWSER_MGR', `bringToFront failed: ${err?.message}`);
      }
    }
    if (process.platform !== 'darwin') return;
    try {
      const browserCdp = await ctx.browser()?.newBrowserCDPSession();
      if (!browserCdp) return;
      const info = await browserCdp.send('SystemInfo.getProcessInfo' as any) as { processInfo?: Array<{ type: string; id: number }> };
      await browserCdp.detach().catch(() => {});
      const pid = info.processInfo?.find(p => p.type === 'browser')?.id;
      if (!pid) return;
      const { execFile } = await import('node:child_process');
      const run = (args: string[]) => new Promise<string>((res, rej) =>
        execFile('lsappinfo', args, { timeout: 3000 }, (err, stdout) => err ? rej(err) : res(String(stdout).trim())));
      const asn = await run(['find', `pid=${pid}`]);
      if (asn) await run(['setfront', asn]);
    } catch (err: any) {
      cliLogger.warn('BROWSER_MGR', `activate by pid failed: ${err?.message}`);
    }
  }

  /** 自启 Chrome 被关 (用户手动关窗口 / crash) 时的兜底清理. */
  private onOwnedChromeClosed(): void {
    cliLogger.info('BROWSER_MGR', '默认启动器的 Chrome 已关闭 (context close)');
  }

  /** 自启模式挂一次 session:close → disconnect, turn 结束自动关 Chrome. 幂等. */
  private autoLifecycleAttached = false;
  private ensureAutoLifecycle(): void {
    if (this.autoLifecycleAttached) return;
    this.autoLifecycleAttached = true;
    void import('./browserSession.js').then(({ getBrowserSession }) => {
      getBrowserSession().on((ev) => {
        if (ev.type === 'session:close') {
          this.disconnect().catch((err: any) =>
            cliLogger.warn('BROWSER_MGR', `session:close disconnect failed: ${err?.message}`));
        }
      });
    });
  }

  isConnected(): boolean {
    if (!this.backend) return false;
    if (this.backend.kind === 'owned') return this.ownedContext() !== null;
    return this.backend.browser.isConnected();
  }

  /** 所有 BrowserContext — OWNED 是单 context; ATTACHED 可能多个 (webview partition 独立 context). */
  getContexts(): BrowserContext[] {
    if (!this.backend) return [];
    if (this.backend.kind === 'owned') {
      const ctx = this.ownedContext();
      return ctx ? [ctx] : [];
    }
    return this.backend.browser.contexts();
  }

  private allPages(): Page[] {
    const out: Page[] = [];
    for (const ctx of this.getContexts()) {
      for (const p of ctx.pages()) {
        if (!p.isClosed()) out.push(p);
      }
    }
    return out;
  }

  /* ── 接管护栏放行窗 ──
   * 外置 Chrome 的接管层 (agentTakeoverBanner v2) 会拦截**用户**输入; 但页面里分不出
   * 用户事件和 CDP 合成事件 (isTrusted 都为 true), 约定: 每次工具动作解析到 page 时
   * 先开一个短放行窗, 窗内的输入视为 Agent 的。await 是必须的 —— 不等它落地,
   * 紧随其后的 Input.dispatch 会被护栏吃掉 (单次 evaluate 本地 ~1-3ms, 可忽略)。 */
  private async pauseTakeoverGuard(p: Page): Promise<void> {
    try {
      await Promise.all(p.frames().map(frame =>
        frame.evaluate('try { window.__neoxTakeoverGuard && window.__neoxTakeoverGuard.pause(5000) } catch (e) {}').catch(() => {}),
      ));
    } catch { /* 页面导航中/无护栏 — 无所谓 */ }
  }

  /* ──────────────────────────── resolvePage ─────────────────────────── */

  /**
   * surfaceId → Page. cache → window.name 扫描 → (可选) 建新 tab.
   *
   * OWNED 模式建 tab = 复用无烙印空 tab (Chrome 启动自带的 about:blank) 或
   * context.newPage(), 一条路, 保证成功.
   */
  async resolvePage(surfaceId: string, opts: { createIfMissing?: boolean; initialUrl?: string } = {}): Promise<Page | null> {
    getBrowserSession().assertCurrentActivity();
    await this.connect();
    getBrowserSession().assertCurrentActivity();

    const cached = this.pages.get(surfaceId);
    if (cached && !cached.isClosed()) {
      await this.pauseTakeoverGuard(cached);
      return cached;
    }

    const targetName = `neox-sfc-${surfaceId}`;

    /* 扫描反查烙印. ATTACHED (embedded dev) 模式下 renderer mount + 烙印要 200-800ms,
     * 带退避重试; OWNED 模式烙印是我们自己同步打的, 扫一遍就够. */
    const delays = this.backend?.kind === 'owned' ? [0] : [0, 150, 250, 400, 600, 800];
    for (const delay of delays) {
      if (delay > 0) await new Promise(r => setTimeout(r, delay));
      for (const p of this.allPages()) {
        try {
          const winName = await p.evaluate(() => (window as any).name).catch(() => '');
          if (winName === targetName) {
            this.pages.set(surfaceId, p);
            getOrAttachCapture(surfaceId, p);
            await this.pauseTakeoverGuard(p);
            return p;
          }
        } catch { /* about: / 导航中 跳过 */ }
      }
    }

    if (!opts.createIfMissing) return null;

    /* 同 surfaceId 并发建 tab 去重 — open_surface 事件处理器 (fire-and-forget) 和
     * 紧随其后的 browser_navigate 都会走 createIfMissing, 不去重会开两个 tab. */
    const inflight = this.creating.get(surfaceId);
    if (inflight) return inflight;

    const createPromise = (async (): Promise<Page | null> => {
      try {
        /* 建/复用 tab + 认领 + 烙印 — 串行化, 防两个不同 surface 并发抢同一个空白 tab.
         * goto 在互斥区外, 慢导航不阻塞别的 surface 建 tab. */
        const claim = this.createMutex.then(async () => {
          const p = await this.createPage();
          /* 先入 cache 再 goto — 认领即生效, 并发扫描者不会把它当无主 tab. */
          this.pages.set(surfaceId, p);
          /* 烙印. 跨源导航会清 window.name — 无所谓, cache 里 Page 对象是权威关联,
           * 烙印只服务扫描恢复和 listSurfaces (后者也会兜 cache). */
          await p.evaluate((name: string) => { (window as any).name = name; }, targetName).catch(() => {});
          return p;
        });
        this.createMutex = claim.then(() => undefined, () => undefined);
        const page = await claim;

        if (opts.initialUrl) {
          try {
            /* domcontentloaded 而非 load — 慢网络/代理下等全部子资源动辄超时. */
            await page.goto(opts.initialUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          } catch (gotoErr: any) {
            cliLogger.warn('BROWSER_MGR', `createIfMissing goto ${opts.initialUrl} 失败: ${gotoErr?.message}`);
          }
          /* 跨源导航清 window.name, 补一次. */
          await page.evaluate((name: string) => { (window as any).name = name; }, targetName).catch(() => {});
        }
        getOrAttachCapture(surfaceId, page);
        await this.pauseTakeoverGuard(page);
        this.lastCreateIfMissingError = undefined;
        cliLogger.info('BROWSER_MGR', `createIfMissing 完成 surface=${surfaceId} url=${opts.initialUrl || 'about:blank'}`);
        return page;
      } catch (err: any) {
        this.pages.delete(surfaceId);
        this.lastCreateIfMissingError = err?.message || String(err);
        cliLogger.warn('BROWSER_MGR', `createIfMissing failed for surface=${surfaceId}: ${this.lastCreateIfMissingError}`);
        return null;
      } finally {
        this.creating.delete(surfaceId);
      }
    })();
    this.creating.set(surfaceId, createPromise);
    return createPromise;
  }

  /** surfaceId → 进行中的建 tab promise (并发去重). */
  private creating = new Map<string, Promise<Page | null>>();
  /** 建 tab 互斥 — 复用空白 tab 的决策必须串行. */
  private createMutex: Promise<void> = Promise.resolve();

  /** 建 (或复用) 一个空 tab. */
  private async createPage(): Promise<Page> {
    /* 复用无烙印且未被认领的空 tab — Chrome 启动自带一个 about:blank, 别堆 tab. */
    const claimed = new Set(this.pages.values());
    for (const p of this.allPages()) {
      if (claimed.has(p)) continue;
      if (!p.url().startsWith('about:')) continue;
      try {
        const winName = await p.evaluate(() => (window as any).name).catch(() => '');
        if (!winName || !String(winName).startsWith('neox-sfc-')) {
          cliLogger.info('BROWSER_MGR', 'createPage: 复用无烙印空 tab');
          return p;
        }
      } catch { /* 导航中, 跳过 */ }
    }

    const contexts = this.getContexts();
    if (contexts.length === 0) throw new Error('没有可用 BrowserContext');
    /* OWNED: Playwright 拥有浏览器, newPage 保证成功.
     * ATTACHED: 部分外部 Chrome 上 newPage 不稳, 但附加模式只是诊断路径, 失败就报错. */
    return contexts[0]!.newPage();
  }

  /** 最近一次 createIfMissing 失败的具体错因, 让上层 tool 返错时给用户看清楚哪一步挂了. */
  private lastCreateIfMissingError: string | undefined;
  getLastCreateIfMissingError(): string | undefined {
    return this.lastCreateIfMissingError;
  }

  /* ─────────────────────────── list / diagnose ─────────────────────── */

  /** 列出所有 page (含空 tab / DevTools). 调试用. */
  async list(): Promise<Array<{ url: string; title: string }>> {
    await this.connect();
    const out: Array<{ url: string; title: string }> = [];
    for (const p of this.allPages()) {
      try {
        const url = p.url();
        const title = await p.title().catch(() => '');
        if (url === 'about:blank' && !title) continue; /* 跳过完全空的 (DevTools 隐藏 page) */
        out.push({ url, title });
      } catch { /* ignore */ }
    }
    return out;
  }

  /** Agent 用: 反查 window.name="neox-sfc-{id}", 只返 Neox 自己的 web surface. */
  async listSurfaces(): Promise<Array<{ surfaceId: string; url: string; title: string }>> {
    const host = getBrowserHostController();
    if (host?.listSurfaces) {
      return host.listSurfaces();
    }
    try {
      await this.connect();
      this.lastConnectError = null;
    } catch (err: any) {
      this.lastConnectError = err?.message || String(err);
      return []; /* 没连上就空返, 上层 hint 带 lastConnectError */
    }
    const out: Array<{ surfaceId: string; url: string; title: string }> = [];
    for (const p of this.allPages()) {
      try {
        const winName: string = await p.evaluate(() => (window as any).name).catch(() => '');
        const m = /^neox-sfc-(.+)$/.exec(winName || '');
        if (!m) continue;
        out.push({
          surfaceId: m[1]!,
          url: p.url(),
          title: await p.title().catch(() => ''),
        });
      } catch { /* about: / 导航中页面跳过 */ }
    }
    /* cache 里认领过但还没烙上 (刚建还在导航) 的也算 — 别让 agent 以为 surface 丢了. */
    for (const [surfaceId, p] of this.pages) {
      if (p.isClosed()) continue;
      if (out.some(s => s.surfaceId === surfaceId)) continue;
      out.push({ surfaceId, url: p.url(), title: await p.title().catch(() => '') });
    }
    return out;
  }

  /** Diagnostic: 裸 target 列表 + Playwright 视角对比. 用来确认 CDP 看到了什么 / 烙印生效. */
  async diagnose(): Promise<{
    rawTargets: Array<{ id: string; type: string; title: string; url: string }>;
    playwrightPages: Array<{ url: string; title: string; windowName: string; contextIdx: number; frameCount: number }>;
  }> {
    const host = getBrowserHostController();
    if (host?.diagnose) {
      return host.diagnose();
    }
    try { await this.connect(); } catch { return { rawTargets: [], playwrightPages: [] }; }

    /* 裸 target: OWNED 走 browser-level CDP session (无 HTTP 端口);
     * ATTACHED 走 HTTP /json/list 绕过 Playwright filtering. */
    const rawTargets: Array<{ id: string; type: string; title: string; url: string }> = [];
    if (this.backend?.kind === 'owned') {
      try {
        const browser = this.backend.context.browser();
        if (browser) {
          const cdp = await (browser as any).newBrowserCDPSession();
          try {
            const { targetInfos } = await cdp.send('Target.getTargets') as any;
            for (const t of targetInfos ?? []) {
              rawTargets.push({ id: t.targetId || '', type: t.type || '', title: t.title || '', url: t.url || '' });
            }
          } finally {
            await cdp.detach().catch(() => {});
          }
        }
      } catch (err: any) {
        cliLogger.warn('BROWSER_MGR', `Target.getTargets 失败: ${err?.message}`);
      }
    } else {
      const port = process.env.NEOX_BROWSER_CDP_PORT;
      if (port) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/json/list`);
          if (res.ok) {
            const list = (await res.json()) as Array<Record<string, any>>;
            for (const t of list) {
              rawTargets.push({ id: t.id || '', type: t.type || '', title: t.title || '', url: t.url || '' });
            }
          }
        } catch (err: any) {
          cliLogger.warn('BROWSER_MGR', `raw CDP /json/list 拉取失败: ${err?.message}`);
        }
      }
    }

    const playwrightPages: Array<{ url: string; title: string; windowName: string; contextIdx: number; frameCount: number }> = [];
    const ctxs = this.getContexts();
    for (let i = 0; i < ctxs.length; i++) {
      for (const p of ctxs[i]!.pages()) {
        if (p.isClosed()) continue;
        try {
          const windowName: string = await p.evaluate(() => (window as any).name).catch(() => '') || '';
          playwrightPages.push({
            url: p.url(),
            title: await p.title().catch(() => ''),
            windowName,
            contextIdx: i,
            frameCount: p.frames().length,
          });
        } catch { /* ignore */ }
      }
    }
    return { rawTargets, playwrightPages };
  }

  /* ───────────────────────────── shutdown ──────────────────────────── */

  /** 关后端. OWNED = 优雅退出 Chrome; ATTACHED = 断开连接. 幂等. */
  async disconnect(): Promise<void> {
    if (this.disconnectPromise) return this.disconnectPromise;
    this.lifecycleGeneration++;
    const pendingLaunch = this.launchPromise;
    const pendingConnect = this.connectPromise;
    this.disconnectPromise = Promise.resolve().then(async () => {
      // A shutdown must also drain an in-flight launch; otherwise it can publish
      // a new backend after the caller believes the browser has been closed.
      await pendingLaunch?.catch(() => {});
      await pendingConnect?.catch(() => {});
      const backend = this.backend;
      this.backend = null;
      this.pages.clear();
      if (!backend) return;
      try {
        if (backend.kind === 'owned') {
          await backend.context.close();
        } else {
          await backend.browser.close();
        }
      } catch { /* Native profile locking remains authoritative if close fails. */ }
    }).finally(() => {
      this.disconnectPromise = null;
    });
    return this.disconnectPromise;
  }
}

let instance: BrowserManager | null = null;
export function getBrowserManager(): BrowserManager {
  if (!instance) instance = new BrowserManager();
  return instance;
}
