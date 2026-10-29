/**
 * Neox Desktop — Auto Update Service
 *
 * Manual update checker for the Settings → About page.
 *
 * Primary source is the same R2 manifest used by the website:
 *   https://dl.neox-dev.com/desktop/latest.json
 *
 * electron-updater still handles background self-update with latest*.yml.
 * This IPC path exists for the user-clicked check button and manual download UI.
 *
 * Features:
 *   - R2 latest.json first (same manifest as website)
 *   - GitHub/npm fallback for old or emergency release flows
 *   - Download progress tracking via IPC events
 */

import { ipcMain, BrowserWindow, shell, app } from 'electron';
import { createWriteStream, existsSync, mkdirSync, unlinkSync, type WriteStream } from 'fs';
import { join } from 'path';
import { getAppVersion } from '../appVersion.js';
const currentAppVersion = (): string => getAppVersion();
import { configService } from '@neoxlabs/platform/platform/configService.js';
import { openSafeWebExternalUrl } from './safeExternalOpen.js';
import { requestWindowsUpdateInstall, requestInstallerOnQuit } from '../windowsUpdateInstall.js';
import { DISTRIBUTION } from '@neoxlabs/kernel/platform/distribution.js';

function isZhUi(): boolean {
  try {
    return configService.getLanguagePreference() !== 'en';
  } catch {
    try { return app.getLocale().toLowerCase().startsWith('zh'); } catch { return true; }
  }
}

// ==================== Config ====================

const DESKTOP_DOWNLOAD_BASE = 'https://dl.neox-dev.com/desktop';
const PRODUCT_DOWNLOAD_PAGE = 'https://neox.dev';
const ELECTRON_UPDATER_INSTALL_TOKEN = '__neox_electron_updater_install__';
/** mac 自研 updater 的安装令牌 — 跟 electron-updater 那条线区分开 */
const MAC_SELF_UPDATE_INSTALL_TOKEN = '__neox_mac_self_update_install__';
/* 下载源白名单只留自家 R2 — GitHub 是私有仓 (拉不到), ghproxy 是第三方中转 (不该信任二进制) */
const ALLOWED_DOWNLOAD_HOSTS = new Set([new URL(DESKTOP_DOWNLOAD_BASE).hostname]);

// 唯一权威更新源 — 官网下载页用的同一份 manifest
const UPDATE_SOURCES = {
  r2LatestJson: `${DESKTOP_DOWNLOAD_BASE}/latest.json`,
};

// ==================== Types ====================

interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  releaseNotes?: string;
  downloadUrl?: string;
  downloadUrlMirror?: string;
  publishedAt?: string;
  source?: string;
  error?: string;
}

interface DownloadProgress {
  percent: number;
  transferred: number;
  total: number;
  speed: number; // bytes/sec
}

interface DownloadResult {
  success: boolean;
  filePath?: string;
  error?: string;
  /** 用户按了暂停 —— 不是失败: 半成品还在盘上, 「继续」能接着下 */
  paused?: boolean;
  source?: 'electron-updater' | 'manual-download' | 'mac-self-update';
}

interface R2LatestManifest {
  version?: string;
  macVersion?: string;
  winVersion?: string;
  updatedAt?: string;
  releaseNotes?: string;
  notes?: string;
  changelog?: string;
  macArm?: string;
  macIntel?: string;
  winX64?: string;
  winArm64?: string;
  winPortable?: string;
}

// ==================== Version Compare ====================

function parseVersion(v: string): number[] {
  const m = v.replace(/^v/i, '').replace(/^desktop-v/i, '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [+m[1], +m[2], +m[3]] : [0, 0, 0];
}

function isNewer(latest: string, current: string): boolean {
  const l = parseVersion(latest);
  const c = parseVersion(current);
  return l[0] > c[0] || (l[0] === c[0] && l[1] > c[1]) || (l[0] === c[0] && l[1] === c[1] && l[2] > c[2]);
}

// ==================== Check Functions ====================

async function fetchJson(url: string, timeoutMs: number = 8000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'user-agent': `Neox/${currentAppVersion()}`,
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function cacheBusted(url: string): string {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}t=${Date.now()}`;
}

function fileNameFromUrl(url: string): string {
  try {
    return new URL(url).pathname.split('/').pop() || 'Neox-update';
  } catch {
    return url.split('/').pop() || 'Neox-update';
  }
}

/** 从安装包 URL 反推版本 (Neox-3.1.4-x64.exe → 3.1.4) */
function versionFromDownloadUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const name = fileNameFromUrl(url);
  const m = name.match(/^Neox-(.+)-(?:x64|arm64|portable)\.(?:dmg|zip|exe)$/);
  return m?.[1];
}

export function pickPlatformLatestVersion(manifest: R2LatestManifest): string {
  const downloadUrl = pickR2DownloadUrl(manifest);
  if (process.platform === 'darwin') {
    return (
      (typeof manifest.macVersion === 'string' && manifest.macVersion) ||
      versionFromDownloadUrl(downloadUrl) ||
      (typeof manifest.version === 'string' && manifest.version) ||
      ''
    );
  }
  if (process.platform === 'win32') {
    return (
      (typeof manifest.winVersion === 'string' && manifest.winVersion) ||
      versionFromDownloadUrl(downloadUrl) ||
      (typeof manifest.version === 'string' && manifest.version) ||
      ''
    );
  }
  return typeof manifest.version === 'string' ? manifest.version : '';
}

function isAllowedDownloadUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && ALLOWED_DOWNLOAD_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

function pickR2DownloadUrl(manifest: R2LatestManifest): string | undefined {
  let candidate: string | undefined;

  if (process.platform === 'darwin') {
    candidate = process.arch === 'arm64' ? manifest.macArm : manifest.macIntel;
  } else if (process.platform === 'win32') {
    if (process.arch === 'arm64') {
      candidate = manifest.winArm64 || manifest.winX64;
    } else {
      candidate = manifest.winX64 || manifest.winPortable;
    }
  }

  return candidate && isAllowedDownloadUrl(candidate) ? candidate : undefined;
}

const releaseNotesCache = new Map<string, { at: number; notes: string }>();
async function fetchReleaseNotesFor(version: string): Promise<string> {
  const hit = releaseNotesCache.get(version);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.notes;
  const plat = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : '';
  const base = (process.env.NEOX_API_BASE || 'https://neox-dev.com').replace(/\/$/, '');
  let notes = '';
  try {
    const data = await fetchJson(`${base}/api/v1/changelog`, 4000) as { entries?: Array<{ version?: string; platforms?: string; bodyMd?: string }> };
    const entry = (data?.entries ?? []).find((e) =>
      e?.version === version && (e.platforms === 'all' || String(e.platforms ?? '').split(',').includes(plat)));
    notes = entry?.bodyMd ?? '';
  } catch { /* 官网不通 = 没说明, 不是没更新 */ }
  releaseNotesCache.set(version, { at: Date.now(), notes });
  return notes;
}

/**
 * Check R2 latest.json for latest desktop version.
 */
async function checkR2LatestJson(): Promise<UpdateInfo> {
  const data = await fetchJson(cacheBusted(UPDATE_SOURCES.r2LatestJson)) as R2LatestManifest;
  const latestVersion = pickPlatformLatestVersion(data);
  if (!latestVersion) {
    throw new Error('R2 latest.json missing platform version');
  }

  const hasUpdate = isNewer(latestVersion, currentAppVersion());
  const manifestNotes = data.releaseNotes || data.notes || data.changelog || '';
  return {
    currentVersion: currentAppVersion(),
    latestVersion,
    hasUpdate,
    releaseNotes: manifestNotes || (hasUpdate ? await fetchReleaseNotesFor(latestVersion) : ''),
    downloadUrl: pickR2DownloadUrl(data),
    publishedAt: data.updatedAt,
    source: 'r2-latest-json',
  };
}

async function checkForUpdate(): Promise<UpdateInfo> {
  /* 开源版没有官方下载源: 关于页「检查更新」只说当前版本, 不去拉商业版的 latest.json */
  if (!DISTRIBUTION.autoUpdate) {
    return { currentVersion: currentAppVersion(), latestVersion: '', hasUpdate: false };
  }
  try {
    return await checkR2LatestJson();
  } catch (err: any) {
    const detail = err?.message ? String(err.message) : '';
    return {
      currentVersion: currentAppVersion(),
      latestVersion: '',
      hasUpdate: false,
      error: isZhUi()
        ? `无法连接更新服务器${detail ? ` (${detail})` : ''}，请检查网络后重试`
        : `Could not reach the update server${detail ? ` (${detail})` : ''}. Check your network and try again.`,
    };
  }
}

// ==================== Download ====================

let electronUpdaterReadyToInstall = false;
let electronUpdaterDownloadedVersion: string | undefined;

/** Windows 后台自动更新 (autoUpdate.ts) 下载完成后打标 —— 与手动流程共用同一份就绪态。
 *  不打这一手的话, 后台下好的包在 update:install 的 `electronUpdaterReadyToInstall` 闸门前
 *  是隐形的: 用户去「关于」点安装会被告知"没有已下载的在线更新包", 而包其实就在那儿
 *  (mac 侧同一笔账已在 getStagedMacUpdate 记过, 这是 win 侧的补齐)。 */
export function markElectronUpdaterDownloaded(version?: string): void {
  electronUpdaterReadyToInstall = true;
  if (version) electronUpdaterDownloadedVersion = version;
}

/** 「关于」页开页即问的就绪态 — 已预下载完成、点一下就能重启安装的更新。 */
async function getStagedUpdateStatus(): Promise<{ ready: boolean; version?: string }> {
  if (process.platform === 'darwin') {
    try {
      const mac = await import('../macUpdater.js');
      const staged = macStagedUpdate ?? await mac.resolveStagedMacUpdate();
      if (staged) return { ready: true, version: staged.version };
    } catch { /* macUpdater 加载失败 = 没有就绪包 */ }
    return { ready: false };
  }
  if (electronUpdaterReadyToInstall) {
    return { ready: true, version: electronUpdaterDownloadedVersion };
  }
  return { ready: false };
}

/* mac 自研 updater 暂存态 — 下载校验解压完成后挂在这里, 等 update:install 触发替换重启 */
let macStagedUpdate: import('../macUpdater.js').StagedMacUpdate | null = null;

/**
 * macOS 专用下载路径 — 绕开 Squirrel.Mac。
 *
 * ad-hoc 签名的 app 用 electron-updater 的 mac 路径 100% 装不上 (见 macUpdater.ts 顶部注释),
 * 所以 darwin 走自研: 下 zip → sha512 校验 → ditto 解压 → 替换重启。
 */
async function downloadWithMacSelfUpdater(mainWindow: BrowserWindow | null): Promise<DownloadResult> {
  const zh = isZhUi();
  try {
    const mac = await import('../macUpdater.js');

    /* 先问能不能装 — 不能装就【别下】那 600MB, 直接引导手动装 (旧 Squirrel 路径就是下完才失败) */
    const writable = mac.canSelfReplace();
    if (!writable.ok) {
      return {
        success: false,
        source: 'mac-self-update',
        error: writable.reason === 'not-writable'
          ? (zh
            ? '没有替换 Neox.app 的权限 — 请把 Neox 拖到「应用程序」文件夹, 或从官网手动下载安装'
            : 'No permission to replace Neox.app — move Neox into your Applications folder, or download the installer manually')
          : (zh
            ? '当前不是标准 .app 安装形态, 请从官网手动下载安装'
            : 'Not running from a standard .app bundle; please download the installer manually'),
      };
    }

    const manifest = await mac.fetchMacUpdateManifest();
    if (!isNewer(manifest.version, currentAppVersion())) {
      return { success: false, source: 'mac-self-update', error: zh ? '已是最新版本' : 'Already up to date' };
    }

    const staged = await mac.downloadAndStageMacUpdate(manifest, (p) => sendProgress(mainWindow, p));
    macStagedUpdate = staged;
    return { success: true, filePath: MAC_SELF_UPDATE_INSTALL_TOKEN, source: 'mac-self-update' };
  } catch (err: any) {
    /* 暂停不是错 —— 别把它塞进 error 让界面糊一句红字 */
    if ((await import('../macUpdater.js')).isMacUpdatePaused(err)) {
      return { success: false, paused: true, source: 'mac-self-update' };
    }
    return { success: false, source: 'mac-self-update', error: humanizeMacUpdateError(err, zh) };
  }
}

function humanizeMacUpdateError(err: any, zh: boolean): string {
  const raw = String(err?.stderr || err?.message || err || '');
  console.error('[MacUpdater] 更新失败 (原始输出):', raw.slice(0, 1000));
  const looksLikeToolOutput = /Command failed|\n|ditto:|unzip:|PlistBuddy|ENOENT/i.test(raw);
  if (!looksLikeToolOutput && raw && raw.length <= 120) return raw;
  return zh
    ? '更新包解压失败, 已保留详细日志。请重试一次, 或从官网手动下载安装。'
    : 'Could not unpack the update. Please try again, or download the installer from the website.';
}

async function getElectronAutoUpdater(): Promise<any | null> {
  if (!app.isPackaged) return null;

  const mod = await import('electron-updater') as unknown as Record<string, unknown>;
  const autoUpdater = (mod.autoUpdater
    ?? (mod.default as Record<string, unknown> | undefined)?.autoUpdater
    ?? mod.default) as any;

  if (!autoUpdater || typeof autoUpdater.checkForUpdates !== 'function' || typeof autoUpdater.quitAndInstall !== 'function') {
    return null;
  }

  if (typeof autoUpdater.getFeedURL === 'function' && !autoUpdater.getFeedURL() && typeof autoUpdater.setFeedURL === 'function') {
    autoUpdater.setFeedURL({ provider: 'generic', url: DESKTOP_DOWNLOAD_BASE, channel: 'latest' });
  }

  return autoUpdater;
}

function sendProgress(mainWindow: BrowserWindow | null, progress: any): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  mainWindow.webContents.send('update:progress', {
    percent: Math.round(Number(progress?.percent ?? 0)),
    transferred: Number(progress?.transferred ?? 0),
    total: Number(progress?.total ?? 0),
    speed: Math.round(Number(progress?.bytesPerSecond ?? progress?.speed ?? 0)),
  } satisfies DownloadProgress);
}

function formatElectronUpdaterError(err: any): string {
  const message = err?.message ?? String(err);
  if (process.platform === 'darwin' && /ZIP file not provided/i.test(message)) {
    return isZhUi()
      ? '当前 macOS 自更新 feed 缺少 zip 包，需要重新发布包含 zip target 的版本'
      : 'The macOS auto-update feed is missing a zip package; a release including the zip target is required';
  }
  return message;
}

async function downloadWithElectronUpdater(mainWindow: BrowserWindow | null): Promise<DownloadResult> {
  try {
    const autoUpdater = await getElectronAutoUpdater();
    if (!autoUpdater) {
      return { success: false, error: isZhUi() ? '自动更新仅支持打包后的桌面应用' : 'Auto-update is only available in the packaged desktop app' };
    }

    const previousAutoDownload = Boolean(autoUpdater.autoDownload);
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.__neoxManualUpdateInProgress = true;

    const progressHandler = (progress: any) => sendProgress(mainWindow, progress);
    autoUpdater.on('download-progress', progressHandler);

    try {
      const checkResult = await autoUpdater.checkForUpdates();
      if (!checkResult) {
        return { success: false, error: isZhUi() ? '自动更新服务不可用' : 'Auto-update service is unavailable' };
      }
      if (!checkResult.isUpdateAvailable) {
        return { success: false, error: isZhUi() ? '已是最新版本' : 'Already up to date' };
      }

      if (checkResult.downloadPromise) {
        await checkResult.downloadPromise;
      } else {
        await autoUpdater.downloadUpdate(checkResult.cancellationToken);
      }

      sendProgress(mainWindow, { percent: 100, transferred: 0, total: 0, bytesPerSecond: 0 });
      electronUpdaterReadyToInstall = true;
      electronUpdaterDownloadedVersion = checkResult.updateInfo?.version;
      return {
        success: true,
        filePath: ELECTRON_UPDATER_INSTALL_TOKEN,
        source: 'electron-updater',
      };
    } finally {
      autoUpdater.off?.('download-progress', progressHandler);
      autoUpdater.removeListener?.('download-progress', progressHandler);
      autoUpdater.autoDownload = previousAutoDownload;
      autoUpdater.__neoxManualUpdateInProgress = false;
    }
  } catch (err: any) {
    return { success: false, error: formatElectronUpdaterError(err), source: 'electron-updater' };
  }
}

async function downloadUpdate(
  url: string,
  mainWindow: BrowserWindow | null,
): Promise<DownloadResult> {
  let writer: WriteStream | null = null;
  let writerError: Error | null = null;
  try {
    if (!isAllowedDownloadUrl(url)) {
      throw new Error('Download URL is not an allowed update source');
    }

    const tmpDir = join(app.getPath('temp'), 'neox-update');
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });

    const fileName = fileNameFromUrl(url);
    const filePath = join(tmpDir, fileName);

    // Clean up old download
    if (existsSync(filePath)) unlinkSync(filePath);

    const response = await fetch(url, {
      headers: { 'user-agent': `Neox/${currentAppVersion()}` },
    });

    if (!response.ok || !response.body) {
      throw new Error(`Download failed: HTTP ${response.status}`);
    }

    const total = parseInt(response.headers.get('content-length') || '0', 10);
    writer = createWriteStream(filePath);
    const w = writer;
    /* 流自己的 'error' 得有下游 —— 否则写失败时它是 uncaughtException */
    w.on('error', (e: Error) => { writerError = e; });
    const reader = response.body.getReader();

    let transferred = 0;
    const startTime = Date.now();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (writerError) throw writerError;

      await new Promise<void>((resolve, reject) => {
        w.write(Buffer.from(value), (err?: Error | null) => {
          if (err) reject(err);
          else if (writerError) reject(writerError);
          else resolve();
        });
      });
      transferred += value.length;

      const elapsed = (Date.now() - startTime) / 1000;
      const speed = transferred / elapsed;
      const percent = total > 0 ? Math.round((transferred / total) * 100) : 0;

      // Send progress to renderer
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update:progress', {
          percent,
          transferred,
          total,
          speed: Math.round(speed),
        } satisfies DownloadProgress);
      }
    }

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const onFinish = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        w.off('error', onError);
        w.off('finish', onFinish);
      };
      /* 收尾前先看常驻监听者存下的错 —— 它可能在我们挂监听之前就发完了,
       * 不补这一次 'finish' 永远不会来, 这里会静默挂死 */
      if (writerError) { reject(writerError); return; }
      w.once('error', onError);
      w.once('finish', onFinish);
      w.end();
    });

    sendProgress(mainWindow, { percent: 100, transferred, total, bytesPerSecond: 0 });

    return { success: true, filePath, source: 'manual-download' };
  } catch (err: any) {
    try { writer?.destroy(); } catch { /* 已经收掉就算了 */ }
    return { success: false, error: err.message, source: 'manual-download' };
  }
}

// ==================== IPC Registration ====================

export function registerUpdateIpcHandlers(
  resolveProgressWindow?: () => BrowserWindow | null,
): void {
  /* 渲染层的"更新就绪"自研弹窗回执 —— 见 autoUpdate.ts:promptRestart。
   * ack 让主进程知道弹窗已被接管, 不要再弹原生框; accept/dismiss 是用户的选择。 */
  ipcMain.on('update:ready-accept', async (_e, id: number) => {
    const { acceptRestartPrompt } = await import('../autoUpdate.js');
    acceptRestartPrompt(Number(id));
  });
  ipcMain.on('update:ready-dismiss', async (_e, id: number) => {
    const { dismissRestartPrompt } = await import('../autoUpdate.js');
    dismissRestartPrompt(Number(id));
  });

  // Check for updates (multi-source fallback)
  ipcMain.handle('update:check', async () => {
    return await checkForUpdate();
  });

  /* 就绪态查询 — 后台预下载已完成时, 关于页开页直接呈现「重启安装」, 不再让用户点检测 */
  ipcMain.handle('update:staged-status', async () => {
    const st = await getStagedUpdateStatus();
    /* 后台预下载就绪那条路不经过 checkForUpdates, 更新说明在这里补 —— 「重启安装」旁边也该有"改了什么" */
    if (st?.ready && st.version) {
      const releaseNotes = await fetchReleaseNotesFor(st.version);
      return releaseNotes ? { ...st, releaseNotes } : st;
    }
    return st;
  });

  // Download update
  ipcMain.handle('update:download', async (event, url: string) => {
    // 下载进度发回给发起调用的那个窗口 (用户点了检查更新按钮的窗口)
    const senderWindow = BrowserWindow.fromWebContents(event?.sender);
    const progressWindow = senderWindow ?? resolveProgressWindow?.() ?? null;

    /* macOS: 走自研 updater (Squirrel.Mac 在 ad-hoc 签名下必失败, 见 macUpdater.ts) */
    if (process.platform === 'darwin' && app.isPackaged) {
      return await downloadWithMacSelfUpdater(progressWindow);
    }

    const updaterResult = await downloadWithElectronUpdater(progressWindow);
    if (updaterResult.success || app.isPackaged) return updaterResult;

    // Dev/unpackaged fallback: download the installer manually for local verification.
    let result = url ? await downloadUpdate(url, progressWindow) : updaterResult;
    if (!result.success && url && !url.includes('ghproxy')) {
      const mirrorUrl = url.replace(
        'https://github.com/',
        'https://mirror.ghproxy.com/https://github.com/'
      );
      result = await downloadUpdate(mirrorUrl, progressWindow);
    }
    return result;
  });

  ipcMain.handle('update:download-control', async (event, action: 'pause' | 'resume' | 'cancel' | 'state') => {
    if (process.platform !== 'darwin' || !app.isPackaged) {
      return { supported: false };
    }
    const mac = await import('../macUpdater.js');
    if (action === 'pause') return { supported: true, ok: mac.pauseMacUpdateDownload() };
    if (action === 'cancel') { mac.cancelMacUpdateDownload(); return { supported: true, ok: true }; }
    if (action === 'state') return { supported: true, state: mac.getMacDownloadState() };
    /* resume —— 跟 update:download 一样把进度打回发起的那个窗口 */
    const senderWindow = BrowserWindow.fromWebContents(event?.sender);
    const progressWindow = senderWindow ?? resolveProgressWindow?.() ?? null;
    const p = mac.resumeMacUpdateDownload((prog) => sendProgress(progressWindow, prog));
    if (!p) return { supported: true, ok: false, error: isZhUi() ? '没有可继续的下载' : 'Nothing to resume' };
    try {
      const staged = await p;
      macStagedUpdate = staged;
      return { supported: true, ok: true, done: true, filePath: MAC_SELF_UPDATE_INSTALL_TOKEN };
    } catch (err: any) {
      if (mac.isMacUpdatePaused(err)) return { supported: true, ok: true, paused: true };
      return { supported: true, ok: false, error: humanizeMacUpdateError(err, isZhUi()) };
    }
  });

  // Open downloaded file (install)
  ipcMain.handle('update:install', async (_event, filePath?: string) => {
    const zh = isZhUi();
    try {
      /* mac 自研 updater: spawn detached helper 替换 .app 后重启 (带回滚) */
      /* 后台自动更新下好的包也认 —— 它 stage 在 macUpdater 里, 不经过本模块的
       * macStagedUpdate。不兜这一手的话, 后台下完之后用户去「关于」点安装会被
       * 告知"没有已下载的更新包", 而包其实就在那儿。 */
      const macStaged = macStagedUpdate ?? await (await import('../macUpdater.js')).resolveStagedMacUpdate();
      if (filePath === MAC_SELF_UPDATE_INSTALL_TOKEN || (!filePath && macStaged)) {
        if (!macStaged) {
          return {
            success: false,
            message: zh ? '安装失败' : 'Install failed',
            error: zh ? '没有已下载的更新包' : 'No downloaded update package available',
          };
        }
        const staged = macStaged;
        const mac = await import('../macUpdater.js');
        setImmediate(() => mac.installStagedMacUpdate(staged));
        return {
          success: true,
          message: zh ? `正在重启并安装 Neox ${staged.version}...` : `Restarting to install Neox ${staged.version}...`,
        };
      }

      if (filePath === ELECTRON_UPDATER_INSTALL_TOKEN || (!filePath && electronUpdaterReadyToInstall)) {
        const autoUpdater = await getElectronAutoUpdater();
        if (!autoUpdater || !electronUpdaterReadyToInstall) {
          return {
            success: false,
            message: zh ? '安装失败' : 'Install failed',
            error: zh ? '没有已下载的在线更新包' : 'No downloaded update package available',
          };
        }
        setImmediate(() => requestWindowsUpdateInstall(autoUpdater));
        return {
          success: true,
          message: electronUpdaterDownloadedVersion
            ? (zh ? `正在重启并安装 Neox ${electronUpdaterDownloadedVersion}...` : `Restarting to install Neox ${electronUpdaterDownloadedVersion}...`)
            : (zh ? '正在重启并安装更新...' : 'Restarting to install the update...'),
        };
      }

      if (filePath && existsSync(filePath)) {
        const autoUpdater = await getElectronAutoUpdater();
        setImmediate(() => requestInstallerOnQuit(() => {
          void shell.openPath(filePath).then((error) => {
            if (error) console.error('[auto-update] 安装器启动失败:', error);
          }).catch((error) => console.error('[auto-update] 安装器启动失败:', error));
        }, autoUpdater ?? undefined));
        return { success: true, message: zh ? '正在启动安装...' : 'Launching installer...' };
      }

      return {
        success: false,
        message: zh ? '安装失败' : 'Install failed',
        error: zh ? '没有可安装的更新包' : 'No update package to install',
      };
    } catch (e: any) {
      return { success: false, message: zh ? '安装失败' : 'Install failed', error: e.message };
    }
  });

  // Open download page (manual download fallback) — 统一走 safeExternalOpen 协议白名单
  ipcMain.handle('update:open-releases', async () => {
    await openSafeWebExternalUrl(PRODUCT_DOWNLOAD_PAGE);
    return { success: true };
  });
}

export { checkForUpdate };
export type { UpdateInfo, DownloadProgress };
