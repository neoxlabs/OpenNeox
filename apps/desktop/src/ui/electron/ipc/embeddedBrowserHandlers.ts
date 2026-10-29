/**
 * embedded-browser:* + browser-tool:* IPC handlers.
 *
 * 两套 IPC, 不要混淆:
 *
 *   1. embedded-browser:*  → renderer ↔ BrowserViewManager (主进程同进程)
 *      UI 浏览器交互: mount/setBounds/navigate/back/forward/reload/destroy/...
 *      + suppress/restore/capture (给 renderer 端 fade 用).
 *
 *   2. browser-tool:*  → renderer ↔ runtime bridge
 *      Agent 工具入口. Desktop runtime 优先走主进程注入的 BrowserViewManager host controller,
 *      只控制已注册的 surfaceId; 不依赖 Electron 全局 --remote-debugging-port.
 *
 * 设计文档: 内部设计文档 §3.
 */

import { ipcMain } from './ipcMainBridged.js';
import { lazyElectron } from '../lazyElectron.js';
import type { IpcMainInvokeEvent } from 'electron';

/* electron 运行时取 —— 顶层静态 import 会让整个 bundle 在纯 Node 后端里加载失败。
 * 极简版只用**外置 Chrome** 那一路 (browser-mode / external-chrome / browser-tool),
 * 内嵌 BrowserView 那一路本来就用不到, 真调到会明确报错而不是静默。 */
const BrowserWindow = lazyElectron<typeof import('electron').BrowserWindow>('BrowserWindow');
import { getBrowserViewManager } from '../services/embeddedBrowser/BrowserViewManager.js';
import { browserBrandOf, findChromeExecutable } from '../services/externalChrome/chromeLauncher.js';
import { makeOptionalBridgeResolver } from './scopeResolvers.js';
import type { ProjectManager } from '../context/ProjectManager.js';

/**
 * 浏览器渲染模式:
 *   - 'external' (默认): 启动用户机器上的真 Chrome, 通过 CDP 接管. Agent 底部注入
 *     悬浮 "Agent 接管中" banner. 空间自由 / 无闪烁 / 无 mount race.
 *   - 'embedded': 老路径, 内嵌 BrowserView. 代码保留但默认不走.
 *
 * 通过 env var NEOX_BROWSER_MODE 覆盖 (少数场景需要 embedded 兜底).
 */
type BrowserMode = 'external' | 'embedded';
function resolveBrowserMode(): BrowserMode {
  const v = String(process.env.NEOX_BROWSER_MODE || '').trim().toLowerCase();
  if (v === 'embedded') return 'embedded';
  return 'external';   /* 默认走外置 */
}

interface RectInput {
  x: number; y: number; width: number; height: number;
}

function resolveWindowId(event: IpcMainInvokeEvent | undefined): number | null {
  /* renderer 发 IPC 时 event?.sender = webContents, 反查它所在的 BrowserWindow。
   * 非 Electron 宿主 (极简版) 没有 sender 也没有窗口 —— 返回 null 走调用方的兜底,
   * 而不是在这里抛。极简版走的是外置 Chrome 那一路, 本来就不需要窗口 id。 */
  if (!event?.sender) return null;
  try {
    const win = BrowserWindow.fromWebContents(event?.sender);
    return win?.id ?? null;
  } catch { return null; }
}

interface RegisterEmbeddedBrowserIpcOptions {
  projectManager: ProjectManager;
}

export function registerEmbeddedBrowserIpcHandlers(opts: RegisterEmbeddedBrowserIpcOptions): void {
  const mgr = getBrowserViewManager();
  const mode = resolveBrowserMode();

  /* 外置模式: agent browser_* tool 落到 neox-core browserManager (Playwright connectOverCDP),
   *   走外置 Chrome. Manager 订阅 BrowserSession 事件 — Chrome 生命周期完全由 agent 驱动.
   * 内嵌模式: 老行为, 注册 BrowserViewManager 为 host controller, embedded-browser:* 走本地 view. */
  if (mode === 'embedded') {
    (globalThis as any).__NEOX_BROWSER_HOST_CONTROLLER__ = mgr;
    delete process.env.NEOX_BROWSER_HOST;
  } else {
    delete (globalThis as any).__NEOX_BROWSER_HOST_CONTROLLER__;
    process.env.NEOX_BROWSER_HOST = 'desktop';
  }

  const bridgeOf = makeOptionalBridgeResolver(opts.projectManager);

  /** 发起 IPC 的窗口所属 runtime 的 Chrome —— 状态 / 启动 / 关闭 / 聚焦都经它。 */
  const browserControlOf = async (
    event: IpcMainInvokeEvent | undefined,
    op: 'status' | 'ensure' | 'shutdown' | 'focus',
    workspacePath?: string,
  ) => {
    const bridge = bridgeOf(event);
    if (!bridge) {
      return { ok: op === 'status', running: false, browser: browserBrandOf(findChromeExecutable()), error: op === 'status' ? undefined : 'No project scope for sender window' };
    }
    return bridge.browserControl(op, { workspacePath });
  };

  /**
   * 外置模式 middleware: 在任何 browser-tool:* 首次触发前保证 Chrome 已启动 + 已 connect.
   *   幂等 — 多次调用只启一次. 启动失败抛错让 tool 返 error, UI 可以显 hint.
   *
   * 内嵌模式: no-op (BrowserViewManager 已经就绪, 不需要 ensure).
   */
  const ensureBrowserBackend = mode === 'external'
    ? async (event: IpcMainInvokeEvent, workspacePath?: string) => {
        const r = await browserControlOf(event, 'ensure', workspacePath);
        if (!r.ok) throw new Error(r.error || 'Chrome failed to start');
      }
    : async (_event: IpcMainInvokeEvent, _workspacePath?: string) => { /* no-op */ };

  /* 暴露给 renderer 查询当前模式 (UI 侧决定是否 mount BrowserView) */
  ipcMain.handle('browser-mode:get', () => ({ mode }));

  /* 外置模式: renderer 主动触发 Chrome 启动 (卡片"启动 Chrome"按钮).
   * Chrome 起来打开 about:blank, 后续 agent goto 具体页. */
  ipcMain.handle('external-chrome:ensure', async (event, payload: { workspacePath?: string } = {}) => {
    if (mode !== 'external') return { ok: false, error: 'not in external mode' };
    return browserControlOf(event, 'ensure', payload?.workspacePath);
  });

  /* browser: 外置模式拉起的**不一定是 Chrome** —— chromeLauncher 按 Chrome → Chromium →
   * Brave → Edge 的顺序找, 装了哪个就用哪个。UI 卡片据此显示对应的真 brand logo 和名字。
   * 查的是**这个窗口的 runtime** 持有的那个 Chrome —— 之前查主进程自己那个, agent 工具
   * 在 worker 里起的 Chrome 卡片永远显示"未启动"。 */
  ipcMain.handle('external-chrome:status', async (event) => {
    const r = await browserControlOf(event, 'status');
    return { running: r.running, browser: r.browser };
  });

  ipcMain.handle('external-chrome:shutdown', async (event) => {
    if (mode !== 'external') return { ok: false, error: 'not in external mode' };
    return browserControlOf(event, 'shutdown');
  });

  ipcMain.handle('external-chrome:focus', async (event) => {
    if (mode !== 'external') return { ok: false, error: 'not in external mode' };
    return browserControlOf(event, 'focus');
  });

  /* ════════════════════════════════════════════════════════════════════════
   *  PART 1 — embedded-browser:* (renderer ↔ BrowserViewManager)
   * ════════════════════════════════════════════════════════════════════════ */

  ipcMain.handle('embedded-browser:mount', async (event, payload: {
    surfaceId: string;
    bounds: RectInput;
    initialUrl?: string;
    workspacePath?: string;
  }) => {
    if (mode === 'external') {
      // eslint-disable-next-line no-console
      console.warn(`[embedded-browser:mount] REFUSED — mode=external. surfaceId=${payload.surfaceId}. renderer 应该显 ExternalChromeCard, 不该调 mount. 是不是 preload 没热更新?`);
      return { ok: false, error: 'BrowserView mount refused: NEOX_BROWSER_MODE=external (Chrome runs in separate window). To use embedded, set NEOX_BROWSER_MODE=embedded and restart Neox.' };
    }
    const winId = resolveWindowId(event);
    if (!winId) return { ok: false, error: 'no host window' };
    try {
      mgr.ensure({
        surfaceId: payload.surfaceId,
        workspaceWindowId: winId,
        bounds: payload.bounds,
        initialUrl: payload.initialUrl,
        workspacePath: payload.workspacePath,
      });
      return { ok: true, state: mgr.getState(payload.surfaceId) };
    } catch (err: any) {
      return { ok: false, error: err?.message };
    }
  });

  ipcMain.handle('embedded-browser:set-bounds', (_event, payload: { surfaceId: string; bounds: RectInput }) => {
    mgr.setBounds(payload.surfaceId, payload.bounds);
    return { ok: true };
  });

  ipcMain.handle('embedded-browser:bring-to-front', (_event, payload: { surfaceId: string }) => {
    mgr.bringToFront(payload.surfaceId);
    return { ok: true };
  });

  ipcMain.handle('embedded-browser:hide', (_event, payload: { surfaceId: string }) => {
    mgr.hide(payload.surfaceId);
    return { ok: true };
  });

  ipcMain.handle('embedded-browser:show', (_event, payload: { surfaceId: string }) => {
    mgr.show(payload.surfaceId);
    return { ok: true };
  });

  ipcMain.handle('embedded-browser:navigate', async (_event, payload: { surfaceId: string; url: string }) => {
    return mgr.loadURL(payload.surfaceId, payload.url);
  });

  ipcMain.handle('embedded-browser:back', async (_event, payload: { surfaceId: string }) => mgr.goBack(payload.surfaceId));
  ipcMain.handle('embedded-browser:forward', async (_event, payload: { surfaceId: string }) => mgr.goForward(payload.surfaceId));
  ipcMain.handle('embedded-browser:reload', async (_event, payload: { surfaceId: string }) => mgr.reload(payload.surfaceId));

  ipcMain.handle('embedded-browser:get-state', (_event, payload: { surfaceId: string }) => {
    return mgr.getState(payload.surfaceId);
  });

  ipcMain.handle('embedded-browser:toggle-devtools', (_event, payload: { surfaceId: string }) => {
    mgr.toggleDevTools(payload.surfaceId);
    return { ok: true };
  });

  ipcMain.handle('embedded-browser:capture', async (_event, payload: { surfaceId: string }) => {
    return mgr.capture(payload.surfaceId);
  });

  ipcMain.handle('embedded-browser:destroy', (_event, payload: { surfaceId: string }) => {
    mgr.destroy(payload.surfaceId);
    return { ok: true };
  });

  ipcMain.handle('embedded-browser:list', () => ({ surfaces: mgr.list() }));

  /* Suppress / restore — 平滑 fade 配合用 (renderer 已经把 snapshot div 淡入完成后才调
   * suppress 真藏 view; restore 时反向). */
  ipcMain.handle('embedded-browser:suppress', (_event, payload: { surfaceId: string }) => {
    mgr.suppress(payload.surfaceId);
    return { ok: true };
  });
  ipcMain.handle('embedded-browser:restore', (_event, payload: { surfaceId: string }) => {
    mgr.restore(payload.surfaceId);
    return { ok: true };
  });

  /* 全局 — 切 IDE/Agent / 切 workspace 等 "藏全部 BrowserView" 场景用 */
  ipcMain.handle('embedded-browser:suppress-all', () => { mgr.suppressAll(); return { ok: true }; });
  ipcMain.handle('embedded-browser:restore-all',  () => { mgr.restoreAll();  return { ok: true }; });

  /* ════════════════════════════════════════════════════════════════════════
   *  PART 2 — browser-tool:* (renderer ↔ runtime, agent 工具桥)
   * ════════════════════════════════════════════════════════════════════════ */

  /* browser-tool:* 通用 wrap: 外置模式先 ensureBrowserBackend (按需起 Chrome), 再走 agent client.
   *   ensure 失败直接返 error (agent 侧会看到 hint 让用户装 Chrome). */
  ipcMain.handle('browser-tool:navigate', async (event: IpcMainInvokeEvent, payload: { surfaceId: string; url: string; waitUntil?: any; timeout?: number; workspacePath?: string }) => {
    try { await ensureBrowserBackend(event, payload.workspacePath); } catch (err: any) { return { ok: false, error: err?.message || String(err) }; }
    const client = await bridgeOf(event)?.getClientAsync();
    if (!client) return { ok: false, error: 'agent server not ready' };
    return client.browserNavigate(payload);
  });

  ipcMain.handle('browser-tool:screenshot', async (event: IpcMainInvokeEvent, payload: { surfaceId: string; fullPage?: boolean; clip?: any; format?: any; quality?: number }) => {
    try { await ensureBrowserBackend(event); } catch (err: any) { return { ok: false, error: err?.message || String(err) }; }
    const client = await bridgeOf(event)?.getClientAsync();
    if (!client) return { ok: false, error: 'agent server not ready' };
    return client.browserScreenshot(payload);
  });

  ipcMain.handle('browser-tool:get-state', async (event: IpcMainInvokeEvent, payload: { surfaceId: string }) => {
    try { await ensureBrowserBackend(event); } catch (err: any) { return { ok: false, error: err?.message || String(err) }; }
    const client = await bridgeOf(event)?.getClientAsync();
    if (!client) return { ok: false, error: 'agent server not ready' };
    return client.browserGetState(payload);
  });

  /* ── 通用桥接 (含 ensure) ── */
  const browserToolBridge = (channel: string, sdkMethod: string) => {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, payload: any) => {
      try { await ensureBrowserBackend(event, payload?.workspacePath); } catch (err: any) { return { ok: false, error: err?.message || String(err) }; }
      const client = await bridgeOf(event)?.getClientAsync();
      if (!client) return { ok: false, error: 'agent server not ready' };
      const fn = (client as any)[sdkMethod];
      if (typeof fn !== 'function') return { ok: false, error: `client.${sdkMethod} not implemented` };
      return fn.call(client, payload);
    });
  };
  /* DOM 查询 / 操作 */
  browserToolBridge('browser-tool:get-aria-tree', 'browserGetAriaTree');
  browserToolBridge('browser-tool:query',         'browserQuery');
  browserToolBridge('browser-tool:get-text',      'browserGetText');
  browserToolBridge('browser-tool:click',         'browserClick');
  browserToolBridge('browser-tool:type',          'browserType');
  browserToolBridge('browser-tool:press-key',     'browserPressKey');
  browserToolBridge('browser-tool:scroll',        'browserScroll');
  browserToolBridge('browser-tool:hover',         'browserHover');
  browserToolBridge('browser-tool:select-option', 'browserSelectOption');
  browserToolBridge('browser-tool:fill-form',     'browserFillForm');
  /* 等待 / 观察 */
  browserToolBridge('browser-tool:wait-for',            'browserWaitFor');
  browserToolBridge('browser-tool:wait-for-navigation', 'browserWaitForNavigation');
  browserToolBridge('browser-tool:get-console-logs',    'browserGetConsoleLogs');
  browserToolBridge('browser-tool:get-network',         'browserGetNetwork');
  browserToolBridge('browser-tool:get-response-body',   'browserGetResponseBody');
  /* 导航 / 断言 / 求值 */
  browserToolBridge('browser-tool:back',    'browserBack');
  browserToolBridge('browser-tool:forward', 'browserForward');
  browserToolBridge('browser-tool:reload',  'browserReload');
  browserToolBridge('browser-tool:expect',  'browserExpect');
  browserToolBridge('browser-tool:eval',    'browserEval');
  /* cookies / storage */
  browserToolBridge('browser-tool:get-cookies',        'browserGetCookies');
  browserToolBridge('browser-tool:set-cookies',        'browserSetCookies');
  browserToolBridge('browser-tool:clear-cookies',      'browserClearCookies');
  browserToolBridge('browser-tool:get-local-storage',  'browserGetLocalStorage');
  browserToolBridge('browser-tool:set-local-storage',  'browserSetLocalStorage');
  /* network mock + file upload */
  browserToolBridge('browser-tool:mock-response',      'browserMockResponse');
  browserToolBridge('browser-tool:clear-mocks',        'browserClearMocks');
  browserToolBridge('browser-tool:list-mocks',         'browserListMocks');
  browserToolBridge('browser-tool:set-input-files',    'browserSetInputFiles');
  /* 响应式测试 */
  browserToolBridge('browser-tool:set-viewport',       'browserSetViewport');
}
