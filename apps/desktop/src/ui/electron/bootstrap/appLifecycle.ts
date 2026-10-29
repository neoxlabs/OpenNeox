import { app, BrowserWindow, dialog, ipcMain, powerMonitor, powerSaveBlocker } from 'electron';
import { bootstrapMasterKey, getMasterKeySource } from '@neoxlabs/platform/platform/dbCipher.js';
import { getDatabase, closeDatabase } from '@neoxlabs/platform/platform/database.js';
import { migrateToSqlite } from '@neoxlabs/platform/platform/database-migration.js';
import { storageService } from '../../../platform-electron/storageService.js';
import type { ProjectManager } from '../context/ProjectManager.js';
import { AGENT_BRIDGE } from '../context/tokens.js';
import { profileCheckpoint, printProfileSummary } from '@neoxlabs/platform/utils/startup/profiler.js';
import { preconnectFromConfig } from '@neoxlabs/platform/utils/startup/apiPreconnect.js';
import { beginStartupBreadcrumb, breadcrumb } from './startupBreadcrumb.js';

interface SetupAppLifecycleOptions {
  /** 用于 keepalive 时遍历所有已开 project 的 AgentBridge */
  projectManager: ProjectManager;
  createWindow: () => Promise<void>;
  onCachedUIStateLoaded: (uiState: Awaited<ReturnType<typeof storageService.loadUIState>>) => void;
  /**
   * 启动前置门闩：例如先恢复 auth userId / 会员态，再打开 SQLite 和窗口。
   * sessions 已全局化, 这里主要避免启动期云端入口、缓存和 UI 状态先按匿名态渲染。
   */
  beforeStorageReady?: () => Promise<void> | void;
}

export function setupAppLifecycle(options: SetupAppLifecycleOptions): void {
  const { projectManager, createWindow, onCachedUIStateLoaded, beforeStorageReady } = options;

  /** 对每个 open project 的 AgentBridge 都 ensureAlive. */
  const ensureAllAlive = (reason: string): void => {
    for (const scope of projectManager.listAll()) {
      const ab = scope.peekService(AGENT_BRIDGE);
      if (ab) void ab.ensureAlive(reason);
    }
  };

  // =========================================================================
  //
  // 'prevent-app-suspension' — 允许屏幕休眠，但阻止 app 进程被挂起。
  // 效果：主进程持续运行，TCP 连接不会因系统休眠而断掉，SSE 永远不会死。
  // 这与 Slack / Discord / VS Code 的做法相同，对电池影响极小。
  // =========================================================================
  let appSuspensionBlockerId: number | null = null;

  const startKeepAlive = () => {
    if (appSuspensionBlockerId !== null && powerSaveBlocker.isStarted(appSuspensionBlockerId)) {
      return; // 已经在运行
    }
    appSuspensionBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    console.log(`[KeepAlive] App suspension blocked (id=${appSuspensionBlockerId})`);
  };

  const stopKeepAlive = () => {
    if (appSuspensionBlockerId !== null && powerSaveBlocker.isStarted(appSuspensionBlockerId)) {
      powerSaveBlocker.stop(appSuspensionBlockerId);
      console.log(`[KeepAlive] App suspension blocker stopped`);
    }
    appSuspensionBlockerId = null;
  };

  /* 最后进入的启动阶段 — 失败弹框里带上它, 否则用户截图发过来只有一句 message,
   * 分不清是 sqlite 迁移挂了还是窗口没建起来。 */
  let lastStartupPhase = '';

  const runStartupPhase = async <T>(
    phase: string,
    slowWarnMs: number,
    task: () => Promise<T> | T,
  ): Promise<T> => {
    lastStartupPhase = phase;
    const startedAt = Date.now();
    /* 落盘 (无条件) —— console.log 在打包版 Windows 上进不了任何文件, 卡住就查不了。
     * 见 startupBreadcrumb.ts 顶部。 */
    breadcrumb(`${phase} start`);
    let slowTimer: ReturnType<typeof setTimeout> | null = null;
    if (slowWarnMs > 0) {
      slowTimer = setTimeout(() => {
        console.warn(`[Startup] ${phase} slow (> ${slowWarnMs}ms)`);
        breadcrumb(`${phase} SLOW`, `> ${slowWarnMs}ms`);
      }, slowWarnMs);
      slowTimer.unref?.();
    }

    try {
      return await Promise.resolve().then(task);
    } finally {
      if (slowTimer) clearTimeout(slowTimer);
      console.log(`[Startup] ${phase} done (${Date.now() - startedAt}ms)`);
      breadcrumb(`${phase} done`, `${Date.now() - startedAt}ms`);
    }
  };

  const scheduleDeferredPhase = (
    phase: string,
    delayMs: number,
    slowWarnMs: number,
    task: () => Promise<void> | void,
  ): void => {
    const timer = setTimeout(() => {
      void runStartupPhase(phase, slowWarnMs, task).catch((error: any) => {
        console.warn(`[Startup] ${phase} degraded: ${error?.message || String(error)}`);
      });
    }, delayMs);
    timer.unref?.();
  };

  app.whenReady().then(async () => {
    profileCheckpoint('electron_app_ready');


    /* 启动面包屑 —— 无条件落盘, 见 startupBreadcrumb.ts。必须是这里的第一件事,
     * 否则"卡在更前面"的情况连文件都不会被创建 (那本身也是信息: 文件不存在 =
     * 没走到 whenReady, 卡在 main.ts 顶层那几个同步活儿上)。 */
    beginStartupBreadcrumb({
      version: app.getVersion?.(),
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
    });

    let markStorageReady!: () => void;
    const storageReady = new Promise<void>((resolve) => { markStorageReady = resolve; });
    ipcMain.handle('startup:wait-ready', () => storageReady);

    void preconnectFromConfig();
    profileCheckpoint('electron_preconnect_initiated');

    // 应用就绪后立即开始永久保活
    startKeepAlive();

    const createWindowPromise = runStartupPhase('create_window', 3_000, () => createWindow()).catch((error: any) => {
      console.error(`[Startup] create_window failed: ${error?.message || String(error)}`);
      throw error;
    });

    const startupStartedAt = Date.now();

    // 本地身份恢复 (读+解密 auth.enc → setActiveUserId) — 纯 IPC/磁盘, 无网络。
    // main.ts 里后台跑, 不在这条关键路径上。
    let db: ReturnType<typeof getDatabase>;
    try {
      if (beforeStorageReady) {
        await runStartupPhase('auth_bucket_ready', 1_000, beforeStorageReady);
      }
      /* DB master key —— 必须在 getDatabase() (new NeoxDatabase) 之前 await 完。
       * 当前启动路径只预热 machine-id 派生 key, 不访问 macOS Keychain。
       * bootstrap 幂等可重复调, 这里仍保留硬屏障, 确保数据库初始化使用同一把 key。 */
      await runStartupPhase('master_key_bootstrap', 1_500, () => bootstrapMasterKey());
      if (process.env.NEOX_DIAG_LOG) {
        console.log('[Startup] master key source:', getMasterKeySource());
      }
      db = await runStartupPhase('sqlite_open', 2_000, () => getDatabase());
      await runStartupPhase('sqlite_migration', 1_500, () => {
        const migrationResult = migrateToSqlite(db);
        if (migrationResult) {
          console.log(`[Startup] sqlite_migration imported sessions=${migrationResult.sessionsImported} messages=${migrationResult.messagesImported} tokens=${migrationResult.tokenRecordsImported}`);
        }
      });
    } finally {
      /* 成功要放行, **失败更要放行** —— 否则渲染层会永远停在启动骨架上, 连错误页都出不来。
       * 真出错的话下面 whenReady 的 catch 会弹失败对话框。 */
      markStorageReady();
    }

    const cachedUIState = await runStartupPhase('load_ui_state', 1_000, () => storageService.loadUIState());
    onCachedUIStateLoaded(cachedUIState);

    // per-scope 重构后不再需要 —— 窗口被创建并触发 workspace:set 时,
    // ProjectManager 会按 sender 窗口挂 scope, scope 内部自己起 bridge.

    await createWindowPromise;

    // 非关键路径延迟执行：避免把首屏阻塞在历史 token 数据回填上
    scheduleDeferredPhase('token_usage_backfill', 600, 2_000, () => {
      const tokenBackfillResult = db.backfillHistoricalTokenUsage();
      if (!tokenBackfillResult.skipped) {
        console.log(`[Startup] token_usage_backfill updated=${tokenBackfillResult.updated} sessions=${tokenBackfillResult.sessionUpdated}`);
      }
    });

    profileCheckpoint('electron_critical_path_ready');
    console.log(`[Startup] critical path ready (${Date.now() - startupStartedAt}ms)`);
    printProfileSummary();

    // =========================================================================
    //    但极端情况下（强制休眠、合盖后接了充电等）系统可能仍然断连，
    //    所以保留这三个事件作为双保险
    // =========================================================================

    powerMonitor.on('resume', () => {
      console.log('[KeepAlive] System resumed');
      startKeepAlive(); // 确保 blocker 在唤醒后重新启动
      ensureAllAlive('system-resume');
    });

    powerMonitor.on('unlock-screen', () => {
      console.log('[KeepAlive] Screen unlocked');
      ensureAllAlive('screen-unlock');
    });

    // 窗口获得焦点时做一次轻量检查（debounce 500ms）
    let focusDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    app.on('browser-window-focus', (_event, win) => {
      if (!BrowserWindow.getAllWindows().includes(win)) return;
      if (focusDebounceTimer) clearTimeout(focusDebounceTimer);
      focusDebounceTimer = setTimeout(() => {
        focusDebounceTimer = null;
        ensureAllAlive('window-focus');
      }, 500);
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createWindow();
      }
    });
  }).catch((error: any) => {
    const message = error?.message || String(error);
    console.error('[Startup] critical path failed:', error);
    /* 窗口在启动途中没了 (用户点了关闭 / 第二个实例撞单实例锁 / 渲染进程崩溃带走它) —
     * 这不是故障, 弹一个 "Object has been destroyed" 只会让用户莫名其妙。安静退出。
     * 判据兼容两种: 我们自己标的 windowGone, 和 Electron 原生那句报错。 */
    const windowGone = error?.windowGone === true
      || /Object has been destroyed|Render frame was disposed/i.test(message);
    if (windowGone) {
      console.warn('[Startup] 窗口在启动途中被销毁, 安静退出 (不弹错误框)');
      app.quit();
      setTimeout(() => { try { app.exit(0); } catch { /* ignore */ } }, 3_000).unref?.();
      return;
    }
    try {
      dialog.showErrorBox(
        'Neox 启动失败',
        `启动过程中发生错误，应用无法继续:\n\n${message}\n\n`
        + (lastStartupPhase ? `失败阶段: ${lastStartupPhase}\n\n` : '')
        + `本地数据保存在 ~/.neox 与应用数据目录中，不会被此错误删除。\n`
        + `若反复出现，请反馈问题并附上 ~/.neox/logs 目录下最近的日志与 crash-*.json。`,
      );
    } catch { /* dialog 不可用 (极端环境) — 至少已落日志 */ }
    app.quit();
    /* quit 被某个 listener 卡住时的最终兜底 — 3s 后强制退出, 不留无窗口僵尸进程 */
    setTimeout(() => { try { app.exit(1); } catch { /* ignore */ } }, 3_000).unref?.();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  // daemon 杀掉 —— 否则用户 ⌘Q 后 server 子进程继续跑, 占着 DB 文件 / 端口 /
  // 内存. 每个 open project scope 各有一份 AgentBridge, 各自对应自己的 server.
  app.on('before-quit', () => {
    for (const scope of projectManager.listAll()) {
      const ab = scope.peekService(AGENT_BRIDGE);
      if (ab) {
        try {
          ab.shutdownServer();
        } catch (err: any) {
          console.error('[Main] shutdownServer failed:', err?.message);
        }
      }
    }
  });

  app.on('will-quit', () => {
    stopKeepAlive();
    try {
      closeDatabase();
    } catch (e: any) {
      console.error('[Main] Database close error:', e.message);
    }
  });
}
