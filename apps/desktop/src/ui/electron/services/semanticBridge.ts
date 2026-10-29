/**
 * SemanticBridge —— Electron main 进程里的语义层管家。
 *
 * 职责
 * ----
 * 1. 每个 workspace 持有一个 SemanticService 实例
 * 2. Workspace 切换时：dispose 旧的、构建新的、启动 bootstrap
 * 3. 通过 WatchCoordinator 订阅源文件变动，驱动增量索引
 * 4. 提供给 IPC handlers 同步查询接口
 *
 * 存储位置（对齐 IDEA / VSCode 业界做法）
 * ---------------------------------------
 * SQLite 数据库不再存在项目目录里，而是落在用户级缓存 dir：
 *   macOS:   ~/Library/Application Support/Neox/semantic/<hash>.db
 *   Windows: %APPDATA%/Neox/semantic/<hash>.db
 *   Linux:   ~/.config/neox/semantic/<hash>.db
 * 其中 <hash> = sha256(workspaceAbsolutePath).slice(0, 16)。
 * 这样可以避免：① 污染项目目录 ② 误 commit 巨大索引文件 ③ 多 workspace 重复索引。
 * 删除整个 semantic/ 目录不会影响代码，重建索引通常 < 10s。
 *
 * 生命周期
 * --------
 * - 启动时 SemanticBridge 不做任何事（lazy）
 * - 第一次 setWorkspace() 调用触发 bootstrap
 * - dispose() 清掉 watcher + 关闭 DB 句柄
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { join, relative, isAbsolute } from 'path';
import { existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'fs';
import { EventEmitter } from 'events';
import { DISTRIBUTION } from '@neoxlabs/kernel/platform/distribution.js';

// ============================================================================
// 全局缓存目录（对齐 storageService.ts:getConfigDir 的跨平台规则）
// ============================================================================
function getNeoxConfigDir(): string {
  const platform = process.platform;
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', DISTRIBUTION.appName);
  } else if (platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), DISTRIBUTION.appName);
  } else {
    const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    return path.join(xdgConfig, DISTRIBUTION.appName.toLowerCase());
  }
}

/** 给每个 workspace 算一个稳定的短 hash，用作 db 文件名前缀 */
function workspaceHash(workspaceRoot: string): string {
  return createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 16);
}

/** 计算 semantic.db 在全局缓存里的绝对路径 */
function getSemanticDbPath(workspaceRoot: string): string {
  const semanticDir = path.join(getNeoxConfigDir(), 'semantic');
  if (!existsSync(semanticDir)) {
    try { mkdirSync(semanticDir, { recursive: true }); } catch { /* ignore */ }
  }
  return path.join(semanticDir, `${workspaceHash(workspaceRoot)}.db`);
}

/**
 * 一次性迁移：如果项目里还残留 .neox/semantic.db，把它搬到全局缓存。
 * 同时把 -wal / -shm 一起搬。已经搬过 / 目标已存在 → 直接删源（重复，没用）。
 */
/**
 * 打开 SymbolStore, 若检测到 schema mismatch 则删库重建. 索引是纯缓存 ——
 * 丢失无业务影响, 下次 bootstrap 会重扫. 比用错误 schema 写脏数据安全得多.
 *
 * 仅重试一次: 如果重建后还 mismatch 说明是 CURRENT_SCHEMA_VERSION 本身
 * 和 INITIAL_SCHEMA_SQL 不一致 (代码 bug), 直接向上抛.
 */
function openSymbolStoreWithRebuild(
  dbPath: string,
  BetterSqliteCtor: new (p: string) => any,
): { db: any; store: SymbolStore } {
  const open = () => {
    const db = new BetterSqliteCtor(dbPath);
    try {
      const store = new SymbolStore(db);
      return { db, store };
    } catch (err) {
      try { db.close(); } catch { /* ignore — we're deleting anyway */ }
      throw err;
    }
  };

  try {
    return open();
  } catch (err) {
    if (!(err instanceof SchemaMismatchError)) throw err;
    console.warn('[SemanticBridge] schema mismatch, rebuilding', {
      dbVersion: err.dbVersion,
      codeVersion: err.codeVersion,
      kind: err.kind,
    });
    for (const suffix of ['', '-wal', '-shm']) {
      try { unlinkSync(dbPath + suffix); } catch { /* ignore */ }
    }
    return open();
  }
}

function migrateLegacySemanticDb(workspaceRoot: string, newDbPath: string): void {
  const legacyDb = path.join(workspaceRoot, '.neox', 'semantic.db');
  if (!existsSync(legacyDb)) return;
  try {
    const targetExists = existsSync(newDbPath);
    if (targetExists) {
      // 全局缓存已经有 db 了 —— 比较 mtime，留新的；反正只是缓存
      const legacyMtime = statSync(legacyDb).mtimeMs;
      const newMtime = statSync(newDbPath).mtimeMs;
      if (legacyMtime > newMtime) {
        renameSync(legacyDb, newDbPath);
        for (const suffix of ['-wal', '-shm']) {
          const src = legacyDb + suffix;
          if (existsSync(src)) renameSync(src, newDbPath + suffix);
        }
        console.log('[SemanticBridge] migrated legacy .neox/semantic.db (newer) → global cache');
      } else {
        // 新的更新 → 删除遗留旧文件
        try { unlinkSync(legacyDb); } catch { /* ignore */ }
        for (const suffix of ['-wal', '-shm']) {
          try { unlinkSync(legacyDb + suffix); } catch { /* ignore */ }
        }
        console.log('[SemanticBridge] removed legacy .neox/semantic.db (global cache is newer)');
      }
    } else {
      renameSync(legacyDb, newDbPath);
      for (const suffix of ['-wal', '-shm']) {
        const src = legacyDb + suffix;
        if (existsSync(src)) renameSync(src, newDbPath + suffix);
      }
      console.log('[SemanticBridge] migrated legacy .neox/semantic.db → global cache');
    }
  } catch (err) {
    console.warn('[SemanticBridge] legacy semantic.db migration failed (non-fatal):', err);
  }
}

// 因为 semantic 层包含 native deps (tree-sitter / better-sqlite3)，
// ide/index.ts 已经不再 re-export 它们（避免 Vite renderer pre-bundle 报错）。
import { SchemaMismatchError } from '../../../ide/semantic/symbolStore/SymbolStore.js';
import {
  SemanticService,
  SymbolStore,
  SEMANTIC_TOPIC,
  languageFromPath,
  type LanguageParser,
  type SemanticBootstrapPlan,
  type SemanticFileSystemPort,
  type IndexingProgress,
  type PaletteItem,
  type SymbolInfo,
  type FileInfo,
  type IdentifierUsage,
} from '../../../ide/semantic/index.js';
import { MessageBus } from '../../../ide/bus/MessageBus.js';

// Native deps —— lazy import（ESM 环境不能用 require）
let BetterSqlite: any;
let fastGlob: any;

import { computeSmartWorkspaceWatchRoots, getWatchCoordinator } from '@neoxlabs/core/runtime/watch/WatchCoordinator.js';
import { getProjectStartupDiagnostics, type ProjectStartupDiagnostics } from './projectStartupDiagnostics.js';
import { WorkerBackedTypeScriptParser } from './workerBackedTypeScriptParser.js';
import { SHARED_INDEX_IGNORE } from './indexIgnore.js';
import { WorkspaceIndexState, runSharedWorkspaceAudit } from './workspaceIndexState.js';

const SEMANTIC_INDEX_VERSION = 'semantic-2026-04-16-v1';
/* 清单收在 indexIgnore.ts —— 两个 bridge 必须用同一份, 原因见那个文件的头注释
 * (audit 按 workspace 缓存, 谁先跑谁定音, 各带各的清单等于抛硬币)。 */
const WORKSPACE_AUDIT_IGNORE = [...SHARED_INDEX_IGNORE];

async function lazyDeps() {
  if (!BetterSqlite) {
    const mod = await import('better-sqlite3');
    BetterSqlite = mod.default ?? mod;
  }
  if (!fastGlob) {
    const mod = await import('fast-glob');
    fastGlob = mod.default ?? mod;
  }
}
// FileSystemPort 适配器 —— 实现 SemanticFileSystemPort 接口
// ----------------------------------------------------------------------------
// 语义层要求 walk / readFile / stat 三件套。
// 用 fast-glob (已装依赖) 做递归扫描，尊重 ignore 列表。
// ============================================================================

function createNodeFileSystemPort(workspaceRoot: string): SemanticFileSystemPort {
  return {
    async walk(rootPath, options) {
      await lazyDeps();
      // fast-glob 的 cwd 跟 workspace 一致，返回相对路径
      const ignore = (options?.ignore ?? []).map((g) => (
        g.includes('/') || g.includes('*') ? g : `**/${g}/**`
      ));
      const entries = (await fastGlob('**/*', {
        cwd: rootPath,
        ignore,
        dot: false,
        onlyFiles: true,
        suppressErrors: true,
        stats: true,
        followSymbolicLinks: false,
        ...(options?.maxFiles ? {} : {}),
      })) as Array<{ path: string; stats: { size: number; mtimeMs: number } }>;

      const results: Array<{ path: string; size: number; mtime: number }> = [];
      for (const e of entries) {
        if (options?.maxFiles && results.length >= options.maxFiles) break;
        results.push({
          path: join(rootPath, e.path),
          size: e.stats.size,
          mtime: e.stats.mtimeMs,
        });
      }
      return results;
    },

    async readFile(filePath) {
      return fs.readFile(filePath, 'utf-8');
    },

    async stat(filePath) {
      try {
        const s = await fs.stat(filePath);
        return { size: s.size, mtime: s.mtimeMs };
      } catch {
        return null;
      }
    },
  };
}

// ============================================================================
// SemanticBridge
// ============================================================================

export class SemanticBridge extends EventEmitter {
  private workspaceRoot: string | null = null;
  private service: SemanticService | null = null;
  private store: SymbolStore | null = null;
  private db: any = null;
  private bus: MessageBus | null = null;
  private parser: LanguageParser | null = null;
  private watchSubscriptionId: number | null = null;
  private bootstrapPromise: Promise<void> | null = null;
  private lastProgress: IndexingProgress | null = null;
  private bootstrapStarted = false;
  private startupDiagnostics: ProjectStartupDiagnostics | null = null;
  private indexState: WorkspaceIndexState | null = null;
  private auditPromise: Promise<void> | null = null;
  private pendingWatchEvents = new Map<string, 'update' | 'delete'>();
  private watchFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private watchFlushPromise: Promise<void> | null = null;
  /** 第一个 pending 事件的时间, 用于 max-wait 兜底防饥饿 */
  private watchFirstPendingAt = 0;

  constructor() {
    super();
  }

  // --------------------------------------------------------------------------
  // 生命周期
  // --------------------------------------------------------------------------

  /**
   * 切换到新的 workspace。默认只准备资源；bootstrap 可延后到首屏 ready 后触发。
   */
  async setWorkspace(workspaceRoot: string, options?: { startBackground?: boolean }): Promise<void> {
    const diagnostics = getProjectStartupDiagnostics(workspaceRoot);
    diagnostics.markPhaseStart('semantic-set-workspace', {
      startBackground: options?.startBackground !== false,
    });
    if (this.workspaceRoot === workspaceRoot && this.service) {
      diagnostics.log('semantic-set-workspace:reuse');
      diagnostics.markPhaseEnd('semantic-set-workspace', { reused: true });
      if (options?.startBackground !== false) {
        this.startBootstrapIfNeeded('set-workspace');
        return this.bootstrapPromise ?? Promise.resolve();
      }
      return Promise.resolve();
    }

    // 清掉旧的
    await this.disposeCurrent();

    this.workspaceRoot = workspaceRoot;
    this.startupDiagnostics = diagnostics;
    this.startupDiagnostics.log('semantic-bridge-ready');

    try {
      await lazyDeps();

      // 打开 SQLite —— 全局缓存目录（避免污染项目）
      const dbPath = getSemanticDbPath(workspaceRoot);
      migrateLegacySemanticDb(workspaceRoot, dbPath);
      // Schema mismatch (代码版本回退 / migration 缺失) → 自动重建
      const opened = openSymbolStoreWithRebuild(dbPath, BetterSqlite);
      this.db = opened.db;
      this.store = opened.store;
      this.indexState = new WorkspaceIndexState(workspaceRoot);

      // 构造依赖
      this.bus = new MessageBus();
      this.parser = new WorkerBackedTypeScriptParser();

      // 事件订阅 —— 让 bridge 知道索引进度，转发给感兴趣的 IPC 订阅者
      this.bus.subscribe(SEMANTIC_TOPIC, {
        onBootstrapStarted: () => {
          this.emit('progress', { state: 'bootstrapping', filesIndexed: 0, filesTotal: 0, symbolsTotal: 0 });
        },
        onProgress: (p) => {
          this.lastProgress = p;
          this.emit('progress', p);
        },
        onReady: (p) => {
          this.lastProgress = p;
          this.emit('progress', p);
          this.emit('ready', p);
        },
        onFileIndexed: (filePath, symbols) => {
          this.emit('file-indexed', { filePath, symbols });
        },
        onFileRemoved: (filePath) => {
          this.emit('file-removed', filePath);
        },
        onError: (message, details) => {
          console.error('[SemanticBridge]', message, details);
        },
      });

      // 构造 service
      const parsers = new Map<string, LanguageParser>();
      for (const lang of this.parser.languages) {
        parsers.set(lang, this.parser);
      }
      this.service = new SemanticService({
        workspaceRoot,
        store: this.store,
        fs: createNodeFileSystemPort(workspaceRoot),
        bus: this.bus,
        parsers,
      });

      diagnostics.markPhaseEnd('semantic-set-workspace', {
        parserLanguages: this.parser.languages.length,
      });
      if (options?.startBackground !== false) {
        this.startBootstrapIfNeeded('set-workspace');
      }
    } catch (err) {
      diagnostics.log('semantic-set-workspace:failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      console.error('[SemanticBridge] setWorkspace failed:', err);
      await this.disposeCurrent();
    }
  }

  startBootstrapIfNeeded(reason = 'manual'): Promise<void> {
    if (!this.service || !this.workspaceRoot) {
      return Promise.resolve();
    }
    if (this.bootstrapStarted) {
      (this.startupDiagnostics ?? getProjectStartupDiagnostics(this.workspaceRoot)).log('semantic-bootstrap:reuse', { reason });
      return this.bootstrapPromise ?? Promise.resolve();
    }

    this.bootstrapStarted = true;
    const workspaceRoot = this.workspaceRoot;
    const diagnostics = this.startupDiagnostics ?? getProjectStartupDiagnostics(workspaceRoot);
    diagnostics.markPhaseStart('semantic-bootstrap', { reason });

    this.bootstrapPromise = (async () => {
      const startupPlan = await this.indexState?.buildStartupPlan('semantic', SEMANTIC_INDEX_VERSION);
      diagnostics.log('semantic-startup-plan', {
        reason,
        mode: startupPlan?.mode ?? 'full_scan',
        planReason: startupPlan?.reason ?? 'no-state',
        fileCount: startupPlan?.files.length ?? 0,
        changedFiles: startupPlan?.changedFiles.length ?? 0,
        removedPaths: startupPlan?.removedPaths.length ?? 0,
        needsAudit: startupPlan?.needsAudit ?? false,
      });
      const bootstrapPlan = startupPlan && startupPlan.mode !== 'full_scan' ? this.toSemanticBootstrapPlan(startupPlan) : undefined;
      await this.service!.bootstrap(bootstrapPlan);
      if (startupPlan?.mode === 'full_scan') {
        this.syncSnapshotFromService();
      } else {
        this.indexState?.upsertFiles(startupPlan?.changedFiles ?? []);
        this.indexState?.removeFiles(startupPlan?.removedPaths ?? []);
      }
      this.indexState?.setTargetVersion('semantic', SEMANTIC_INDEX_VERSION);
      diagnostics.markPhaseEnd('semantic-bootstrap', {
        mode: startupPlan?.mode ?? 'full_scan',
        planReason: startupPlan?.reason ?? 'no-state',
      });
      this.startWatcher(workspaceRoot);
      if (startupPlan?.needsAudit) {
        this.scheduleAudit();
      }
    })()
      .catch((err) => {
        diagnostics.log('semantic-bootstrap:failed', {
          reason,
          error: err instanceof Error ? err.message : String(err),
        });
        console.error('[SemanticBridge] bootstrap failed:', err);
      });

    return this.bootstrapPromise;
  }

  /** dispose 当前 workspace 的资源 */
  async disposeCurrent(): Promise<void> {
    if (this.watchSubscriptionId !== null) {
      getWatchCoordinator().unsubscribe(this.watchSubscriptionId);
      this.watchSubscriptionId = null;
    }
    if (this.service) {
      this.service.dispose();
      this.service = null;
    }
    if (this.store) {
      try {
        this.store.close();
      } catch { /* ignore */ }
      this.store = null;
    }
    if (this.db) {
      try {
        this.db.close();
      } catch { /* ignore */ }
      this.db = null;
    }
    this.bus = null;
    this.parser = null;
    this.bootstrapPromise = null;
    this.bootstrapStarted = false;
    this.startupDiagnostics = null;
    this.lastProgress = null;
    this.auditPromise = null;
    this.pendingWatchEvents.clear();
    if (this.watchFlushTimer) clearTimeout(this.watchFlushTimer);
    this.watchFlushTimer = null;
    this.watchFlushPromise = null;
    this.watchFirstPendingAt = 0;
    if (this.indexState) {
      try {
        this.indexState.close();
      } catch { /* ignore */ }
      this.indexState = null;
    }
    this.workspaceRoot = null;
  }

  private toRelPath(filePath: string): string {
    if (!this.workspaceRoot) return filePath.replace(/\\/g, '/');
    return relative(this.workspaceRoot, filePath).replace(/\\/g, '/').replace(/^\.\//, '');
  }

  private toSemanticBootstrapPlan(plan: Awaited<ReturnType<WorkspaceIndexState['buildStartupPlan']>>): SemanticBootstrapPlan {
    if (!this.workspaceRoot) return {};
    return {
      files: plan.files.map((entry) => ({
        path: join(this.workspaceRoot!, entry.relPath),
        size: entry.size,
        mtime: entry.mtime,
      })),
      changedPaths: plan.changedFiles.map((entry) => join(this.workspaceRoot!, entry.relPath)),
      removedPaths: plan.removedPaths.map((entry) => join(this.workspaceRoot!, entry)),
      reason: plan.reason,
    };
  }

  private syncSnapshotFromService(): void {
    if (!this.service || !this.workspaceRoot || !this.indexState) return;
    const snapshot = this.service.listKnownFiles().map((entry) => ({
      relPath: this.toRelPath(entry.path),
      size: entry.size ?? 0,
      mtime: entry.mtime ?? 0,
      language: entry.language,
    }));
    this.indexState.replaceSnapshot(snapshot);
  }

  private async consumePersistedDirtyEntries(source = 'journal'): Promise<void> {
    if (!this.service || !this.workspaceRoot || !this.indexState) return;
    const dirtyEntries = this.indexState.listDirtyEntries('semantic');
    if (dirtyEntries.length === 0) return;
    this.startupDiagnostics?.log('semantic-dirty-consume:start', {
      source,
      pendingCount: dirtyEntries.length,
    });
    const cleared: string[] = [];
    for (const entry of dirtyEntries) {
      const absPath = join(this.workspaceRoot, entry.relPath);
      if (entry.kind === 'delete') this.service.removeFile(absPath);
      else if (languageFromPath(absPath)) await this.service.reindexFile(absPath);
      cleared.push(entry.relPath);
    }
    this.indexState.clearDirtyEntries('semantic', cleared);
    this.startupDiagnostics?.log('semantic-dirty-consumed', {
      source,
      count: cleared.length,
      pendingCount: dirtyEntries.length,
    });
  }

  private scheduleAudit(): void {
    if (!this.indexState || this.auditPromise) return;
    this.startupDiagnostics?.markPhaseStart('semantic-audit');
    this.auditPromise = runSharedWorkspaceAudit(this.indexState, { ignore: WORKSPACE_AUDIT_IGNORE })
      .then((result) => {
        this.startupDiagnostics?.markPhaseEnd('semantic-audit', { ...result });
        this.startupDiagnostics?.log('semantic-audit-finished', { ...result });
        return this.consumePersistedDirtyEntries('audit');
      })
      .catch((error) => {
        this.startupDiagnostics?.log('semantic-audit-failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.auditPromise = null;
      });
  }

  // --------------------------------------------------------------------------
  // 增量 watcher
  // --------------------------------------------------------------------------

  private enqueueWatchEvent(filePath: string, kind: 'update' | 'delete'): void {
    this.pendingWatchEvents.set(filePath, kind);
    this.indexState?.recordDirty(this.toRelPath(filePath), kind, 'watch');

    // Trailing-edge debounce + max-wait floor (IDEA-style coalescing window):
    //   - 每个新事件重置 timer → 用户连续保存时不会被打断
    //   - max-wait 兜底 → 极高频写入时不会永远饿死 (最多延迟 3s)
    // 120ms leading-edge debounce 在频繁保存 / HMR 写盘时每 120ms flush 一次,
    // 导致用户体感卡顿. 换成 800ms trailing + 3s max-wait.
    const DEBOUNCE_MS = 800;
    const MAX_WAIT_MS = 3000;

    if (this.watchFirstPendingAt === 0) this.watchFirstPendingAt = Date.now();
    const elapsed = Date.now() - this.watchFirstPendingAt;
    const wait = Math.max(0, Math.min(DEBOUNCE_MS, MAX_WAIT_MS - elapsed));

    if (this.watchFlushTimer) clearTimeout(this.watchFlushTimer);
    this.watchFlushTimer = setTimeout(() => {
      this.watchFlushTimer = null;
      this.watchFirstPendingAt = 0;
      void this.flushWatchEvents();
    }, wait);
  }

  private async flushWatchEvents(): Promise<void> {
    if (this.watchFlushPromise || this.pendingWatchEvents.size === 0) return;
    const events = [...this.pendingWatchEvents.entries()];
    this.pendingWatchEvents.clear();
    this.startupDiagnostics?.log('semantic-watch-flush:start', { queued: events.length });
    this.watchFlushPromise = (async () => {
      const cleared: string[] = [];
      for (const [filePath, kind] of events) {
        if (!this.service) continue;
        if (kind === 'delete') this.service.removeFile(filePath);
        else if (languageFromPath(filePath)) await this.service.reindexFile(filePath);
        cleared.push(this.toRelPath(filePath));
      }
      this.indexState?.clearDirtyEntries('semantic', cleared);
      this.startupDiagnostics?.log('semantic-watch-flush:done', {
        queued: events.length,
        cleared: cleared.length,
      });
    })();
    try {
      await this.watchFlushPromise;
    } finally {
      this.watchFlushPromise = null;
      if (this.pendingWatchEvents.size > 0) void this.flushWatchEvents();
    }
  }

  private startWatcher(workspaceRoot: string): void {
    if (this.watchSubscriptionId !== null) return;
    const watchRoots = computeSmartWorkspaceWatchRoots(workspaceRoot);
    this.startupDiagnostics?.log('semantic-watcher:start', {
      watchRoots: watchRoots.length,
    });

    const coordinator = getWatchCoordinator();
    coordinator.start(workspaceRoot);

    this.watchSubscriptionId = coordinator.subscribe(
      (events) => {
        for (const event of events) {
          if (event.kind === 'add' || event.kind === 'change') {
            this.enqueueWatchEvent(event.filePath, 'update');
          } else if (event.kind === 'unlink') {
            this.enqueueWatchEvent(event.filePath, 'delete');
          }
        }
      },
      {
        name: 'SemanticBridge',
        kinds: ['add', 'change', 'unlink'],
        watchRoots,
        fileFilter: (relativePath) => Boolean(languageFromPath(relativePath)),
        debounceMs: 200,
      },
    );
  }

  // --------------------------------------------------------------------------
  // 查询 API —— IPC handlers 直接调这些
  // --------------------------------------------------------------------------

  getWorkspace(): string | null {
    return this.workspaceRoot;
  }

  isReady(): boolean {
    return this.service?.isReady() ?? false;
  }

  getProgress(): IndexingProgress | null {
    return this.service?.getProgress() ?? this.lastProgress;
  }

  searchFiles(query: string, limit?: number): PaletteItem[] {
    if (!this.service) return [];
    return this.service.searchFiles(query, limit);
  }

  searchSymbols(query: string, limit?: number): PaletteItem[] {
    if (!this.service) return [];
    return this.service.searchSymbols(query, limit);
  }

  searchPalette(query: string, limit?: number): PaletteItem[] {
    if (!this.service) return [];
    return this.service.searchPalette(query, limit);
  }

  getFileOutline(filePath: string): SymbolInfo[] {
    if (!this.service) return [];
    // 规范化路径：如果传的是相对路径，接上 workspace
    const abs = isAbsolute(filePath)
      ? filePath
      : this.workspaceRoot
        ? join(this.workspaceRoot, filePath)
        : filePath;
    return this.service.getFileOutline(abs);
  }

  getSymbolById(symbolId: number): SymbolInfo | undefined {
    return this.service?.getSymbolById(symbolId);
  }

  /**
   * 按名字精确查符号（用于 F12 跳转）。
   * 返回按 exported + score 排序的前 N 条。
   */
  findSymbolsByName(name: string, limit = 20): SymbolInfo[] {
    if (!this.service) return [];
    // 复用 searchSymbols —— 但 palette item 不带完整 info
    // 这里改走 store 前缀查询，再精确匹配
    const palette = this.service.searchSymbols(name, limit * 2);
    const matching = palette
      .filter((p) => p.label.toLowerCase() === name.toLowerCase())
      .slice(0, limit);
    return matching
      .map((p) => {
        const id = p.payload.symbolId as number | undefined;
        if (id === undefined) return undefined;
        return this.service!.getSymbolById(id);
      })
      .filter((s): s is SymbolInfo => !!s);
  }

  listIndexedFiles(): FileInfo[] {
    return this.service?.listIndexedFiles() ?? [];
  }

  /** Find Usages —— 按名字精确查询所有 identifier 出现点 */
  findUsagesByName(
    name: string,
    options?: { includeDeclarations?: boolean; limit?: number },
  ): IdentifierUsage[] {
    if (!this.service) return [];
    return this.service.findUsagesByName(name, options);
  }

  /**
   * Rename —— 按名字查所有出现点 (含声明)，返回需要编辑的 file→edits 映射。
   *
   * 注意：这是按名字匹配的 non-scoped rename（跟 IDEA 无类型推断时一致）。
   * 真正的 scoped rename 需要 LSP 的 textDocument/rename。
   */
  getRenameEdits(
    oldName: string,
    newName: string,
  ): Array<{ filePath: string; line: number; column: number; endColumn: number }> {
    if (!this.service) return [];
    const usages = this.service.findUsagesByName(oldName, {
      includeDeclarations: true,
      limit: 10_000,
    });
    return usages.map((u) => ({
      filePath: u.filePath,
      line: u.line,
      column: u.column,
      endColumn: u.endColumn,
    }));
  }
}

/** 为了 relative 不被 tree-shaking 误删除（IDE 静态检查保护） */
void relative;
void path;
