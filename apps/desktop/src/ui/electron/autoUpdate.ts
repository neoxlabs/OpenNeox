import { app, dialog, BrowserWindow, ipcMain } from 'electron';
import { configService } from '@neoxlabs/platform/platform/configService.js';
import { requestWindowsUpdateInstall } from './windowsUpdateInstall.js';
import { DISTRIBUTION } from '@neoxlabs/kernel/platform/distribution.js';

/* 周期检查句柄 — before-quit 清理链 (main.ts) 调 disposeAutoUpdate 停掉.
 * 另配 unref 双保险: 即使清理链超时没走到, timer 也不阻进程退出. */
let checkTimer: ReturnType<typeof setTimeout> | null = null;
let checkInterval: ReturnType<typeof setInterval> | null = null;

/** 退出清理: 停掉自更新的启动延时 + 周期检查. 幂等, 可重复调. */
export function disposeAutoUpdate(): void {
  if (checkTimer) { clearTimeout(checkTimer); checkTimer = null; }
  if (checkInterval) { clearInterval(checkInterval); checkInterval = null; }
}

function mainProcessIsZh(): boolean {
  try {
    return configService.getLanguagePreference() !== 'en';
  } catch {
    try { return app.getLocale().toLowerCase().startsWith('zh'); } catch { return true; }
  }
}

let lastBroadcastKey = '';

function sanitizeUpdateError(raw: string, zh: boolean): string {
  const msg = String(raw ?? '');

  /* Squirrel.Mac 验签失败 — v3.1.1 起 mac 不再走这条路, 但老版本升上来的过程里仍可能出现 */
  if (/code signature|did not pass validation|ShipIt/i.test(msg)) {
    return zh
      ? '安装包校验未通过, 已跳过本次自动更新'
      : 'The update package failed verification; this auto-update was skipped';
  }
  if (/sha512|完整性/i.test(msg)) {
    return zh ? '更新包完整性校验失败, 已丢弃' : 'Update package integrity check failed; discarded';
  }
  if (/ENOSPC|no space/i.test(msg)) {
    return zh ? '磁盘空间不足' : 'Not enough disk space';
  }
  if (/EACCES|EPERM|permission|not-writable/i.test(msg)) {
    return zh ? '没有替换应用的权限' : 'No permission to replace the app';
  }
  if (/ENOTFOUND|ECONNRESET|ETIMEDOUT|network|fetch failed|HTTP \d/i.test(msg)) {
    return zh ? '网络连接失败' : 'Network connection failed';
  }

  /* 兜底: 掐掉任何本机路径 (file:/// 或 /Users/…), 只留前 80 字 */
  const scrubbed = msg
    .replace(/file:\/\/\/\S*/g, '')
    .replace(/\/Users\/[^\s,)]*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const short = scrubbed.length > 80 ? `${scrubbed.slice(0, 80)}…` : scrubbed;
  return short || (zh ? '未知原因' : 'unknown reason');
}

function broadcastUpdateError(rawMessage: string): void {
  try {
    const zh = mainProcessIsZh();
    const reason = sanitizeUpdateError(rawMessage, zh);

    /* 同一条错误只弹一次 — 周期检查会反复触发同样的失败 */
    if (reason === lastBroadcastKey) return;
    lastBroadcastKey = reason;

    const message = zh
      ? `自动更新失败: ${reason} — 可在 设置 → 关于 手动重试`
      : `Auto-update failed: ${reason} — retry from Settings → About`;

    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed() || w.webContents.isDestroyed()) continue;
      w.webContents.send('update:error', { message });
    }
  } catch { /* 广播失败不影响更新流程 */ }
}

/* 渲染层接管"更新就绪"提示时的握手 —— 见 promptRestart。 */
let restartPromptSeq = 0;
const restartPromptAccepts = new Map<number, () => void>();

/* electron-updater 实例的模块级引用 —— dismissRestartPrompt 要用它撤销"退出时静默装"。
 * setupAutoUpdate 里 import 完就挂上来。 */
let electronUpdaterRef: any = null;

/** 这一轮用户明确点过「稍后」。mac 的退出时静默安装据此让路 (见 installStagedUpdateOnQuit)。 */
let restartPromptDismissed = false;

/** 渲染层点了"立即重启"后回调进来 (updateHandlers 的 update:ready-accept 转发)。 */
export function acceptRestartPrompt(id: number): boolean {
  const fn = restartPromptAccepts.get(id);
  if (!fn) return false;
  restartPromptAccepts.delete(id);
  setImmediate(fn);
  return true;
}

export function dismissRestartPrompt(id: number): void {
  restartPromptAccepts.delete(id);
  restartPromptDismissed = true;
  try {
    if (electronUpdaterRef) {
      electronUpdaterRef.autoInstallOnAppQuit = false;
      console.log('[auto-update] 用户选了"稍后" —— 已关闭"退出时静默安装", 下次启动再问');
    }
  } catch { /* 拿不到实例就维持原行为 */ }
}

async function promptRestart(version: string | undefined, onAccept: () => void): Promise<void> {
  const win = BrowserWindow.getAllWindows()[0];
  const zh = mainProcessIsZh();

  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    const id = ++restartPromptSeq;
    restartPromptAccepts.set(id, onAccept);
    const acked = await new Promise<boolean>((resolve) => {
      const channel = `update:ready-ack-${id}`;
      const timer = setTimeout(() => { ipcMain.removeAllListeners(channel); resolve(false); }, 1500);
      ipcMain.once(channel, () => { clearTimeout(timer); resolve(true); });
      try {
        win.webContents.send('update:ready', { id, version: version ?? '' });
      } catch {
        clearTimeout(timer);
        ipcMain.removeAllListeners(channel);
        resolve(false);
      }
    });
    if (acked) return;               /* 渲染层接管了, 后续由 accept/dismiss 决定 */
    restartPromptAccepts.delete(id); /* 没应答 → 收回回调, 走下面的原生兜底 */
  }

  const opts = {
    type: 'info' as const,
    title: zh ? '更新就绪' : 'Update ready',
    message: zh ? `Neox ${version ?? ''} 已下载完成` : `Neox ${version ?? ''} has been downloaded`,
    detail: zh ? '重启应用即可更新到最新版。' : 'Restart the app to apply the latest version.',
    buttons: zh ? ['立即重启', '稍后'] : ['Restart now', 'Later'],
    defaultId: 0,
    cancelId: 1,
  };
  try {
    const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
    if (r.response === 0) setImmediate(onAccept);
  } catch { /* 用户关了对话框 — 下次启动再提示 */ }
}

// ──────────────────────────────────────────────────────────────
// macOS — 自研链路
// ──────────────────────────────────────────────────────────────

let macUpdateInFlight = false;
/** 本次进程已经就"有包可装"问过用户的版本 —— 周期检查 (每 6h) 不许把同一句话再问一遍。
 *  用户点过「稍后」的账另由 restartPromptDismissed 记着, 那条更硬。 */
let stagedPromptedVersion: string | null = null;

async function runMacUpdateCheck(): Promise<void> {
  if (macUpdateInFlight) return;

  try {
    const mac = await import('./macUpdater.js');
    /* 当前版本用 app.getVersion() —— kernel 的 VERSION 走的是 tsup 注入的
     * apps/cli/package.json (CLI 独立版本线, 停在 3.1.9), 跟桌面发布版本 (3.1.21) 错开。
     * 用错基准的后果是这条自动更新线每 6 小时都判"有新版"并重新下载同一个包。
     * 跟 updateHandlers / 关于页同源。 */
    const { getAppVersion } = await import('./appVersion.js');
    const VERSION = getAppVersion();

    const manifest = await mac.fetchMacUpdateManifest();

    /* 版本比较: 只在严格更新时才动 */
    const parse = (v: string) => (v.replace(/^v/i, '').match(/(\d+)\.(\d+)\.(\d+)/) ?? [0, '0', '0', '0']).slice(1).map(Number);
    const [lm, ln, lp] = parse(manifest.version);
    const [cm, cn, cp] = parse(VERSION);
    const isNewer = lm > cm || (lm === cm && ln > cn) || (lm === cm && ln === cn && lp > cp);
    if (!isNewer) { console.log('[auto-update] 已是最新'); return; }

    const stagedAlready = await mac.resolveStagedMacUpdate();
    if (stagedAlready?.version === manifest.version) {
      console.log('[auto-update] 盘上已有校验过的包, 跳过下载:', manifest.version);
      if (stagedPromptedVersion !== stagedAlready.version && !restartPromptDismissed) {
        stagedPromptedVersion = stagedAlready.version;
        await promptRestart(stagedAlready.version, () => mac.installStagedMacUpdate(stagedAlready));
      }
      return;
    }

    /* 装不了就别下 600MB — 如实告诉用户去手动装 */
    const writable = mac.canSelfReplace();
    if (!writable.ok) {
      console.warn('[auto-update] 无法自替换:', writable.reason);
      broadcastUpdateError(writable.reason === 'not-writable' ? 'EACCES not-writable' : 'not-a-bundle');
      return;
    }

    macUpdateInFlight = true;
    console.log('[auto-update] 有新版:', manifest.version, '开始后台下载');
    const staged = await mac.downloadAndStageMacUpdate(manifest);
    stagedPromptedVersion = staged.version;
    console.log('[auto-update] 下载 + 校验 + 解压完成:', staged.version);

    await promptRestart(staged.version, () => mac.installStagedMacUpdate(staged));
  } catch (e: any) {
    console.warn('[auto-update] mac 自更新失败:', e?.message ?? e);
    broadcastUpdateError(String(e?.message ?? e));
  } finally {
    macUpdateInFlight = false;
  }
}

export async function installStagedUpdateOnQuit(): Promise<void> {
  if (process.platform !== 'darwin' || !app.isPackaged) return;
  if (restartPromptDismissed) {
    console.log('[auto-update] 用户点过「稍后」—— 退出时不静默安装');
    return;
  }
  try {
    const mac = await import('./macUpdater.js');
    /* 暂存包必须**真的还在盘上** —— resolveStagedMacUpdate 自带 existsSync + 复核。
     * 手动下载 (关于页 / 侧栏胶囊) 和后台自动下载共用这一份账, 两条路都认。 */
    const staged = await mac.resolveStagedMacUpdate();
    if (!staged) return;
    if (!mac.canSelfReplace().ok) return;
    if (mac.installStagedMacUpdate(staged, { onQuit: true })) {
      console.log('[auto-update] 退出时静默安装:', staged.version);
    }
  } catch (e: any) {
    /* 退出路径上任何失败都只能吞掉 —— 更新装不上是小事, 卡住退出是大事 */
    console.warn('[auto-update] 退出时静默安装失败 (忽略):', e?.message ?? e);
  }
}

// ──────────────────────────────────────────────────────────────
// Windows — electron-updater (原链路)
// ──────────────────────────────────────────────────────────────

async function setupWindowsAutoUpdate(): Promise<void> {
  /* electron-updater 是 CJS, 兼容多种导出形态取 autoUpdater */
  const mod = await import('electron-updater') as unknown as Record<string, unknown>;
  const autoUpdater = (mod.autoUpdater
    ?? (mod.default as Record<string, unknown> | undefined)?.autoUpdater
    ?? mod.default) as any;
  if (!autoUpdater || typeof autoUpdater.checkForUpdates !== 'function') {
    console.warn('[auto-update] autoUpdater 不可用, 跳过');
    return;
  }

  electronUpdaterRef = autoUpdater;           // 给 dismissRestartPrompt 用 (#106)
  autoUpdater.autoDownload = true;            // 有新版后台自动下
  /* 退出时静默装上 —— 只是**兜底**: 给那些从没看到过弹窗的用户。
   * 用户一旦明确点了"稍后", dismissRestartPrompt 会把这条关掉 (见那里的说明)。 */
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = {
    info: (m: unknown) => console.log('[auto-update]', m),
    warn: (m: unknown) => console.warn('[auto-update]', m),
    error: (m: unknown) => console.error('[auto-update]', m),
    debug: () => { /* 安静 */ },
  };

  autoUpdater.on('error', (err: { message?: string }) => {
    const message = String(err?.message ?? err);
    console.warn('[auto-update] error:', message);
    broadcastUpdateError(message);
  });
  autoUpdater.on('update-available', (info: { version?: string }) => console.log('[auto-update] 有新版:', info?.version));
  autoUpdater.on('update-not-available', () => console.log('[auto-update] 已是最新'));
  autoUpdater.on('update-downloaded', (info: { version?: string }) => {
    /* 无论手动/后台, 都把就绪态打到 updateHandlers 共享的那份上 ——
     * 否则后台下好的包对「关于」页的 update:install 闸门是隐形的,
     * 用户点安装反而被告知"没有已下载的更新包"。 */
    void import('./ipc/updateHandlers.js')
      .then((m) => m.markElectronUpdaterDownloaded(info?.version))
      .catch(() => { /* 打标失败不影响弹窗流程 */ });
    if (autoUpdater.__neoxManualUpdateInProgress) {
      console.log('[auto-update] 手动更新流程接管 update-downloaded:', info?.version);
      return;
    }
    void promptRestart(info?.version, () => requestWindowsUpdateInstall(autoUpdater));
  });

  scheduleChecks(() => {
    autoUpdater.checkForUpdates().catch((e: { message?: string }) => console.warn('[auto-update] check failed:', e?.message ?? e));
  });
}

// ──────────────────────────────────────────────────────────────

/** 启动 15s 后查一次 (不阻塞启动), 之后每 6 小时查一次. */
function scheduleChecks(run: () => void): void {
  checkTimer = setTimeout(run, 15_000);
  checkTimer.unref?.();
  checkInterval = setInterval(run, 6 * 60 * 60 * 1000);
  checkInterval.unref?.();
}

export async function setupAutoUpdate(): Promise<void> {
  if (!app.isPackaged) return; // dev 不跑自更新
  if (!DISTRIBUTION.autoUpdate) return; // 没有官方下载源的发行版 (开源版) —— 不能被"升级"成别的发行版

  try {
    if (process.platform === 'darwin') {
      scheduleChecks(() => { void runMacUpdateCheck(); });
      console.log('[auto-update] 已启用 (mac 自研 updater, feed: R2 latest-mac.yml)');
      return;
    }

    await setupWindowsAutoUpdate();
    console.log('[auto-update] 已启用 (electron-updater, feed: R2 generic)');
  } catch (e: unknown) {
    console.warn('[auto-update] 初始化失败 (非致命):', (e as { message?: string })?.message ?? e);
  }
}
