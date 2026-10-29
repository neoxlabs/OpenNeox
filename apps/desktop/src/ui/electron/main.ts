import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { cancelPendingWindowsUpdateInstall } from './windowsUpdateInstall.js';
import { app, BrowserWindow, crashReporter, dialog, ipcMain, nativeTheme, protocol } from 'electron';

const requireExternal = createRequire(import.meta.url);
import { fileURLToPath } from 'url';
import { dirname, join, extname, resolve as pathResolve, sep as pathSep } from 'path';
import { readFile as fsReadFile } from 'fs/promises';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { fixUserShellPath } from './bootstrap/fixUserShellPath.js';
import { workspaceKey } from '../shared/workspacePath.node.js';
import { assetPathnameToAbsolute, isUnderAnyRoot } from '../shared/assetUrlPath.js';
import { isPreviewableExt, isSensitiveReadPath } from '../shared/localReadPolicy.js';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';
import { DISTRIBUTION } from '@neoxlabs/kernel/platform/distribution.js';
import { homedir, tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
fixUserShellPath();

/* 发往网关的 User-Agent 用桌面端自己的版本 (kernel utils/neoxUserAgent.ts 读这两个变量)。
 * 不设的话 kernel 用它的 VERSION —— 那是构建时从 apps/cli/package.json 烤进来的 CLI 版本线,
 * Windows 桌面端 3.8.12 会上报成 Neox-Desktop/3.4.9。写进 env 是为了 runtime worker 子进程也继承到;
 * 用户在内置终端里手动跑的 neox CLI 不会被带偏 —— CLI 只在 `serve` 模式下采信这两个变量。 */
process.env.NEOX_CLIENT = 'desktop';
process.env.NEOX_CLIENT_VERSION = getAppVersion();

{
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const ffmpegPath = app.isPackaged
    ? join(process.resourcesPath, 'ffmpeg', exe)
    : join(process.cwd(), 'build', 'ffmpeg', `${process.platform}-${process.arch}`, exe);
  try { if (statSync(ffmpegPath).isFile()) process.env.NEOX_FFMPEG_PATH = ffmpegPath; } catch { /* 没有就用 PATH 上的 */ }
}

// Inherited by runtime workers/children. Dev checkouts and the installed app
// must never contend for a legacy Chrome pipe/profile.
process.env.NEOX_BROWSER_PROFILE_NAMESPACE = app.isPackaged
  ? 'desktop-production'
  : `desktop-development-${createHash('sha256').update(app.getAppPath()).digest('hex').slice(0, 16)}`;

/* 应用名 / 协议 / AUMID 都按发行版取 (kernel/platform/distribution.ts): 商业版和开源版同机
 * 共存时, userData (machine-id / 单实例锁) 和深链回调必须各归各的。 */
app.setName(DISTRIBUTION.appName);
app.name = DISTRIBUTION.appName;
const DEEP_LINK_PREFIX = `${DISTRIBUTION.protocol}://`;
if (process.platform === 'win32') {
  app.setAppUserModelId(app.isPackaged ? DISTRIBUTION.appUserModelId : `${DISTRIBUTION.appUserModelId}.dev`);
}


{
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('@neoxlabs/platform/platform/systemProxy.js');
    const r = mod.applySystemProxySync();
    if (r.detected) {
      console.log(
        `[Main] systemProxy: source=${r.source} http=${r.httpProxy || '-'} https=${r.httpsProxy || '-'}`
        + ` socks=${r.socksProxy || '-'} pac=${r.pacUrl || '-'} exceptions=${r.noProxy || '-'} (dispatcher installed)`,
      );
    } else {
      console.log('[Main] systemProxy: 系统未配置代理 (env / 系统设置都为空) — 全部直连');
    }
    mod.startSystemProxyWatch(30000);
    mod.onSystemProxyChange((before: any, after: any) => {
      const brief = (x: any) => x.httpsProxy || x.httpProxy || x.socksProxy || x.pacUrl || 'none';
      console.log(`[Main] systemProxy changed: ${brief(before)} → ${brief(after)}`);
    });
  } catch (err) {
    console.error('[Main] ⚠️ systemProxy 安装失败 —— 主进程将【直连】, 需要代理才能联网的用户会看到 fetch failed:', err);
  }
}

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  (globalThis as any).__NEOX_NATIVE__ = requireExternal('@neoxlabs/native/neox-native.node');
} catch {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    (globalThis as any).__NEOX_NATIVE__ = requireExternal('@neoxlabs/native');
  } catch { /* optional — signer 缺失时 loadAutoHmacSigner 自身 catch 返 null */ }
}

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { registerNeoxComposeBridge } = requireExternal('@neoxlabs/pptx-compose');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { renderHtmlToPngDataUrl, startPptxRenderBridge } = require('./services/pptxRenderBridge.js');
  registerNeoxComposeBridge({
    renderHtmlToImage: (html: string, w: number, h: number, scale: number) =>
      renderHtmlToPngDataUrl(html, w, h, scale),
  });
  startPptxRenderBridge()
    .then((baseUrl: string) => {
      process.env.NEOX_PPTX_BRIDGE_URL = baseUrl;
      console.log(`[Main] pptx render bridge listening (NEOX_PPTX_BRIDGE_URL set)`);
    })
    .catch((err: unknown) => console.warn(`[Main] pptx render bridge start failed`, err));
  console.log(`[Main] compose HTML→PNG bridge registered (offscreen BrowserWindow)`);
} catch (err) {
  /* 没有 PPT 引擎的构建 (开源版) 本来就没这个包 —— 不是故障, 不报警 */
  if ((err as NodeJS.ErrnoException)?.code !== 'MODULE_NOT_FOUND') {
    console.warn(`[Main] compose bridge registration failed`, err);
  }
}

void import('@neoxlabs/platform/platform/shellEnv.js')
  .then(({ preloadShellEnv }) => preloadShellEnv({ background: true }))
  .catch((err) => console.warn('[Main] preloadShellEnv failed', err));

/* v2 fp 注入 — 网关 v2 签名要 X-Device-FP 非空 (下方 sigverify devicebind TOFU 校验).
 * getDeviceFingerprint 是主进程稳定指纹: machineId+installUuid+cpuModel+ram+platform, native computeFingerprint 输出.
 * 挂载时机: __NEOX_NATIVE__ 已在, kernel 首次 signer 调用一定在 app.ready 之后, 这里同步同步注入即可. */
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getDeviceFingerprint } = require('./services/deviceFingerprint.js');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { setNeoxDeviceFp } = require('@neoxlabs/kernel/models/openai.js');
  setNeoxDeviceFp(getDeviceFingerprint().fpHash);
} catch { /* deviceFingerprint 有兜底; 失败让 signer fail-close 抛 */ }
function isTcpPortBusy(port: number): boolean {
  try {
    if (process.platform === 'win32') {
      /* netstat 行形如: TCP  127.0.0.1:41777  0.0.0.0:0  LISTENING  12345 */
      const out = execSync('netstat -ano -p tcp', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 });
      return new RegExp(`[:.]${port}\\s+\\S+\\s+LISTENING`, 'i').test(out);
    }
    const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 });
    return out.trim().length > 0;
  } catch {
    /* lsof 在 macOS 上未监听时退出码非 0 —— 抛错即视为空闲 ✓；其它异常不阻断启动 */
    return false;
  }
}

const _cdpEnabled = !app.isPackaged || process.env.NEOX_ENABLE_CDP === '1';
if (_cdpEnabled) {
  const requestedCdpPort = Number(process.env.NEOX_CDP_PORT) || 0;
  let selfDebugPort = Math.floor(40000 + Math.random() * 10000);
  if (requestedCdpPort) {
    if (isTcpPortBusy(requestedCdpPort)) {
      console.warn(
        `[Main] NEOX_CDP_PORT=${requestedCdpPort} 已被占用`
        + ' (常见来源: 从另一个带该 env 的 Neox 进程派生) —— 本次改用随机端口',
      );
    } else {
      selfDebugPort = requestedCdpPort;
    }
  }
  app.commandLine.appendSwitch('remote-debugging-port', String(selfDebugPort));
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
  /* 老版本把 selfDebugPort 写进过 NEOX_BROWSER_CDP_PORT — 若继承到的值正是自己的
   * 端口, 清掉; 用户显式指向别的浏览器的值保留 (那是 ATTACHED 模式的合法用法)。 */
  if (process.env.NEOX_BROWSER_CDP_PORT === String(selfDebugPort)) {
    delete process.env.NEOX_BROWSER_CDP_PORT;
  }
} else {
  /* 打包版 + 未强制开启 — 显式清 env, 防子进程读到 stale port 后再尝试 connect. */
  delete process.env.NEOX_BROWSER_CDP_PORT;
}

app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-accelerated-2d-canvas');
app.commandLine.appendSwitch('enable-features', 'CanvasOopRasterization,DocumentPolicyIncludeJSCallStacksInCrashReports');

app.commandLine.appendSwitch('use-mock-keychain');
import { applyToProcessEnv as applyCloudEndpointsEnv, resolveCloudEndpoints } from './services/cloudEndpoints.js';
applyCloudEndpointsEnv();
import { hostResolverRulesFor, installEdgeRouting, readCachedEdge } from '@neoxlabs/platform';
import { DESKTOP_EDGE_SEED } from './services/cloudEdges.js';
{
  const forced = String(process.env.NEOX_EDGE ?? '').toLowerCase();
  const rules = forced === 'off' || forced === 'cf' ? null : hostResolverRulesFor(readCachedEdge());
  if (rules) app.commandLine.appendSwitch('host-resolver-rules', rules);
  installEdgeRouting({ seed: DESKTOP_EDGE_SEED });
}
import { AgentBridge } from './services/agentBridge.js';
import { storageService } from '../../platform-electron/storageService.js';
import { sessionStore } from '@neoxlabs/core/platform/sessionStore.js';
import { configService } from '@neoxlabs/platform/platform/configService.js';
import { getDatabase } from '@neoxlabs/platform/platform/database.js';
import { processManager } from '@neoxlabs/platform/platform/processManager.js';
import { normalizeContextBreakdown } from '@neoxlabs/kernel/utils/contextBreakdown.js';
import { TerminalService } from '../../platform-electron/terminalService.js';
import { DebugService } from './services/debugService.js';
import { createSessionStateServices } from './services/sessionState.js';
import { createMainWindow } from './services/mainWindowFactory.js';
import { refreshWindowsShortcuts } from './services/windowsShortcuts.js';
import { markWindowsAppQuitting, setupWindowsTray } from './services/windowsTray.js';
import { setupMacMenuBarTray } from './services/macMenuBarTray.js';
import { registerAllIpcHandlers } from './ipc/registerAllIpcHandlers.js';
import { registerPetIpcHandlers } from './ipc/petHandlers.js';
import { registerAutomationIpcHandlers } from './ipc/automationHandlers.js';
import { registerComputerOverlayIpcHandlers } from './ipc/computerOverlayHandlers.js';
import { registerPilotIpcHandlers, shutdownPilotCalls } from './ipc/pilotHandlers.js';
import { configureRuntimeEnqueue } from './services/runtimeEnqueue.js';
import { bootPilotTelegram, stopPilotTelegram } from './services/pilotTelegram.js';
import { setupGlobalErrorHandling } from './bootstrap/globalErrorHandling.js';
import { installCrashReporter } from '@neoxlabs/platform/platform/crashReport/index.js';
/* 渲染进程 / GPU / Utility 进程崩溃 (app 级事件, 一次覆盖所有窗口) → kind:'native'。 */
import { installProcessGoneReporting } from './bootstrap/processGoneReporting.js';
import { installHangMonitor } from './bootstrap/hangMonitor.js';
import { setupAppLifecycle } from './bootstrap/appLifecycle.js';
import { armQuitWatchdog, registerWindowOpener, reopenWindowIfNone, withQuitTimeout } from './bootstrap/quitGuards.js';
import { breadcrumb } from './bootstrap/startupBreadcrumb.js';
// ═══ 多项目并行隔离基础设施 ═══
// AppScope 是主进程唯一的根 scope (单例), ProjectManager 是 app 级服务, 持有所有
// 打开的 ProjectScope. 每个 BrowserWindow = 一个 ProjectScope, 各自独立的 service.
// 详见 src/ui/electron/context/*.
import {
  AppScope,
  ProjectManager,
  ProjectScope,
  OwnedIdsTracker,
  OWNED_IDS_TRACKER,
  PROJECT_MANAGER,
  RUN_PROCESS_MANAGER,
  TERMINAL_SERVICE,
  DEBUG_SERVICE,
  DEBUGGER_MANAGER,
  AGENT_BRIDGE,
  SEMANTIC_BRIDGE,
  EMBEDDING_BRIDGE,
  TS_SERVER_BRIDGE,
  PROJECT_STARTUP_COORDINATOR,
  SKILL_REGISTRY,
} from './context/index.js';
import { DebuggerManager } from '../../ide/debug/index.js';
import { makeJvmBackendFactory } from './services/debug/index.js';
import { RunProcessManager } from './services/runProcessManager.js';
import { SemanticBridge } from './services/semanticBridge.js';
import { EmbeddingBridge } from './services/embeddingBridge.js';
import { ProjectStartupCoordinator } from './services/projectStartupCoordinator.js';
import { TsServerBridge } from './services/tsServerBridge.js';
import { SkillRegistry } from '@neoxlabs/core/skills/index.js';
import { profileCheckpoint } from '@neoxlabs/platform/utils/startup/profiler.js';

profileCheckpoint('electron_main_entry');
// import { MCPClientManager, ... } from '@neoxlabs/core/mcp/index.js'; // REMOVED — via SDK
// import { skillRegistry, ... } from '@neoxlabs/core/skills/index.js'; // REMOVED — via SDK

crashReporter.start({ uploadToServer: false });

async function pruneCrashDumps(): Promise<void> {
  const KEEP = 5;
  const MAX_AGE_DAYS = 30;
  try {
    const dir = app.getPath('crashDumps');
    const fsp = await import('node:fs/promises');
    const nodePath = await import('node:path');
    /* Crashpad 把 dump 放在 completed/ 或 pending/ 下, 平台间不一致 —— 两层都扫,
     * 但只认 .dmp, 绝不碰 settings.dat 那类 Crashpad 自己的元数据文件。 */
    const roots = [dir, nodePath.join(dir, 'completed'), nodePath.join(dir, 'pending')];
    const found: Array<{ full: string; mtimeMs: number; size: number }> = [];
    for (const root of roots) {
      let names: string[];
      try { names = await fsp.readdir(root); } catch { continue; }
      for (const name of names) {
        if (!name.endsWith('.dmp')) continue;
        const full = nodePath.join(root, name);
        try {
          const st = await fsp.stat(full);
          if (st.isFile()) found.push({ full, mtimeMs: st.mtimeMs, size: st.size });
        } catch { /* 读不到就跳过 */ }
      }
    }
    if (found.length <= KEEP) return;
    found.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 3600 * 1000;
    let removed = 0;
    let freed = 0;
    for (const f of found.slice(KEEP)) {
      if (f.mtimeMs >= cutoff) continue;   // 还不够老, 留着
      try { await fsp.rm(f.full, { force: true }); removed++; freed += f.size; }
      catch { /* 删不掉就跳过 —— 报少不报多 */ }
    }
    if (removed > 0) {
      // eslint-disable-next-line no-console
      console.log(`[crash] pruned ${removed} minidump(s), freed ${(freed / 1048576).toFixed(1)} MB`);
    }
  } catch { /* 清理失败不影响任何功能 */ }
}
app.whenReady().then(() => { void pruneCrashDumps(); });

setupGlobalErrorHandling({
  isPackaged: app.isPackaged,
  showErrorBox: (title, content) => dialog.showErrorBox(title, content),
  appVersion: app.getVersion(),
});

try {
  const crashReporter = installCrashReporter({
    app: 'desktop',
    process: 'main',
    version: app.getVersion(),
    workspaceDir: process.cwd(),
    isEnabled: () => {
      try { return configService.getCrashReportPreference(); } catch { return true; }
    },
  });
  void crashReporter.runStartupRecovery();
  /* 渲染进程 / GPU / Utility 子进程崩溃 —— 主进程还活着, 这是唯一的上报入口。 */
  installProcessGoneReporting(app, crashReporter);
  /* 卡顿记录 (窗口未响应 / 界面长帧 / 主进程卡住) → ~/.neox/logs/hang.log + kind:'hang' 上报 */
  installHangMonitor({ app, BrowserWindow, ipcMain }, crashReporter);
} catch {
  /* 上报器装不上不该挡住应用启动 */
  try { installHangMonitor({ app, BrowserWindow, ipcMain }, null); } catch { /* ignore */ }
}

function isWindowIpcDisposalError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('Render frame was disposed')
    || message.includes('Object has been destroyed')
    || message.includes('webFrameMain');
}

const REPLAY_ON_READY_TYPES = new Set(['session_resumed', 'session_resume_failed']);
const pendingReadyReplay = new Map<number, Array<{ channel: string; payload: unknown }>>();
let rendererStreamReady = false;

/** 渲染层订阅完 chat:stream 后调 —— 把 ready 之前攒下的一次性通知补发出去。 */
export function flushPendingReadyReplay(): void {
  rendererStreamReady = true;
  for (const [winId, queue] of pendingReadyReplay) {
    const win = BrowserWindow.getAllWindows().find((w) => w.id === winId);
    pendingReadyReplay.delete(winId);
    if (!win || win.isDestroyed()) continue;
    for (const item of queue) {
      try { win.webContents.send(item.channel, item.payload); } catch { /* 窗口没了就算了 */ }
    }
  }
}

function sendWindowIpcIfAlive(window: BrowserWindow, channel: string, payload: unknown): boolean {
  try {
    if (window.isDestroyed()) return false;
    const webContents = window.webContents;
    if (webContents.isDestroyed()) return false;
    /* 渲染层还没订阅 → 一次性通知先攒着, 等 ready 再补发 (见 REPLAY_ON_READY_TYPES 注释) */
    if (!rendererStreamReady) {
      const t = (payload as { type?: string } | null)?.type;
      if (t && REPLAY_ON_READY_TYPES.has(t)) {
        const q = pendingReadyReplay.get(window.id) ?? [];
        q.push({ channel, payload });
        pendingReadyReplay.set(window.id, q);
        return true;
      }
    }
    webContents.send(channel, payload);
    return true;
  } catch (error) {
    if (!isWindowIpcDisposalError(error)) {
      console.warn(`[main] failed to send IPC "${channel}":`, error);
    }
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════
// 自定义协议 neox-asset:// — Markdown 预览里加载本地图片用
// ═══════════════════════════════════════════════════════════════════
// 必须在 app.ready 之前注册 scheme; 后面在 whenReady 里注册 handler.
// standard: true 让它支持相对路径; supportFetchAPI: true 让 fetch 也能用.
// bypassCSP 让 <img src="neox-asset://..."> 不被 renderer CSP 拦.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'neox-asset',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      bypassCSP: true,
      stream: true,
    },
  },
  {
    scheme: 'neox-plugin',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
  {
    /* 桌宠用户导入的 .glb 文件协议 — 服务 <userData>/pets/<fileName>.glb
     * 跟 neox-asset 隔离, 因为安全策略不同 (pets 目录是固定 whitelist, asset 是 workspace 内) */
    scheme: 'neox-pet',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      bypassCSP: true,
    },
  },
]);

const NEOX_ASSET_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.heic': 'image/heic',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.pdf': 'application/pdf',
};

function systemTempRoots(): string[] {
  const out = new Set<string>();
  const add = (p?: string | null): void => {
    if (!p) return;
    try { out.add(pathResolve(p)); } catch { /* 非法路径就跳过 */ }
    try { out.add(pathResolve(realpathSync(p))); } catch { /* 不存在就只留原样 */ }
  };
  add(tmpdir());
  if (process.platform !== 'win32') add('/tmp');
  return Array.from(out);
}

function registerNeoxAssetProtocol(): void {
  protocol.handle('neox-asset', async (request) => {
    try {
      const url = new URL(request.url);
      // pathname 保留前导 `/`, 在 POSIX 上它就是目标绝对路径 —— 去掉的话
      // pathResolve 会当成相对路径拼在 cwd 之下, 所有请求都 404.
      const rawPath = decodeURIComponent(url.pathname);
      if (!rawPath || rawPath === '/') return new Response('Bad request', { status: 400 });

      const absolutePath = pathResolve(assetPathnameToAbsolute(rawPath));
      // 检查落在任意已开 workspace 内 —— 遍历 projectManager 的所有 scope, 且展开每个 scope
      // 老实现只取 s.workspacePath (每个 scope 的 primary root), 忽略 storageService 里为该
      // primary root 登记的其它 roots — 副根里的图片全被拒.
      const scopes = projectManager?.listAll?.() || [];
      const allowedRoots = new Set<string>();
      for (const s of scopes) {
        const primary = pathResolve(s.workspacePath);
        allowedRoots.add(primary);
        try {
          const roots = storageService.getWorkspaceRootsSync(s.workspacePath) || [];
          for (const r of roots) {
            if (r) allowedRoots.add(pathResolve(r));
          }
        } catch { /* storage 读失败也不阻塞主流程 */ }
      }
      /* Neox 拥有的 artifact 根 (图片直连出图 / 生成物落这里) — 不是 workspace 但 renderer 要能显示.
       * 见 project_neox_artifacts_contract. 图片工作台的 file:// 显示不出来就是这条没放行. */
      allowedRoots.add(pathResolve(join(app.getPath('userData'), 'neox-artifacts')));
      /* Computer Use 的窗口截图 (~/.neox/run/shots) —— AX 读不到元素的 App 只有这张图能看,
       * 时间线卡片要显示它。桥默认写系统临时目录, 那里是 403, 所以 neox-core 明确落在这。 */
      allowedRoots.add(pathResolve(join(homedir(), NEOX_HOME_DIRNAME, 'run', 'shots')));
      allowedRoots.add(pathResolve(join(homedir(), NEOX_HOME_DIRNAME, 'run', 'icons')));
      /* 模型看过的图 (~/.neox/run/seen) —— 读图 / 浏览器截图的 base64 由宿主落成文件,
       * 时间线据此把「它看见的」摆给用户看。同一个 12000 字符上限的理由 (core seenImages.ts)。 */
      allowedRoots.add(pathResolve(join(homedir(), NEOX_HOME_DIRNAME, 'run', 'seen')));
      /* 判等走 workspaceKey —— Windows 下路径大小写不敏感 (主进程写的是 lowercase,
       * 这里拿到的是渲染层传来的原始写法), 用裸 startsWith 会把自己工作区里的图片判成
       * 越权 403。这是 3b7f3c3ba 统一过的同一个口径。 */
      {
        const { getNeoxUserRoot } = await import('@neoxlabs/core/runtime/modeHome.js');
        allowedRoots.add(pathResolve(getNeoxUserRoot()));
        /* 老位置也放行: 迁移没跑 / 用户手动留一份的机器上, 历史产物还得能显示 */
        allowedRoots.add(pathResolve(join(homedir(), 'Documents', 'Neox')));
      }
      for (const t of systemTempRoots()) allowedRoots.add(t);
      let realPath = absolutePath;
      try { realPath = realpathSync(absolutePath); } catch { /* 不存在就按原路径判, 后面读文件自然 404 */ }
      if (isSensitiveReadPath(absolutePath, homedir(), process.platform) || isSensitiveReadPath(realPath, homedir(), process.platform)) {
        console.warn('[neox-asset] 403 sensitive path:', absolutePath);
        return new Response('Forbidden', { status: 403 });
      }
      const allowed = isUnderAnyRoot(absolutePath, allowedRoots, workspaceKey)
        || isPreviewableExt(extname(absolutePath));
      if (!allowed) {
        console.warn('[neox-asset] 403 not previewable outside workspaces:', absolutePath);
        return new Response('Forbidden', { status: 403 });
      }

      const mime = NEOX_ASSET_MIME[extname(absolutePath).toLowerCase()] || 'application/octet-stream';
      /* Range (视频拖进度条): 只读请求的那一段, 回 206 —— 整个 mp4 读进内存再回 200 时 <video> 无法跳转 */
      const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') || '');
      if (range) {
        const size = statSync(absolutePath).size;
        const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2] || 0));
        const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        if (start >= size || start > end) {
          return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
        }
        const { open } = await import('node:fs/promises');
        const fh = await open(absolutePath, 'r');
        try {
          const chunk = Buffer.alloc(end - start + 1);
          await fh.read(chunk, 0, chunk.length, start);
          return new Response(new Uint8Array(chunk), {
            status: 206,
            headers: {
              'Content-Type': mime,
              'Content-Range': `bytes ${start}-${end}/${size}`,
              'Content-Length': String(chunk.length),
              'Accept-Ranges': 'bytes',
              'Cache-Control': 'no-cache',
            },
          });
        } finally {
          await fh.close();
        }
      }
      const buffer = await fsReadFile(absolutePath);
      return new Response(new Uint8Array(buffer), {
        status: 200,
        headers: { 'Content-Type': mime, 'Cache-Control': 'no-cache', 'Accept-Ranges': 'bytes' },
      });
    } catch (err: any) {
      console.warn('[neox-asset] failed:', err?.message || err);
      return new Response('Not found', { status: 404 });
    }
  });
}

app.whenReady().then(registerNeoxAssetProtocol);
app.whenReady().then(async () => {
  const { registerPluginProtocolHandler } = await import('./pluginView/pluginProtocol.js');
  registerPluginProtocolHandler();
});

app.whenReady().then(async () => {
  try {
    const { sweepRetiredPacks } = await import('./services/assetPackService.js');
    sweepRetiredPacks();
  } catch (e) {
    console.warn('[assetpack] 清理下线组件失败:', (e as Error)?.message ?? e);
  }
});

app.whenReady().then(async () => {
  try {
    /* G1: init audit log — 依赖 P5 master key, 所以放在 bootstrap 之后. 这里早期调,
     *     audit key 派不出来时静默丢, P5 bootstrap 完后第一次 appendEntry 会重新拿到 key. */
    const { initAuditLog, appendEntry } = await import('@neoxlabs/platform/platform/auditLog.js');
    await initAuditLog();
    void appendEntry('app.started', { platform: process.platform, version: app.getVersion?.() });

    if (process.env.NODE_ENV !== 'development') {
      const t = setTimeout(() => {
        void (async () => {
          try {
            const { verifyCodeSign } = await import('@neoxlabs/platform/platform/codeSignVerify.js');
            const binPath = process.platform === 'darwin'
              ? app.getPath?.('exe').replace(/\/Contents\/MacOS\/.+$/, '') ?? ''
              : process.execPath;
            const r = verifyCodeSign(binPath);
            if (!r.ok) {
              console.warn('[Main] G3 codesign FAIL:', r);
              void appendEntry('codesign.fail', r);
            } else {
              void appendEntry('codesign.ok', { reason: r.reason });
            }
          } catch (e: any) {
            console.warn('[Main] G3 codesign check threw:', e?.message ?? e);
          }
        })();
      }, 5_000);
      /* 不拦退出 —— 关窗口时这一发还没跑就不用跑了 */
      t.unref?.();
    }
  } catch (err) {
    console.warn('[Main] G1/G3 setup failed:', err);
  }
});

app.whenReady().then(async () => {
  try {
    const { cleanupPlaintextBackups } = await import('@neoxlabs/platform/platform/plaintextBackupCleaner.js');
    const r = cleanupPlaintextBackups();
    if (r.length) console.log('[Main] SEC-1 plaintext backup cleanup:', r.map(x => `${x.action}:${x.file.split('/').pop()}`).join(', '));
  } catch (err) {
    console.warn('[Main] SEC-1 cleanup failed:', err);
  }
});

app.whenReady().then(async () => {
  try {
    const { enforceAntiDebug } = await import('@neoxlabs/platform/platform/antiDebug.js');
    enforceAntiDebug({ strict: false }); /* 暂不退出, 先 audit + warn */
  } catch (err) {
    console.warn('[Main] SEC-2 antidebug setup failed:', err);
  }
});

app.whenReady().then(async () => {
  try {
    const { getModeHomeDir, ensureModeHome, movedLegacyModeHomes } = await import('@neoxlabs/core/runtime/modeHome.js');
    const { getDatabase } = await import('@neoxlabs/platform/platform/database.js');
    ensureModeHome('work');
    ensureModeHome('code');
    ensureModeHome('pilot');
    for (const { from, to } of movedLegacyModeHomes()) {
      const db = getDatabase();
      const n = db.rebaseSessionWorkspacePaths(from, to, pathSep)
        + db.rebaseSessionTaskDirs(from + pathSep, to + pathSep);
      if (n) console.log(`[Main] 🎭 迁移: ${n} 处会话路径 ${from} → ${to}`);
    }
    const moved = getDatabase().rebindModeSessionsToHome({
      work: getModeHomeDir('work'),
    });
    if (moved) console.log(`[Main] 🎭 迁移: ${moved} 个 Work/Life 会话已改绑到 mode home`);
  } catch (err) {
    console.warn('[Main] mode-session rebind migration failed:', err);
  }
});

app.whenReady().then(async () => {
  try {
    const { setupCertPinning, getCertPinStatus } = await import('@neoxlabs/platform/platform/certPin.js');
    setupCertPinning();
    const st = getCertPinStatus();
    if (st.enabled) console.log('[Main] P6.A cert pinning:', st);
  } catch (err) {
    console.warn('[Main] P6.A cert pinning setup failed:', err);
  }
});

/* DB master key bootstrap.
 * 启动早期预热 machine-id 派生 key, 必须在第一次 new NeoxDatabase 之前完成。
 * 这条路径不访问 macOS Keychain, 避免启动时出现系统密码框。 */
app.whenReady().then(async () => {
  try {
    const { bootstrapMasterKey, getMasterKeySource } = await import('@neoxlabs/platform/platform/dbCipher.js');
    await bootstrapMasterKey();
    console.log('[Main] database master key source:', getMasterKeySource());
  } catch (err) {
    console.warn('[Main] database master key bootstrap failed:', err);
  }
});

app.whenReady().then(async () => {
  try {
    const cfg = await import('@neoxlabs/platform/utils/config.js' as any);
    const dbMod = await import('@neoxlabs/platform/platform/database.js' as any);
    const r0 = dbMod.migrateLiteHomeToStandard();
    if (!r0.skipped) {
      console.log(`[Main] lite-home merge: ${r0.files} file(s) → ~/.neox`);
    }
    const r1 = cfg.migratePerUserBucketsToGlobal();
    if (r1.migratedProviders > 0) {
      console.log(`[Main] BYOK migration: ${r1.migratedProviders} providers from ${r1.scannedBuckets} bucket(s) → global`);
    }
    const db = await import('@neoxlabs/platform/platform/database.js' as any);
    const r2 = db.migratePerUserDbToGlobal();
    if (r2.dbFiles > 0 || r2.failedDbFiles > 0) {
      console.log(`[Main] DB migration: merged ${r2.dbFiles} db file(s) → global (${r2.sessions} new sessions, ${r2.failedDbFiles} failed)`);
    }
  } catch (err) {
    console.warn('[Main] BYOK/DB migration skipped:', err);
  }
});

/* Phase E · Main → Renderer IPC 心跳 — 每 15s 广播 'neox:heartbeat', 让 renderer
 *   感知主进程是否活着. Renderer 侧 30s 无 heartbeat → 视为 IPC 通路挂了,
 *   配合 STALE_WATCHDOG 的 stream 停 120s 双重检测.
 *   Interval 挂在 app.whenReady 内一次, 全生命周期跑; unref 防阻退出. */
app.whenReady().then(async () => {
  try {
    const { BrowserWindow } = await import('electron');
    const heartbeatTimer = setInterval(() => {
      try {
        const payload = { atMs: Date.now(), pid: process.pid };
        for (const w of BrowserWindow.getAllWindows()) {
          sendWindowIpcIfAlive(w, 'neox:heartbeat', payload);
        }
      } catch { /* 单帧发送失败不影响后续 */ }
    }, 15_000);
    /* unref (审计 P2): 心跳只在 app 活着时有意义, 不让 timer 阻退出. */
    heartbeatTimer.unref?.();
    console.log('[main] heartbeat interval attached (15s)');
  } catch (err: any) {
    console.warn('[main] heartbeat setup failed:', err?.message);
  }
});

app.whenReady().then(async () => {
  try {
    const { targetEvents } = await import('@neoxlabs/core/tools/targetModeTools.js' as any);
    const { BrowserWindow } = await import('electron');
    targetEvents.on('snapshot', (snapshot: unknown) => {
      try {
        for (const w of BrowserWindow.getAllWindows()) {
          sendWindowIpcIfAlive(w, 'neox:target:snapshot', snapshot);
        }
      } catch { /* 单窗关闭中不影响其他窗口 */ }
    });
    console.log('[main] target event bridge attached');
  } catch (err: any) {
    console.warn('[main] target event bridge setup failed:', err?.message);
  }
});

app.whenReady().then(async () => {
  try {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const neoxDir = path.join(os.homedir(), NEOX_HOME_DIRNAME);
    if (!fs.existsSync(neoxDir)) return;
    const residue = [
      'routing.json.bak',
      'command-helper.sock',  /* sock 已挪到 /tmp, 旧的删 */
    ];
    for (const f of residue) {
      try { fs.unlinkSync(path.join(neoxDir, f)); } catch { /* 已不在 */ }
    }
    /* 老 pid 文件 (server-*.pid) — 现在 pid 走 /tmp/neox-runtime/, 旧位置全清 */
    try {
      const entries = fs.readdirSync(neoxDir);
      for (const e of entries) {
        if (/^server-[a-f0-9]+\.pid$/.test(e)) {
          try { fs.unlinkSync(path.join(neoxDir, e)); } catch { /* ignore */ }
        }
      }
    } catch { /* readdir 失败也没事 */ }
    console.log('[Main] P2 cleanup: removed legacy files from ~/.neox/');
  } catch (err) {
    console.warn('[Main] P2 cleanup failed:', err);
  }
});

/* P0-3 (auth coordination): fs.watch auth.enc 让 Desktop main 感知 CLI / 其它 Neox 实例的外部
 * auth 变化, 自动广播给 renderer → gatewayKeyService.subscribe 触发 → 不再覆盖 CLI 写的 nxk. */
app.whenReady().then(async () => {
  try {
    const { installAuthFileWatcher } = await import('./services/authFileWatcher.js');
    const { tokenDirPath, tokenFilePath } = await import('./ipc/authHandlers.js');
    installAuthFileWatcher(tokenFilePath(), tokenDirPath());
  } catch (err: any) {
    console.warn('[main] installAuthFileWatcher failed:', err?.message ?? err);
  }
});

/* Provider / model 配置热重载: 监听全局 ~/.neox/config.json,
 *   外部手改配置、其他窗口保存、当前窗口保存后自动广播给 renderer 重拉 provider/models。 */
app.whenReady().then(async () => {
  try {
    const { installProviderConfigWatcher } = await import('./services/providerConfigWatcher.js');
    installProviderConfigWatcher();
  } catch (err: any) {
    console.warn('[main] installProviderConfigWatcher failed:', err?.message ?? err);
  }
});

/* neox-pet:// — 服务 <userData>/pets/<fileName>.glb 给桌宠窗口的 useGLTF 用.
 * URL 结构: neox-pet://local/<fileName>.glb  (basename only, 防路径遍历)
 * 校验在 resolveCustomSkinPath 里: .glb 结尾 + 无 / \\ ..  + 文件存在. */
app.whenReady().then(async () => {
  const { resolveCustomSkinPath } = await import('./services/petStorage.js');
  protocol.handle('neox-pet', async (request) => {
    try {
      const url = new URL(request.url);
      const fileName = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const absolutePath = resolveCustomSkinPath(fileName);
      if (!absolutePath) {
        return new Response('Not found', { status: 404 });
      }
      const buffer = await fsReadFile(absolutePath);
      return new Response(new Uint8Array(buffer), {
        status: 200,
        headers: {
          'Content-Type': 'model/gltf-binary',
          'Cache-Control': 'no-cache',
        },
      });
    } catch (err: any) {
      console.warn('[neox-pet] failed:', err?.message || err);
      return new Response('Error', { status: 500 });
    }
  });
});
/* localSecretCipher (机器派生 key + AES-256-GCM) 自加密, 永远可用, 无需启动期检测. */

/* ─────────────────────────────────────────────────────────────────────
 * Auth bootstrap — 提前刷新 token 并同步 currentUserId.
 * BYOK providers / sessions 已全局化, 这里的 userId 只用于登录态私有资源和缓存失效,
 * 不再切换 config/db 路径.
 * ────────────────────────────────────────────────────────────────────── */
const authBucketReadyPromise = app.whenReady().then(async () => {
  try {
    const { setAuthHostBindings } = await import('./ipc/authHostBindings.js');
    setAuthHostBindings({
      broadcastAuthChanged: (payload, excludeId) => {
        for (const w of BrowserWindow.getAllWindows()) {
          if (!w.isDestroyed() && w.webContents.id !== excludeId) {
            w.webContents.send('auth:changed', payload);
          }
        }
      },
      legacyUserDataDir: () => { try { return app.getPath('userData'); } catch { return null; } },
      appVersion: () => { try { return app.getVersion(); } catch { return ''; } },
      isPackaged: () => app.isPackaged,
    });

    const { restoreAuthIdentity, ensureFreshDesktopAuthTokens } = await import('./ipc/authHandlers.js');
    await restoreAuthIdentity();
    /* token 网络刷新 (快过期时一次 /auth/refresh 往返) 摘出建窗关键路径, 后台跑;
     * 完成后照旧广播, 让 renderer 刷新云端 sentinel / 会员态。 */
    void ensureFreshDesktopAuthTokens()
      .catch((e: any) => {
        console.warn('[main] auth token refresh failed (continuing with local identity):', e?.message ?? e);
      })
      .then(async () => {
        try {
          const { BrowserWindow } = await import('electron');
          for (const w of BrowserWindow.getAllWindows()) {
            sendWindowIpcIfAlive(w, 'neox:sessions-changed', { reason: 'auth-db-ready' });
          }
        } catch { /* window 可能还没创建 — 无害 */ }
      });
  } catch (e: any) {
    console.warn('[main] auth bootstrap failed (continuing anonymous):', e?.message ?? e);
  }
});

app.whenReady().then(async () => {
  try {
    const { setupAutoUpdate } = await import('./autoUpdate.js');
    await setupAutoUpdate();
  } catch (e: any) {
    console.warn('[main] auto-update setup failed (non-fatal):', e?.message ?? e);
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * 登出清理总线 — 注册下游清理 handler. authHandlers `auth:clear-tokens`
 * 触发 runLogout() 时按注册顺序执行, 让 mobile-bridge / cloud-session /
 * cloud-relay / paired devices 等都跟着登出走干净.
 * ────────────────────────────────────────────────────────────────────── */
app.whenReady().then(async () => {
  try {
    const { onLogout } = await import('./services/logoutBus.js');

    /* 1. 先停 presence — server 立刻 broadcast offline 给订阅的 mobile, 体感快. */
    onLogout(async () => {
      try {
        const { stopPresenceClient } = await import('./mobile-bridge/index.js');
        await stopPresenceClient();
      } catch (e: any) {
        console.warn('[logout] stopPresenceClient failed:', e?.message ?? e);
      }
    });

    /* 2. 停 cloud relay client — 中转 channel 立即断开, 防 A 的手机继续推 RPC. */
    onLogout(async () => {
      try {
        const { stopCloudRelayClient } = await import('./mobile-bridge/index.js');
        await stopCloudRelayClient();
      } catch (e: any) {
        console.warn('[logout] stopCloudRelayClient failed:', e?.message ?? e);
      }
    });

    /* 3. 清 cloud-session 内存 store — relayKey + agentDeviceId 全擦, 防 B 登录看到 A 的会话. */
    onLogout(async () => {
      try {
        const { remoteSessions } = await import('./remoteSessions.js');
        remoteSessions().clear();
      } catch (e: any) {
        console.warn('[logout] cloudSessionStore.clear failed:', e?.message ?? e);
      }
    });

    /* 4. 删 gateway-key.enc — 防上一户的 nxk 残留给下一户用 (跟 renderer side
     *   gatewayKeyService.clearGatewayKey 双保险, 任一窗口走 logout 都生效). */
    onLogout(async () => {
      try {
        const { clearGatewayKey } = await import('./ipc/gatewayKeyHandlers.js');
        await clearGatewayKey();
      } catch (e: any) {
        console.warn('[logout] clear gateway-key failed:', e?.message ?? e);
      }
    });

    /* 5. 撤销当前 user 名下所有 mobile 配对 — 防 B 登录看到 A 配的手机.
     *   通用配对 (owner_user_id=null, 老数据) 保留, 不影响向后兼容. */
    onLogout(async ({ previousUserId }) => {
      if (!previousUserId) return;
      try {
        const { removePairedMobilesForUser } = await import('./mobile-bridge/deviceStore.js');
        const removed = removePairedMobilesForUser(previousUserId);
        if (removed > 0) console.log(`[logout] removed ${removed} paired mobiles for user ${previousUserId}`);
      } catch (e: any) {
        console.warn('[logout] removePairedMobilesForUser failed:', e?.message ?? e);
      }
    });

    console.log('[logoutBus] handlers registered');
  } catch (e: any) {
    console.error('[main] failed to register logout handlers:', e?.message ?? e);
  }
});

app.whenReady().then(() => new Promise<void>((resolve) => {
  const t = setTimeout(resolve, 2_500);
  (t as any).unref?.();
})).then(async () => {
  /* 测试实例 (E2E / verify) 复用用户登录态: 不许它以用户的设备身份配对手机、上传会话索引 */
  if (process.env.NEOX_DISABLE_MOBILE_BRIDGE === '1') return;
  try {
    const { startMobileBridge, setMobileBridgeProjectManager, ensureCloudRelayClientRunning, startPresenceClient } =
        await import('./mobile-bridge/index.js');
    /* 注 projectManager 让 wsServer session.input handler 能拿
     *  workspace 的 AgentBridge 来真正触发 agent run (而非只 appendMessage). */
    setMobileBridgeProjectManager(projectManager);
    await startMobileBridge();
    /* P5 — Presence client. 只要 desktop 登过 NeoxCloud 就常驻 (跟 mobile-bridge 解耦):
     *   Phone 通过订阅看到 desktop online → 自动重连. 详见 内部设计文档 */
    /* announce 心跳 —— **故意放在下面那个 `if (token)` 之外**.
     *
     * 它要覆盖的恰恰是"启动这一刻还没登录"的情况: 原来整块 presence+announce 都在
     * token 判断里面, 启动时没 token 就整个会话再也不 announce, 手机永远看不到这台机器,
     * 只能靠用户重启 App 才恢复。心跳自己会在登录之后的下一拍自愈。
     *
     * 另一半意义是让 last_announce_at 真的表示"还活着", 以及让 capabilities 里的
     * lan_ip/lan_port 保持当前值 —— 换 Wi-Fi / 换端口之后手机才连得上。 */
    try {
      const { startDeviceAnnounceHeartbeat } = await import('./ipc/authHandlers.js');
      startDeviceAnnounceHeartbeat();
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.warn('[devices/announce] heartbeat start failed:', e?.message ?? e);
    }
    try {
      const { ensureFreshDesktopAuthTokens } = await import('./ipc/authHandlers.js');
      /* force=true — 启动期主动 refresh 一次, 让常驻 presence / relay 拿到长期有效 token,
       *   避免 token 几小时后过期才发现 (用户重连等待 → mobile 看不到 desktop online). */
      const tok = await ensureFreshDesktopAuthTokens({ force: true });
      if (tok?.accessToken) {
        const os = await import('node:os');
        // eslint-disable-next-line no-console
        console.log('[presence] starting desktop presence client (SSO main account)');
        await startPresenceClient({
          serverBaseUrl: resolveCloudEndpoints().api,
          bearerJwt: tok.accessToken,
          deviceName: (await import('./mobile-bridge/deviceStore.js')).getDeviceName(),
        });
        /* 启动 auto-pair poller — 5min 拉一次 server 同账号 mobile, 自动 ECDH 派生 + 落 paired_mobiles */
        try {
          const { startAutoPairPoller } = await import('./mobile-bridge/autoPairPoller.js');
          startAutoPairPoller();
        } catch (e: any) {
          // eslint-disable-next-line no-console
          console.warn('[auto-pair] poller start failed:', e?.message ?? e);
        }
      }
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.warn('[presence] start failed (will retry on login):', e?.message ?? String(e));
    }
    try {
      const r = await ensureCloudRelayClientRunning();
      // eslint-disable-next-line no-console
      console.log(`[mobile-bridge] 云中继: ${r}`
        + (r === 'no_paired_mobile' ? ' (待配对后自动启动)' : '')
        + (r === 'disabled' ? ' (用户显式停用)' : ''));
    } catch (e: any) {
      /* 首连失败时 client 仍在后台重连 (见 startCloudRelayClient), 这里只记一笔 */
      // eslint-disable-next-line no-console
      console.warn('[mobile-bridge] 云中继启动失败 (后台重连中):', e?.message ?? String(e));
    }
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.error('[mobile-bridge] failed to start:', e?.message ?? String(e));
  }
});
let quitCleanupStarted = false;
let quitCleanupDone = false;
app.on('before-quit', (event) => {
  markWindowsAppQuitting();
  if (quitCleanupDone) return;
  event.preventDefault();
  if (quitCleanupStarted) return;

  quitCleanupStarted = true;
  void (async () => {
  const runningOwned = await withQuitTimeout(
    projectManager?.countRunningOwnedServices?.() ?? Promise.resolve(0), 1_500, 0, 'countRunningOwnedServices');
  if (runningOwned > 0) {
    const zh = (() => {
      try { return configService.getLanguagePreference() !== 'en'; }
      catch { try { return app.getLocale().toLowerCase().startsWith('zh'); } catch { return true; } }
    })();
    const choice = dialog.showMessageBoxSync({
      type: 'question',
      buttons: zh ? ['退出', '取消'] : ['Quit', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: zh
        ? `还有 ${runningOwned} 个服务在运行`
        : `${runningOwned} service${runningOwned === 1 ? ' is' : 's are'} still running`,
      detail: zh
        ? '退出 Neox 会一并停止这些服务。它们的配置和日志会保留, 下次打开可以直接启动。'
        : 'Quitting Neox will stop them. Their configs and logs are kept — you can start them again next time.',
    });
    if (choice !== 0) {
      /* 取消退出: 复位 latch, 下次 ⌘Q 重新问 (计数改异步后必须显式复位)。
       * Windows 上是关掉最后一个窗口触发的退出, 取消后得把窗口开回来, 否则成了无窗进程。 */
      quitCleanupStarted = false;
      cancelPendingWindowsUpdateInstall();
      reopenWindowIfNone('用户取消退出');
      return;
    }
  }
  armQuitWatchdog();

  const cleanup = (async () => {
    /* 服务清场跟其它清理并行跑 —— 它自带 1.5s 宽限期, 串行会把总时长顶到 3s 硬超时之外。 */
    const killChain = (async () => {
      try {
        /* 遍历所有 scope 各自的 runtime —— 每条 worker 有自己的进程表, 漏一个 scope
         * 就是那个工程的服务全变孤儿。见 ProjectManager.killAllProjectServices。 */
        const r = await projectManager?.killAllProjectServices();
        console.log(`[Main] 退出清场: killed=${r?.killed ?? 0} hardKilled=${r?.hardKilled ?? 0} scopes=${r?.scopes ?? 0}`);
        /* 兜底: in-process 模式 (逃生开关 / worker 回落) 下进程表就在主进程这边。
         * 上面那趟已经清过的, 这趟只会数到 0, 不会重复杀。 */
        const local = await processManager.killAllTracked({ terminatedBy: 'system' });
        if (local.killed > 0) console.log(`[Main] 退出清场 (主进程兜底): killed=${local.killed}`);
      } catch (err: any) {
        console.error('[Main] 退出清场 failed:', err?.message);
      }
    })();
    const restChain = (async () => {
    try {
      const { stopMobileBridge, stopPresenceClient } = await import('./mobile-bridge/index.js');
      /* 先 stopPresenceClient (优雅 unregister, server 立刻 broadcast offline 给订阅 Phone) */
      await stopPresenceClient();
      await stopMobileBridge();
    } catch { /* ignore */ }
    /* 外置 Chrome (若已启动) 也随主进程退出优雅关闭. Chrome 会保存 session,
     *  下次 Neox 冷启后再开同 profile 直接恢复标签. */
    try {
      /* Chrome 归各个 runtime 持有 (core hostedChrome) —— 挨个让它们关 */
      const { AgentBridge } = await import('./services/agentBridge.js');
      await AgentBridge.shutdownAllBrowsers();
    } catch { /* ignore */ }
    try {
      const { shutdownAllWorkspaceWatchers } = await import('./ipc/workspaceWatcherHandlers.js');
      shutdownAllWorkspaceWatchers();
    } catch { /* ignore */ }
    /* 自更新周期检查 timer 停掉 (审计 P2: 长期 interval 无清理). */
    try {
      const { disposeAutoUpdate } = await import('./autoUpdate.js');
      disposeAutoUpdate();
    } catch { /* ignore */ }
    try {
      const { installStagedUpdateOnQuit } = await import('./autoUpdate.js');
      await installStagedUpdateOnQuit();
    } catch { /* ignore */ }
    })();
    await Promise.all([killChain, restChain]);
    try {
      await projectManager?.disposeAll();
    } catch { /* ignore */ }
  })();
  /* 3s 硬超时 > killAllTracked 的 1.5s 宽限期, 清场能完整跑完; 真挂死时仍然兜得住。 */
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 3_000));
  await Promise.race([cleanup, timeout]);
  quitCleanupDone = true;
  app.quit();
  })();
});

// ═══════════════════════════════════════════════════════════════════
// neox:// deep link 协议 — OAuth PKCE 浏览器登录回跳
// ═══════════════════════════════════════════════════════════════════
// 必须在 app.ready 之前注册 protocol; mac 上注册即可, win/linux 需要 .exe path 参数.
//   开发环境 npx electron 启动时, win 上 setAsDefaultProtocolClient 不生效 (二进制是 electron.exe),
//   生产 build 后 (electron-builder) 会自动写入安装包 protocol 注册表项.
//
// 单实例锁: win/linux 上 deep link 会启新进程, 需要锁让二次实例转发参数到主实例.
// mac 上不会启新进程, 走 'open-url' 事件.
if (process.defaultApp) {
  /* dev 模式 (npx electron path/to/main.js) */
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(DISTRIBUTION.protocol, process.execPath, [pathResolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient(DISTRIBUTION.protocol);
}

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
  app.exit(0);
}

import { oauthFlow } from './services/oauthFlow.js';
import { ensureEditorLinkToken, handleEditorLink, drainEditorLinkRequests } from './services/editorLink.js';

/* 外部编辑器插件的深链口令 (见 services/editorLink.ts) —— 启动即落盘, 插件读它 */
let editorLinkToken = '';
try { editorLinkToken = ensureEditorLinkToken(); } catch (err) { console.warn('[editorLink] token init failed:', err); }

/** neox:// 深链分发: 先给编辑器插件那条 (neox://editor/...), 不是再交给 OAuth 回调 */
function dispatchDeepLink(url: string): void {
  void (async () => {
    if (editorLinkToken) {
      const handled = await handleEditorLink(url, {
        token: editorLinkToken,
        pickWindow: (workspace) => {
          /* 冷启动被深链拉起时 projectManager 还没建 (甚至还在 TDZ) —— 那就不挑, 请求留在队列里等渲染层来取 */
          let scope: ReturnType<ProjectManager['getByPath']> | null = null;
          try { scope = workspace && projectManager ? projectManager.getByPath(workspace) : null; } catch { scope = null; }
          if (scope && !scope.disposed) return scope.window;
          return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null;
        },
      });
      if (handled) return;
    }
    await oauthFlow.handleDeepLink(url);
  })().catch(err => console.warn('[deeplink] failed:', err?.message || err));
}
ipcMain.handle('editor-link:drain', () => drainEditorLinkRequests());

/**
 * mac OS — 单实例 + 浏览器跳 deep link 时不会启新进程,
 * 走 'open-url' 事件. 必须在 app.ready 之前 .on('open-url'),
 * 否则启动时点 deep link 可能丢.
 */
app.on('open-url', (event, url) => {
  event.preventDefault();
  if (url.startsWith(DEEP_LINK_PREFIX)) dispatchDeepLink(url);
});
/* Windows / Linux 冷启动: 深链在本进程自己的 argv 里 (second-instance 只管"已经开着"的情况) */
for (const arg of process.argv) {
  if (typeof arg === 'string' && arg.startsWith(`${DEEP_LINK_PREFIX}editor/`)) dispatchDeepLink(arg);
}

/**
 * win + linux — 二次实例的 argv 里包含 deep link, 主实例从这接.
 * mac 上这事件不会触发 (走 open-url).
 */
app.on('second-instance', (_event, argv) => {
  /* 用户双击图标启二次实例是想"回到 app" — 把已有窗口拉回前台,
   * 否则二次实例静默退出, 用户以为 app 没反应. 聚焦模式跟 openWindowWithWorkspace 一致. */
  const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
  if (win) {
    try {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    } catch { /* 窗口正在销毁中 — 忽略 */ }
  } else if (!quitCleanupStarted) {
    reopenWindowIfNone('second-instance');
  }
  for (const arg of argv) {
    if (typeof arg === 'string' && arg.startsWith(DEEP_LINK_PREFIX)) dispatchDeepLink(arg);
  }
});


try {
  const { hardenLegacySecretPerms } = await import('./services/localSecretCipher.js');
  hardenLegacySecretPerms();
} catch { /* 收紧失败不该挡启动 */ }

const initialCliDebug = configService.getCliDebugPreference();
process.env.CLI_DEBUG = initialCliDebug ? '1' : '';
if (initialCliDebug && !process.env.NEOX_DIAG_LOG) process.env.NEOX_DIAG_LOG = '1';
// 标记 UI 模式，用于区分 CLI 和 Electron UI
process.env.NEOX_UI_MODE = '1';

// 由 debug 开关控制（默认关闭），与 CLI 的 cli-*.log 分开
import { neoxLogger } from '@neoxlabs/kernel/platform/neoxLogger.js';
import { getAppVersion } from './appVersion.js';
/* 只在出包后写入: dev 读的是仓里的 3.5.x, 拿去拦「要 3.7」的插件会把本地装插件打挂 */
if (app.isPackaged) {
  process.env.NEOX_APP_VERSION = getAppVersion();
}
if (initialCliDebug) {
  neoxLogger.setEnabled(true);
  neoxLogger.info('ELECTRON', 'Neox app started, debug logging enabled → neox-app-*.log');
}

const __dirname = dirname(fileURLToPath(import.meta.url));
if (process.platform === 'darwin') {
  app.name = DISTRIBUTION.appName;
  app.setName(DISTRIBUTION.appName);
  app.setAboutPanelOptions({
    applicationName: DISTRIBUTION.appName,
    applicationVersion: app.getVersion(),
  });
}
if (process.platform === 'win32') {
  // Keep Windows caption buttons in dark style so they match Neox dark titlebar.
  nativeTheme.themeSource = 'dark';
}
const isDev = !app.isPackaged;

// ═══════════════════════════════════════════════════════════════════
// Scope 基础设施
// ═══════════════════════════════════════════════════════════════════
// AppScope: 主进程单例, 持有 ProjectManager 等 app 级 service.
const appScope = new AppScope();


// ProjectManager 是下面构造的, 但 createSessionStateServices 的 getBridgeForSession
// 回调需要引用它. 用 let + 后赋值绕开构造循环依赖 (projectManager 的
// bootstrapProjectServices 又需要 updateSessionContextUsed).
let projectManager: ProjectManager;

// ==================== Session 存储 ====================
const {
  sessionsCache,
  getSessionOrThrow,
  persistSession,
  updateSessionContextUsed,
  getSqliteSession,
  refreshSession,
} = createSessionStateServices((session) => {
  if (!session.workspacePath) return undefined;
  const scope = projectManager.getByPath(session.workspacePath);
  return scope?.peekService(AGENT_BRIDGE);
});

// ═══════════════════════════════════════════════════════════════════
// ProjectManager 实例化 + bootstrap
// ═══════════════════════════════════════════════════════════════════
/**
 * 在 ProjectScope 里注册所有项目级 service.
 * 目前 (Step 4) 只注册 OwnedIdsTracker —— 其他 service 在 Step 5 里陆续迁移进来.
 */
function bootstrapProjectServices(scope: ProjectScope): void {
  // OwnedIdsTracker: 追踪本 scope 拥有的 terminal/process/debug id, 事件路由用
  scope.register(OWNED_IDS_TRACKER, () => new OwnedIdsTracker());

  // RunProcessManager: 每个 scope 一个独立的进程池, 事件发给本 scope 的 window.
  // ProjectService 基类会自动把 dispose 挂到 scope.onDispose —— 项目关闭时
  // 本 scope 的所有 pty 被 SIGKILL 清理.
  scope.register(RUN_PROCESS_MANAGER, (s) => new RunProcessManager(s));

  // TerminalService: 每个 scope 一个独立实例. node-pty sessions 天然绑在实例 Map 里,
  // 不同 scope 的终端互不影响. dispose 时调 destroyAll() 杀掉本 scope 的所有 session.
  // data/exit 事件直接路由到本 scope 的 window, 不走全局 mainWindow.
  scope.register(TERMINAL_SERVICE, (s) => {
    const ts = new TerminalService();
    const sendIfAlive = (channel: string, payload: unknown): void => {
      sendWindowIpcIfAlive(s.window, channel, payload);
    };
    ts.on('data', (event: { sessionId: string; data: string }) => {
      sendIfAlive('terminal:data', event);
    });
    ts.on('exit', (event: { sessionId: string; exitCode: number; signal?: number }) => {
      sendIfAlive('terminal:exit', event);
      s.tryGetService(OWNED_IDS_TRACKER)?.release('terminal', event.sessionId);
    });
    s.onDispose(() => ts.destroyAll(), 'TerminalService');
    return ts;
  });

  // DebugService: 同样 per-scope. 每个 project 自己的 debug sessions / breakpoints.
  // debug:* 事件直接发给本 scope 的 window.
  scope.register(DEBUG_SERVICE, (s) => {
    const ds = new DebugService();
    const sendIfAlive = (channel: string, payload: unknown): void => {
      sendWindowIpcIfAlive(s.window, channel, payload);
    };
    ds.on('breakpoint-hit', (data: { sessionId: string; breakpoint: any; stackTrace: any[] }) => {
      sendIfAlive('debug:breakpoint-hit', data);
    });
    ds.on('state-changed', (data: { sessionId: string; state: 'stopped' | 'running' | 'paused' }) => {
      sendIfAlive('debug:state-changed', data);
    });
    ds.on('output', (data: { sessionId: string; output: string; category: 'stdout' | 'stderr' | 'console' }) => {
      sendIfAlive('debug:output', data);
    });
    return ds;
  });

  // DebuggerManager (新, IDEA-style): per-scope, 管 jvm-debugger.jar 子进程.
  // 跟 DebugService 是不同的东西 —— DebugService 只管断点持久化,
  // DebuggerManager 管真实的 debug session (拉子进程, DAP 通信, 状态机).
  // 后面 M1 起会逐步把断点持久化也合到这边来.
  scope.register(DEBUGGER_MANAGER, (s) => {
    const dm = new DebuggerManager();
    // 工厂带 scope 是为了能读 DebugService 里的已有断点, 在 configurationDone
    // 之前一次性推给 jvm-debugger (避免 race).
    const jvmFactory = makeJvmBackendFactory(s);
    dm.registerBackend('jvm-launch', jvmFactory);
    dm.registerBackend('jvm-attach', jvmFactory);
    const sendIfAlive = (channel: string, payload: unknown): void => {
      sendWindowIpcIfAlive(s.window, channel, payload);
    };
    dm.on((event) => {
      // Renderer 拿单一 channel 'debug:session-event' 收所有 manager 事件,
      // 内部按 type 分发. session 对象不直接传 (有方法), 序列化关键字段.
      if (event.type === 'session-added') {
        sendIfAlive('debug:session-event', {
          type: 'session-added',
          sessionId: event.session.id,
          config: event.session.config,
          capabilities: event.session.capabilities,
          status: event.session.status(),
        });
      } else if (event.type === 'session-removed') {
        sendIfAlive('debug:session-event', { type: 'session-removed', sessionId: event.sessionId });
      } else if (event.type === 'session-status-changed') {
        sendIfAlive('debug:session-event', {
          type: 'session-status-changed',
          sessionId: event.sessionId,
          status: event.status,
        });
      } else if (event.type === 'session-event') {
        sendIfAlive('debug:session-event', {
          type: 'session-event',
          sessionId: event.sessionId,
          event: event.event,
        });
      }
    });
    s.onDispose(async () => {
      // 关 project 时把所有 session 一并收掉, 别留孤儿子进程
      await Promise.all(dm.getActive().map((sess) => sess.disconnect(true).catch(() => {})));
    }, 'DebuggerManager');
    return dm;
  });

  // AgentBridge: 每个 scope 自己的 NeoxClient + SSE + session 历史. server 进程
  // 通过 ensureServer(workdir) 按 workdir 缓存, 同 workdir 多个 bridge 共享同一
  // server (典型场景: 同窗口切换 workspace 不会起新 server). dispose 时 stopServer
  // 只关本 scope 持有的连接, server 进程的实际生命周期由 ensureServer 内部管.
  scope.register(AGENT_BRIDGE, (s) => {
    const ab = new AgentBridge();
    ab.setWorkspace(s.workspacePath);
    void import('./mobile-bridge/agentStreamForwarder.js')
      .then((m) => m.attachAgentBridgeForwarder(ab))
      .catch(() => { /* 手机桥没打包进来 (CLI 等) 就不转 */ });

    const BATCHABLE_TYPES = new Set(['token', 'text', 'reasoning', 'reasoning_delta']);
    const STREAM_BATCH_MS = 16;
    const STREAM_BATCH_MAX = 64;
    let streamBuf: any[] = [];
    let streamFlushTimer: NodeJS.Timeout | null = null;
    const flushStreamBuf = (): void => {
      if (streamFlushTimer) { clearTimeout(streamFlushTimer); streamFlushTimer = null; }
      if (streamBuf.length === 0) return;
      const events = streamBuf;
      streamBuf = [];
      if (events.length === 1) {
        sendWindowIpcIfAlive(s.window, 'chat:stream', events[0]);
      } else {
        sendWindowIpcIfAlive(s.window, 'chat:stream', { __streamBatch: events });
      }
    };
    const sendStreamCoalesced = (event: any): void => {
      if (BATCHABLE_TYPES.has(event?.type)) {
        streamBuf.push(event);
        if (streamBuf.length >= STREAM_BATCH_MAX) { flushStreamBuf(); return; }
        if (!streamFlushTimer) streamFlushTimer = setTimeout(flushStreamBuf, STREAM_BATCH_MS);
        return;
      }
      /* 非可批事件: 先清空在途缓冲保序, 再直发 */
      flushStreamBuf();
      sendWindowIpcIfAlive(s.window, 'chat:stream', event);
    };
    s.onDispose(() => {
      if (streamFlushTimer) { clearTimeout(streamFlushTimer); streamFlushTimer = null; }
      streamBuf = [];
    }, 'StreamBatcher');
    // chat:stream 事件路由 —— 直接发给本 scope 的 window + 副作用 (token 记账 /
    // 多窗口场景下会 N× 触发. 现在每个 scope 的 bridge 只有一份订阅, 触发次数正确.
    /* 记账是 void 出去的 Promise —— 外面的 try/catch 接不住, 不接就成了全局 unhandledRejection (写假 crash 档案) */
    const logContextUsedError = (err: unknown) => {
      console.error('[AgentBridge stream side-effect] updateSessionContextUsed failed:', (err as Error)?.message ?? err);
    };
    ab.on('stream', (event: any) => {
      // 副作用: 记账 + memory snapshot cache
      try {
        if (event.type === 'metrics' && event.contextUsed > 0) {
          const normalizedBreakdown = normalizeContextBreakdown(event.breakdown, event.contextUsed);
          if ((event as any).compacted === true) {
            const previousSnapshot = ab.getLastMemorySnapshot(event.sessionId);
            const cached = sessionsCache.get(event.sessionId) || getDatabase().getSession(event.sessionId);
            ab.setLastMemorySnapshot(event.sessionId, {
              tokensUsed: event.contextUsed,
              contextWindow: event.contextWindow || previousSnapshot?.contextWindow || cached?.contextWindow || 0,
              breakdown: normalizedBreakdown,
            });
          }
          void updateSessionContextUsed(event.sessionId, event.contextUsed, {
            persist: true,
            force: (event as any).compacted === true,
            breakdown: normalizedBreakdown,
            latestRequestUsage: {
              model: (event as any).model,
              inputTokens: event.inputTokens || event.contextUsed,
              billableInputTokens: event.billableInputTokens,
              outputTokens: event.outputTokens || 0,
              cacheReadTokens: event.cacheReadTokens,
              cacheWriteTokens: event.cacheWriteTokens,
              totalTokens: event.tokens,
              breakdown: normalizedBreakdown,
            },
            /* 累积用量随手落盘 — NeoxCloud 会话不写 token_usage 表, 重启后全靠它恢复 */
            sessionUsage: (event as any).sessionUsage || undefined,
          }).catch(logContextUsedError);
        } else if (event.type === 'memory' && event.contextWindow) {
          ab.setLastMemorySnapshot(event.sessionId, {
            tokensUsed: event.tokensUsed || 0,
            contextWindow: event.contextWindow,
            breakdown: event.breakdown,
          });
          const cached = sessionsCache.get(event.sessionId) || getDatabase().getSession(event.sessionId);
          const stableContextUsed = cached?.contextUsed || 0;
          void updateSessionContextUsed(event.sessionId, stableContextUsed, {
            persist: true,
            contextWindow: event.contextWindow,
          }).catch(logContextUsedError);
        } else if (event.type === 'run_result' && event.contextUsed && event.contextUsed > 0) {
          void updateSessionContextUsed(event.sessionId, event.contextUsed, { persist: true }).catch(logContextUsedError);
        }
      } catch (err) {
        console.error('[AgentBridge stream side-effect] error:', err);
      }

      // 路由到本 scope 的 window —— 不会跨窗口串
      /* M1 诊断 — 抓 user_message / run_state_changed 是否真到 renderer IPC.
       * 用独立 logger 写到 mobile-bridge.log, 跟 forwarder log 同位便于对账。 */
      if (event.type === 'user_message' || event.type === 'run_state_changed') {
        try {
          const { bridgeLog } = require('./mobile-bridge/log.js');
          bridgeLog('main:chat:stream→renderer', `type=${event.type} sessionId=${event.sessionId?.slice(0, 16)} winDestroyed=${s.window.isDestroyed()}`);
        } catch { /* require 失败也无所谓 */ }
      }
      sendStreamCoalesced(event);
    });
    s.onDispose(() => ab.dispose(), 'AgentBridge');
    return ab;
  });

  // SemanticBridge: 每个 scope 自己的 tree-sitter / fuzzy index. workspace 切换
  // (新 scope 创建) 时旧 index 会随旧 scope dispose 一起回收, 不再有跨 project
  // 的 semantic 状态串扰.
  scope.register(SEMANTIC_BRIDGE, (s) => {
    const sb = new SemanticBridge();
    void sb.setWorkspace(s.workspacePath, { startBackground: false });
    s.onDispose(() => sb.disposeCurrent(), 'SemanticBridge');
    return sb;
  });

  scope.register(EMBEDDING_BRIDGE, (s) => {
    const eb = new EmbeddingBridge({
      getFileSymbols: async (filePath) => {
        const sb = s.getService(SEMANTIC_BRIDGE);
        return sb.getFileOutline(filePath).map((symbol) => ({
          name: symbol.name,
          kind: symbol.kind,
          startLine: symbol.range.start.line,
          endLine: symbol.range.end.line,
          signature: symbol.signature,
          containerName: symbol.containerName,
        }));
      },
    });
    void eb.setWorkspace(s.workspacePath, { startBackground: false });
    s.onDispose(() => eb.disposeCurrent(), 'EmbeddingBridge');
    return eb;
  });

  // TsServerBridge: 每个 scope 自己的 tsserver child process. dispose 时 stop()
  // 终止 tsserver. 注意: tsserver 是相当重的进程 (~100MB+), 多 project 会乘.
  scope.register(TS_SERVER_BRIDGE, (s) => {
    const ts = new TsServerBridge();
    s.onDispose(() => ts.stop(), 'TsServerBridge');
    return ts;
  });

  scope.register(PROJECT_STARTUP_COORDINATOR, (s) => new ProjectStartupCoordinator(s));

  // SkillRegistry: 每个 scope 一个独立的 skill 加载器. 第一次 use 时 await refresh()
  // 加载本 workspace 的 skills (含 user-level + workspace-level scope 合并).
  scope.register(SKILL_REGISTRY, () => new SkillRegistry());
}

projectManager = new ProjectManager({
  appScope,
  createWindow: async (workspacePath: string) => {
    return createMainWindow({
      isDev,
      dirname: __dirname,
      initialWorkspacePath: workspacePath,
    });
  },
  bootstrapProjectServices,
});

// 注册到 appScope, 这样 IPC handler 可以通过 appScope.getService(PROJECT_MANAGER) 拿到
appScope.register(PROJECT_MANAGER, () => projectManager);

// ==================== 窗口创建 ====================
// 启动/dock activate 时开一个空 welcome 窗口 (没有 workspacePath).
// 后续 workspace:set 会在本窗口挂 scope; 也可以通过 "在新窗口打开项目" 开多个.
const createWindow = async () => {
  if (process.platform === 'win32') setupWindowsTray(__dirname, createWindow);
  /* Mac: 菜单栏图标, 跟 Windows 托盘同一份菜单 (services/macMenuBarTray.ts) */
  if (process.platform === 'darwin') setupMacMenuBarTray(createWindow);
  /* Win: 更新后刷新桌面/开始菜单快捷方式的图标与 AppUserModelId,
   * 否则 Explorer 会一直显示旧标或 Electron 默认标. */
  refreshWindowsShortcuts();

  const requested = (process.env.NEOX_OPEN_WORKSPACE ?? '').trim();
  if (requested) {
    let ok = false;
    try { ok = statSync(requested).isDirectory(); } catch { ok = false; }
    if (ok) {
      await openWindowWithWorkspace(requested);
      return;
    }
    console.warn(`[Main] NEOX_OPEN_WORKSPACE 指定的目录不存在或不可访问, 回落正常启动: ${requested}`);
  }

  await createMainWindow({ isDev, dirname: __dirname });
};

const openWindowWithWorkspace = async (workspacePath: string) => {
  const scope = await projectManager.openProject(workspacePath);
  try {
    if (scope.window.isMinimized()) scope.window.restore();
    scope.window.show();
    scope.window.focus();
  } catch {
    /* ignore */
  }
  return scope.window;
};

let cachedUIState: Awaited<ReturnType<typeof storageService.loadUIState>> | null = null;

// ==================== IPC 处理器 ====================

/* renderer → main 日志转发: renderer 进程不能直接用 neoxLogger (依赖 fs/os),
 * 通过 IPC 把日志转发到主进程, 落盘到 ~/.neox/logs/neox-app-*.log.
 * 用法 (renderer): window.neox.logDebug('TAG', 'message', data).
 * 单向 .send/.on 即可, 不需要 reply. */
ipcMain.on('renderer:log', (_event, level: 'debug' | 'info' | 'warn' | 'error', tag: string, message: string, data?: unknown) => {
  try {
    const fn = level === 'debug' ? neoxLogger.debug
      : level === 'info' ? neoxLogger.info
      : level === 'warn' ? neoxLogger.warn
      : neoxLogger.error;
    fn.call(neoxLogger, tag || 'RENDERER', message || '', data);
  } catch { /* ignore — log fallback shouldn't crash */ }
  if (tag === 'STARTUP' || tag === 'MODE') { /* MODE: 「重启进了 Pilot」的来源, neoxLogger 默认不落盘查不到 */
    try { breadcrumb(`renderer: ${message}`); } catch { /* 诊断设施不许反噬 */ }
  }
});

// 注意：dev 下 app.getVersion() 返回 Electron 版本 (e.g. 40.0)
// 需要直接从 package.json 读取应用版本
// __dirname = apps/cli/dist/ui-electron/electron/, 但**桌面 app 版本以 neox-desktop 为准**
// (apps/cli/package.json 是 CLI 独立版本, 不代表桌面 app), 老代码走 3 层拿到的是 neox-cli 版本.
// 兜底顺序: neox-desktop > 仓库根 monorepo > neox-cli (老兜底) > electron.getVersion()
/* 版本真相收敛到 electron/appVersion.ts —— 三条错开的版本线的来龙去脉写在那里 */
const APP_VERSION = getAppVersion();
// 注册"在新窗口打开项目" IPC
ipcMain.handle('window:open-with-workspace', async (_e, workspacePath: string) => {
  try {
    if (typeof workspacePath !== 'string' || !workspacePath.trim()) {
      return { success: false, error: '无效的项目路径' };
    }
    let isDirectory = false;
    try {
      isDirectory = statSync(workspacePath).isDirectory();
    } catch { /* 不存在/无权限 — 统一走下面的错误返回 */ }
    if (!isDirectory) {
      return { success: false, error: `目录不存在或不可访问: ${workspacePath}` };
    }
    await openWindowWithWorkspace(workspacePath);
    return { success: true };
  } catch (err) {
    console.error('[Main] openWindowWithWorkspace failed:', err);
    return { success: false, error: (err as Error).message };
  }
});

// ==================== 窗口控制 (自绘 min/max/close · Win) ====================
ipcMain.handle('window:minimize', (e) => {
  BrowserWindow.fromWebContents(e.sender)?.minimize();
});
ipcMain.handle('window:maximize-toggle', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return false;
  win.isMaximized() ? win.unmaximize() : win.maximize();
  return win.isMaximized();
});
ipcMain.handle('window:close', (e) => {
  BrowserWindow.fromWebContents(e.sender)?.close();
});
ipcMain.handle('window:is-maximized', (e) => {
  return BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false;
});

ipcMain.handle('window:focus-workspace', async (_e, workspacePath: string) => {
  try {
    if (typeof workspacePath !== 'string' || !workspacePath.trim()) return false;
    const scope = projectManager.getByPath(workspacePath);
    if (!scope || scope.disposed) return false;
    if (scope.window.isMinimized()) scope.window.restore();
    scope.window.show();
    scope.window.focus();
    return true;
  } catch (err) {
    console.error('[Main] focusWorkspace failed:', err);
    return false;
  }
});

registerAllIpcHandlers({
  isDev,
  appVersion: APP_VERSION,
  projectManager,
  consumeCachedUIState: async () => {
    const uiState = cachedUIState ?? await storageService.loadUIState();
    cachedUIState = null;
    return uiState;
  },
  getSessionOrThrow,
  getSqliteSession,
  refreshSession,
  persistSession,
  sessionStore,
  sessionsCache,
});

/* 桌宠 IPC — 独立窗口, 跟主窗口生命周期解耦. dirname 给 spawnPetWindow 用于
 * 定位 preload-pet.cjs 和 prod 模式下的 pet.html 路径. */
registerPetIpcHandlers({ isDev, dirname: __dirname });
/* 自动化 (定时任务) 列表 / 删除 —— 设置 → 技能 → 自动化 */
registerAutomationIpcHandlers();

/* computer use 被操控叠加层的 IPC — 同样是独立窗口 (全屏透明 + 置顶 + 鼠标穿透),
 * dirname 给它定位 preload-overlay.cjs / overlay.html. 窗口的销毁挂在
 * computerOverlayWindowFactory 自己的 before-quit (跟 pet 同款). */
registerComputerOverlayIpcHandlers({
  isDev,
  dirname: __dirname,
  onUserStop: () => {
    for (const scope of projectManager.listScopes()) {
      try { scope.tryGetService(AGENT_BRIDGE)?.interruptRunningSessions(); } catch { /* ignore */ }
    }
  },
});

registerPilotIpcHandlers({ isDev, dirname: __dirname });
/* 主进程往会话里投消息 (提醒开口) 要经会话所在的 runtime —— 见 runtimeEnqueue.ts */
configureRuntimeEnqueue(projectManager);
/* 不在电脑前用 Telegram 找 Pilot (pilotTelegram.ts); net.fetch / powerMonitor 要等 app ready */
void app.whenReady().then(() => bootPilotTelegram());
app.on('before-quit', () => {
  try { shutdownPilotCalls(); } catch { /* ignore */ }
  try { stopPilotTelegram(); } catch { /* ignore */ }
});

/* 启动顺序护栏:
 *   先同步注册全部 ipcMain.handle，再挂 app.whenReady() 的建窗生命周期。
 *   否则 main 里若出现顶层 await / 慢 IO，Electron ready 后 renderer 可能先启动，
 *   提前 invoke auth:* 命中 "No handler registered" 竞态。 */
registerWindowOpener(createWindow); // 退出取消 / 二次启动时无窗可回就用它新开 (见 quitGuards)
setupAppLifecycle({
  projectManager,
  createWindow,
  onCachedUIStateLoaded: (uiState) => {
    cachedUIState = uiState;
  },
  beforeStorageReady: () => authBucketReadyPromise,
});
