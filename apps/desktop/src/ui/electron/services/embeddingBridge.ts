/**
 * EmbeddingBridge — per-workspace local code-search index (BM25 + symbol)
 *
 * Storage: SQLite at ~/Library/Application Support/Neox/embeddings/<workspaceHash>.db
 * Index:  纯本地 tree-sitter chunker + BM25 关键词倒排 + chunk_symbols (tree-sitter).
 * 没有 LLM / 没有向量 / 没有任何网络请求. IDEA 风格本地索引.
 * Incremental: WatchCoordinator subscription + file hash comparison
 *
 * 注: 类名保留 `EmbeddingBridge` 只是历史遗留, 实际不再跑 embedding API. 旧
 * DB 如果检测到 `embeddings` 表会被自动 unlink 重建.
 */

import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import { execFile, type ExecFileException } from 'child_process';
import { createRequire } from 'module';
import { app } from 'electron';
import { performance } from 'perf_hooks';
import glob from 'fast-glob';
import { computeSmartWorkspaceWatchRoots, getWatchCoordinator, type WatchEvent } from '@neoxlabs/core/runtime/watch/WatchCoordinator.js';
import { getProjectStartupDiagnostics, type ProjectStartupDiagnostics } from './projectStartupDiagnostics.js';
import { minimatch } from 'minimatch';
import { loadConfig } from '@neoxlabs/platform/utils/config.js';
import { getIndexingCpuPool } from './indexingCpuPool.js';
import { IndexDbClient } from './indexDbClient.js';
import { EMBEDDING_EXTRA_IGNORE, SHARED_INDEX_IGNORE } from './indexIgnore.js';
import { WorkspaceIndexState, runSharedWorkspaceAudit } from './workspaceIndexState.js';

const _require = createRequire(import.meta.url);

// ─── Types ───────────────────────────────────────────────────────────────────

interface ChunkRow {
  id: number;
  file_path: string;
  start_line: number;
  end_line: number;
  content: string;
  file_hash: string;
  indexed_at: number;
}

export interface ChunkSymbol {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  signature?: string;
  containerName?: string;
}

interface ChunkSymbolRow {
  name: string;
  kind: string;
  start_line: number;
  end_line: number;
  signature: string | null;
  container_name: string | null;
}

interface EmbeddingBridgeOptions {
  getFileSymbols?: (filePath: string) => Promise<ChunkSymbol[]>;
}

interface SearchResult {
  file: string;
  startLine: number;
  endLine: number;
  content: string;
  score: number;
  relatedSymbols?: ChunkSymbol[];
}

interface BuildResult {
  filesIndexed: number;
  chunksCreated: number;
  timeMs: number;
}

interface StatusResult {
  ready: boolean;
  fileCount: number;
  chunkCount: number;
  lastBuilt: number | null;
  indexing: boolean;
}

interface CandidateFileEntry {
  relPath: string;
  size: number;
  mtime: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const INDEXED_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java',
  '.c', '.cpp', '.cs', '.md', '.txt', '.json', '.yaml', '.yml',
  '.css', '.scss', '.html', '.sh',
]);

/* 跟 semanticBridge 同一份 —— 两边的 audit 共用一把锁, 清单不一致时生效的是
 * 先跑起来的那一份 (见 indexIgnore.ts)。 */
const IGNORE_PATTERNS = [...SHARED_INDEX_IGNORE, ...EMBEDDING_EXTRA_IGNORE];

const DEFAULT_MAX_FILE_SIZE = 1024 * 1024;
// 版本 bump: LLM embedding 已移除, 索引回退为纯本地 BM25. 旧版本状态标记
// 会被 buildStartupPlan 判为过期 → full_scan 重建.
const EMBEDDING_INDEX_VERSION = 'local-bm25-2026-04-17-v1';

function normalizeRelPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

function matchesIgnorePatterns(filePath: string, patterns: string[]): boolean {
  const normalized = normalizeRelPath(filePath);
  return patterns.some((pattern) => minimatch(normalized, normalizeRelPath(pattern), { dot: true, nocase: process.platform === 'win32' }));
}

function isWithinSizeLimit(absPath: string, maxFileSize: number): boolean {
  try {
    return fs.statSync(absPath).size <= maxFileSize;
  } catch {
    return false;
  }
}

async function execFileText(file: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(String(stdout));
    });
  });
}

function loadIndexingConfig(): { excludePatterns: string[]; maxFileSize: number } {
  const config = loadConfig();
  return {
    excludePatterns: config.indexing?.excludePatterns ?? [],
    maxFileSize: config.indexing?.maxFileSize ?? DEFAULT_MAX_FILE_SIZE,
  };
}

// ─── Chunking ────────────────────────────────────────────────────────────────

function chunkFile(content: string): Array<{ startLine: number; endLine: number; text: string }> {
  const lines = content.split('\n');
  const TARGET = 1600;
  const OVERLAP = 3;
  const chunks: Array<{ startLine: number; endLine: number; text: string }> = [];
  let start = 0;
  while (start < lines.length) {
    let end = start;
    let chars = 0;
    while (end < lines.length && chars < TARGET) {
      chars += lines[end].length + 1;
      end++;
    }
    const text = lines.slice(start, end).join('\n');
    if (text.trim()) {
      chunks.push({ startLine: start + 1, endLine: end, text });
    }
    if (end >= lines.length) break;
    start = Math.max(start + 1, end - OVERLAP);
  }
  return chunks;
}

function fileHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

function selectChunkSymbols(symbols: ChunkSymbol[], startLine: number, endLine: number, limit = 4): ChunkSymbol[] {
  return symbols
    .filter((symbol) => symbol.startLine <= endLine && symbol.endLine >= startLine)
    .sort((left, right) => {
      const leftInside = left.startLine >= startLine && left.endLine <= endLine ? 1 : 0;
      const rightInside = right.startLine >= startLine && right.endLine <= endLine ? 1 : 0;
      if (leftInside !== rightInside) return rightInside - leftInside;
      const leftSpan = left.endLine - left.startLine;
      const rightSpan = right.endLine - right.startLine;
      return leftSpan - rightSpan;
    })
    .slice(0, limit);
}

// ─── BM25 ────────────────────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_$]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && t.length < 40);
}

function computeTF(tokens: string[]): Record<string, number> {
  const freq: Record<string, number> = Object.create(null);
  for (const token of tokens) {
    if (!token) continue;
    const current = typeof freq[token] === 'number' ? freq[token] : 0;
    freq[token] = current + 1;
  }
  const total = tokens.length || 1;
  for (const token of Object.keys(freq)) {
    const normalized = freq[token] / total;
    if (Number.isFinite(normalized) && normalized > 0) {
      freq[token] = normalized;
    } else {
      delete freq[token];
    }
  }
  return freq;
}

function isValidBM25Term(term: string, tfVal: number): boolean {
  return term.length > 0 && Number.isFinite(tfVal) && tfVal > 0;
}

// ─── EmbeddingBridge ─────────────────────────────────────────────────────────

export class EmbeddingBridge extends EventEmitter {
  private workspaceRoot: string | null = null;
  /* 索引库不在这个线程里 —— 见 indexDbClient.ts。这里拿到的每个方法都是 async,
   * 主线程在索引这条路径上只做 postMessage。 */
  private db: IndexDbClient | null = null;
  private watchSubscriptionId: number | null = null;
  private indexing = false;
  private currentBuild: Promise<BuildResult> | null = null;
  private readonly getFileSymbols?: (filePath: string) => Promise<ChunkSymbol[]>;
  private startupDiagnostics: ProjectStartupDiagnostics | null = null;
  private indexState: WorkspaceIndexState | null = null;
  private auditPromise: Promise<void> | null = null;
  private pendingWatchEvents = new Map<string, 'update' | 'delete'>();
  private watchFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private watchFlushPromise: Promise<void> | null = null;
  /** 第一个 pending 事件的时间, 用于 max-wait 兜底防饥饿 */
  private watchFirstPendingAt = 0;

  constructor(options: EmbeddingBridgeOptions = {}) {
    super();
    this.getFileSymbols = options.getFileSymbols;
  }

  private async resolveFileSymbols(relPath: string): Promise<ChunkSymbol[]> {
    if (!this.getFileSymbols) return [];
    try {
      return (await this.getFileSymbols(relPath))
        .filter((symbol) => symbol.startLine > 0 && symbol.endLine >= symbol.startLine)
        .map((symbol) => ({
          name: symbol.name,
          kind: symbol.kind,
          startLine: symbol.startLine,
          endLine: symbol.endLine,
          signature: symbol.signature,
          containerName: symbol.containerName,
        }));
    } catch {
      return [];
    }
  }


  private async preprocessContent(content: string, relatedSymbols: ChunkSymbol[]): Promise<Array<{
    startLine: number;
    endLine: number;
    text: string;
    terms: Array<{ term: string; tf: number }>;
    relatedSymbols: ChunkSymbol[];
  }>> {
    const result = await getIndexingCpuPool().run({
      kind: 'embedding-preprocess',
      payload: { content, relatedSymbols },
    });
    return (result as {
      chunks: Array<{
        startLine: number;
        endLine: number;
        text: string;
        terms: Array<{ term: string; tf: number }>;
        relatedSymbols: ChunkSymbol[];
      }>;
    }).chunks;
  }

  /* BM25 打分 / 符号加权 / 结果重排整体搬进了 indexDbWorker —— 它们全是紧挨着
   * SQLite 的循环, 留在这一侧就等于把主线程绑在库上。搬走的同时也修掉了
   * "每个候选打一次 term 查询" 和 "每次搜索全表扫 avgDocLen" 两条, 见 worker 头注释。 */

  private getIgnorePatterns(): string[] {
    const { excludePatterns } = loadIndexingConfig();
    return Array.from(new Set([...IGNORE_PATTERNS, ...excludePatterns]));
  }

  private getMaxFileSize(): number {
    return loadIndexingConfig().maxFileSize;
  }

  private ignoreBatch: { root: string; waiters: Map<string, Array<(ignored: boolean) => void>> } | null = null;

  private async isGitIgnored(relPath: string): Promise<boolean> {
    const workspaceRoot = this.workspaceRoot;
    if (!workspaceRoot) return false;
    const rel = normalizeRelPath(relPath);
    return new Promise((resolve) => {
      if (this.ignoreBatch && this.ignoreBatch.root !== workspaceRoot) this.flushIgnoreBatch();
      if (!this.ignoreBatch) {
        this.ignoreBatch = { root: workspaceRoot, waiters: new Map() };
        setTimeout(() => this.flushIgnoreBatch(), 25);
      }
      const list = this.ignoreBatch.waiters.get(rel) ?? [];
      list.push(resolve);
      this.ignoreBatch.waiters.set(rel, list);
    });
  }

  private flushIgnoreBatch(): void {
    const batch = this.ignoreBatch;
    this.ignoreBatch = null;
    if (!batch || batch.waiters.size === 0) return;
    const settle = (ignored: Set<string>) => {
      for (const [p, fns] of batch.waiters) for (const fn of fns) fn(ignored.has(p));
    };
    try {
      const child = execFile(
        'git',
        ['check-ignore', '--no-index', '--stdin', '-z'],
        { cwd: batch.root, maxBuffer: 16 * 1024 * 1024, encoding: 'utf-8' },
        (error: ExecFileException | null, stdout: string) => {
          /* exit 0 = 至少一个被忽略, exit 1 = 都没被忽略; 其它 (不是仓库等) 按"没被忽略"处理, 同原逻辑 */
          const exitCode = error ? (typeof error.code === 'number' ? error.code : null) : 0;
          if (exitCode !== 0) { settle(new Set()); return; }
          settle(new Set(String(stdout).split('\0').filter(Boolean)));
        },
      );
      child.stdin?.on('error', () => { /* 进程提前退出时 EPIPE; 结果走回调 */ });
      child.stdin?.end([...batch.waiters.keys()].join('\0') + '\0');
    } catch {
      settle(new Set());
    }
  }

  private async listCandidateEntries(): Promise<CandidateFileEntry[]> {
    if (!this.workspaceRoot) return [];

    const maxFileSize = this.getMaxFileSize();
    const ignorePatterns = this.getIgnorePatterns();
    const toEntry = (relPath: string): CandidateFileEntry | null => {
      const normalized = normalizeRelPath(relPath);
      if (!normalized) return null;
      if (matchesIgnorePatterns(normalized, ignorePatterns)) return null;
      if (!INDEXED_EXTS.has(path.extname(normalized))) return null;
      const absPath = path.join(this.workspaceRoot!, normalized);
      try {
        const stat = fs.statSync(absPath);
        if (!stat.isFile() || stat.size > maxFileSize) return null;
        return {
          relPath: normalized,
          size: stat.size,
          mtime: stat.mtimeMs,
        };
      } catch {
        return null;
      }
    };

    try {
      const stdout = await execFileText(
        'git',
        ['ls-files', '-co', '--exclude-standard'],
        this.workspaceRoot,
      );
      return stdout
        .split('\n')
        .map((line) => toEntry(line.trim()))
        .filter((entry): entry is CandidateFileEntry => !!entry);
    } catch {
      const files = await glob('**/*', {
        cwd: this.workspaceRoot,
        ignore: ignorePatterns,
        onlyFiles: true,
        dot: false,
      });
      return files
        .map((relPath) => toEntry(relPath))
        .filter((entry): entry is CandidateFileEntry => !!entry);
    }
  }

  private async shouldIndexPath(
    relPath: string,
    absPath?: string,
    options?: { checkGitIgnore?: boolean },
  ): Promise<boolean> {
    const normalized = normalizeRelPath(relPath);
    if (!INDEXED_EXTS.has(path.extname(normalized))) return false;
    if (matchesIgnorePatterns(normalized, this.getIgnorePatterns())) return false;

    const filePath = absPath ?? (this.workspaceRoot ? path.join(this.workspaceRoot, normalized) : normalized);
    if (!isWithinSizeLimit(filePath, this.getMaxFileSize())) return false;
    if (options?.checkGitIgnore !== false && await this.isGitIgnored(normalized)) return false;

    return true;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────

  async setWorkspace(root: string, options?: { startBackground?: boolean }): Promise<void> {
    const diagnostics = getProjectStartupDiagnostics(root);
    diagnostics.markPhaseStart('embedding-set-workspace', {
      startBackground: options?.startBackground !== false,
    });
    if (this.workspaceRoot === root && this.db) {
      diagnostics.log('embedding-set-workspace:reuse');
      diagnostics.markPhaseEnd('embedding-set-workspace', { reused: true });
      return;
    }
    await this.disposeCurrent();
    this.workspaceRoot = root;
    this.startupDiagnostics = diagnostics;
    this.startupDiagnostics.log('embedding-bridge-ready');
    this.indexState = new WorkspaceIndexState(root);
    await this.openDB(root);
    diagnostics.markPhaseEnd('embedding-set-workspace');
    if (options?.startBackground !== false) {
      this.buildIndex(false).catch((err) =>
        console.error('[EmbeddingBridge] Background index error:', err),
      );
    }
    this.startWatcher(root);
  }

  async disposeCurrent(): Promise<void> {
    if (this.watchSubscriptionId !== null) {
      getWatchCoordinator().unsubscribe(this.watchSubscriptionId);
      this.watchSubscriptionId = null;
    }
    if (this.db) {
      /* dispose 而不是 close —— 换 workspace 就换一个库, 让 worker 一起收掉,
       * 否则每切一次工作区就多一条常驻线程 (退出时清理只是优化, 这里必须当场收)。 */
      try {
        await this.db.dispose();
      } catch {
        // ignore
      }
      this.db = null;
    }
    this.startupDiagnostics = null;
    this.auditPromise = null;
    this.pendingWatchEvents.clear();
    if (this.watchFlushTimer) clearTimeout(this.watchFlushTimer);
    this.watchFlushTimer = null;
    this.watchFlushPromise = null;
    this.watchFirstPendingAt = 0;
    if (this.indexState) {
      try {
        this.indexState.close();
      } catch {
        // ignore
      }
      this.indexState = null;
    }
    this.workspaceRoot = null;
  }

  private toRelPath(absPath: string): string {
    if (!this.workspaceRoot) return normalizeRelPath(absPath);
    return normalizeRelPath(path.relative(this.workspaceRoot, absPath));
  }

  private async consumePersistedDirtyEntries(source = 'journal'): Promise<void> {
    if (!this.indexState || !this.workspaceRoot) return;
    const dirtyEntries = this.indexState.listDirtyEntries('embedding');
    if (dirtyEntries.length === 0) return;
    this.startupDiagnostics?.log('embedding-dirty-consume:start', {
      source,
      pendingCount: dirtyEntries.length,
    });
    const cleared: string[] = [];
    for (const entry of dirtyEntries) {
      const absPath = path.join(this.workspaceRoot, entry.relPath);
      const handled = entry.kind === 'delete'
        ? this.deleteFile(absPath)
        : await this.reindexFile(absPath);
      if (handled) {
        cleared.push(entry.relPath);
      }
    }
    this.indexState.clearDirtyEntries('embedding', cleared);
    this.startupDiagnostics?.log('embedding-dirty-consumed', {
      source,
      count: cleared.length,
      pendingCount: dirtyEntries.length,
    });
  }

  private scheduleAudit(): void {
    if (!this.indexState || this.auditPromise) return;
    this.startupDiagnostics?.markPhaseStart('embedding-audit');
    this.auditPromise = runSharedWorkspaceAudit(this.indexState, { ignore: this.getIgnorePatterns() })
      .then((result) => {
        this.startupDiagnostics?.markPhaseEnd('embedding-audit', { ...result });
        this.startupDiagnostics?.log('embedding-audit-finished', { ...result });
        return this.consumePersistedDirtyEntries('audit');
      })
      .catch((error) => {
        this.startupDiagnostics?.log('embedding-audit-failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.auditPromise = null;
      });
  }

  // ─── DB ────────────────────────────────────────────────────────────────

  /**
   * 建库连接 —— 真正的 open (建表 / 迁移 / 清孤儿) 发生在 indexDbWorker 里。
   *
   *   老版本携带 `embeddings` 表 (float32 向量 BLOB, 单库可达几百 MB)。现在索引
   *   是纯本地 BM25, 旧库直接 unlink 重建 —— 这个判断也在 worker 里做, 主线程
   *   不再为了探一眼表名就在自己身上开一个 SQLite 连接。
   */
  private async openDB(root: string): Promise<void> {
    const hash = crypto.createHash('md5').update(root).digest('hex');
    const dir = path.join(app.getPath('userData'), 'embeddings');
    fs.mkdirSync(dir, { recursive: true });
    const dbPath = path.join(dir, `${hash}.db`);
    const client = new IndexDbClient();
    await client.open(dbPath);
    this.db = client;
  }

  private enqueueWatchEvent(absPath: string, kind: 'update' | 'delete'): void {
    this.pendingWatchEvents.set(absPath, kind);
    this.indexState?.recordDirty(this.toRelPath(absPath), kind, 'watch');

    // Trailing-edge debounce + max-wait floor (IDEA-style coalescing window).
    // BM25 重建比 semantic 稍重一点 (要重新 chunk + tokenize + 写 SQLite),
    // 静默窗口:
    //   - 2s 静默 → 用户停手才 flush
    //   - 10s 兜底 → 极端情况也不饿死
    const DEBOUNCE_MS = 2000;
    const MAX_WAIT_MS = 10000;

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
    const waitedOnBuild = Boolean(this.currentBuild);
    this.startupDiagnostics?.log('embedding-watch-flush:start', {
      queued: events.length,
      waitedOnBuild,
    });
    this.watchFlushPromise = (async () => {
      if (this.currentBuild) {
        this.startupDiagnostics?.log('embedding-watch-flush:wait-build', { queued: events.length });
        await this.currentBuild.catch(() => undefined);
      }
      const cleared: string[] = [];
      for (const [absPath, kind] of events) {
        const handled = kind === 'delete'
          ? this.deleteFile(absPath)
          : await this.reindexFile(absPath);
        if (handled) {
          cleared.push(this.toRelPath(absPath));
        }
      }
      this.indexState?.clearDirtyEntries('embedding', cleared);
      this.startupDiagnostics?.log('embedding-watch-flush:done', {
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

  // ─── Watcher ───────────────────────────────────────────────────────────

  private getWatchTargets(root: string): string[] {
    return computeSmartWorkspaceWatchRoots(root);
  }

  private startWatcher(root: string): void {
    const targets = this.getWatchTargets(root);
    const ignorePatterns = this.getIgnorePatterns();
    const isRootOnly = targets.length === 1 && targets[0] === root;
    this.startupDiagnostics?.log('embedding-watcher:start', {
      watchRoots: targets.length,
      rootOnly: isRootOnly,
    });

    const coordinator = getWatchCoordinator();
    coordinator.start(root);

    this.watchSubscriptionId = coordinator.subscribe(
      (events) => {
        for (const event of events) {
          if (event.kind === 'change' || event.kind === 'add') {
            this.enqueueWatchEvent(event.filePath, 'update');
          } else if (event.kind === 'unlink') {
            this.enqueueWatchEvent(event.filePath, 'delete');
          }
        }
      },
      {
        name: 'EmbeddingBridge',
        kinds: ['add', 'change', 'unlink'],
        watchRoots: targets,
        fileFilter: (relativePath) => {
          if (!isRootOnly) {
            const absPath = path.join(root, relativePath);
            const inTarget = targets.some(
              (t) => absPath.startsWith(t + path.sep) || absPath === t,
            );
            if (!inTarget) return false;
          }
          for (const pattern of ignorePatterns) {
            if (minimatch(relativePath, pattern, { dot: true })) return false;
          }
          return true;
        },
        debounceMs: 300,
      },
    );
  }

  private async listIndexedChunkFiles(): Promise<string[]> {
    if (!this.db) return [];
    return (await this.db.listIndexedFiles()).map((filePath) => normalizeRelPath(filePath));
  }

  // ─── Build Index ───────────────────────────────────────────────────────

  async buildIndex(force = false): Promise<BuildResult> {
    if (!this.db || !this.workspaceRoot) {
      return { filesIndexed: 0, chunksCreated: 0, timeMs: 0 };
    }
    /* 在这里抓住句柄: 下面整个构建跑在一个 async IIFE 里, 期间 setWorkspace 可能
     * 把 this.db 换掉。抓一份就保证这一轮构建自始至终写的是同一个库。 */
    const db = this.db;
    if (this.currentBuild) {
      (this.startupDiagnostics ?? getProjectStartupDiagnostics(this.workspaceRoot)).log('embedding-build:reuse', { force });
      return this.currentBuild;
    }

    const diagnostics = this.startupDiagnostics ?? getProjectStartupDiagnostics(this.workspaceRoot);
    const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
    const roundMs = (value: number): number => Math.round(value * 10) / 10;

    this.currentBuild = (async () => {
      this.indexing = true;
      const startedAt = performance.now();
      let filesIndexed = 0;
      let chunksCreated = 0;
      let lastYieldAt = performance.now();
      let flushCount = 0;
      let unchangedFiles = 0;

      const maybeYield = async () => {
        if (performance.now() - lastYieldAt < 12) return;
        await yieldToEventLoop();
        lastYieldAt = performance.now();
      };

      diagnostics.markPhaseStart('embedding-build', { force });

      try {
        this.emit('progress', { phase: 'scanning', done: 0, total: 0 });

        const scanStartedAt = performance.now();
        const startupPlan = !force ? await this.indexState?.buildStartupPlan('embedding', EMBEDDING_INDEX_VERSION) : undefined;
        const fullScan = force || !startupPlan || startupPlan.mode === 'full_scan';
        const candidateEntries = fullScan
          ? await this.listCandidateEntries()
          : startupPlan.changedFiles.map((entry) => ({
            relPath: entry.relPath,
            size: entry.size,
            mtime: entry.mtime,
          }));
        const filtered = candidateEntries.map((entry) => entry.relPath);
        const candidateSet = new Set(filtered);
        const removedPaths = fullScan
          ? (await this.listIndexedChunkFiles()).filter((relPath) => !candidateSet.has(relPath))
          : (startupPlan?.removedPaths ?? []);
        const total = filtered.length;
        diagnostics.log('embedding-scan-finished', {
          fileCount: total,
          removedPaths: removedPaths.length,
          mode: startupPlan?.mode ?? 'full_scan',
          planReason: startupPlan?.reason ?? (force ? 'force' : 'no-state'),
          needsAudit: startupPlan?.needsAudit ?? false,
          elapsedMs: roundMs(performance.now() - scanStartedAt),
        });
        if (!force && startupPlan?.mode === 'clean' && total === 0 && removedPaths.length === 0) {
          diagnostics.log('embedding-build:cache-hit', {
            mode: startupPlan.mode,
            planReason: startupPlan.reason,
          });
          this.indexState?.setTargetVersion('embedding', EMBEDDING_INDEX_VERSION);
          this.emit('progress', { phase: 'done', done: 0, total: 0 });
          const result = { filesIndexed: 0, chunksCreated: 0, timeMs: Math.round(performance.now() - startedAt) };
          diagnostics.markPhaseEnd('embedding-build', {
            filesIndexed: 0,
            chunksCreated: 0,
            flushCount: 0,
            fileCount: 0,
            elapsedMs: roundMs(performance.now() - startedAt),
          });
          if (startupPlan.needsAudit) {
            this.scheduleAudit();
          }
          return result;
        }
        this.emit('progress', { phase: 'indexing', done: 0, total });

        /* 删除一次批量发过去 —— 老实现是每个路径一条 DELETE, 一次全量重建就是
         * 几千次同步语句轮流锁主线程。 */
        await db.deleteFiles(removedPaths);

        /* 文件 hash 一次批量取回。老实现是在文件循环里逐个 `SELECT ... LIMIT 1`,
         * 5000 个候选 = 5000 次同步查询, 而且**每一次都夹在主线程的 IO 循环中间**。
         * 增量构建时候选很少, 全量时这一趟也只有几次分片查询。 */
        const knownHashes = await db.getFileHashes(candidateEntries.map((entry) => entry.relPath));

        const BATCH = 50;
        type PendingChunk = {
          filePath: string;
          startLine: number;
          endLine: number;
          text: string;
          hash: string;
          terms: Array<{ term: string; tf: number }>;
          relatedSymbols: ChunkSymbol[];
        };
        type PrepareResult =
          | { kind: 'unchanged' }
          | { kind: 'drop' }
          | { kind: 'index'; chunks: PendingChunk[] };

        let done = 0;
        const currentBatch: PendingChunk[] = [];
        const settledEntries: CandidateFileEntry[] = [];
        const droppedPaths = new Set<string>();
        const failedPaths = new Set<string>();
        const prepareConcurrency = Math.max(1, Math.min(4, getIndexingCpuPool().getConcurrency()));
        diagnostics.log('embedding-preprocess-concurrency', { concurrency: prepareConcurrency });

        const flushPendingBatch = async (): Promise<void> => {
          if (currentBatch.length === 0) return;
          const batch = currentBatch.splice(0, currentBatch.length);
          /* 写库在 worker 里 —— 这个 await 期间主线程是**空闲**的, 可以照常渲染、
           * 照常响应 IPC。这是"永远不卡"的那一行。 */
          chunksCreated += await db.insertChunks(batch);
          flushCount += 1;
        };

        const prepareFile = async (entry: CandidateFileEntry): Promise<PrepareResult> => {
          const relFile = entry.relPath;
          const absFile = path.join(this.workspaceRoot!, relFile);
          if (!(await this.shouldIndexPath(relFile, absFile, { checkGitIgnore: false }))) {
            return { kind: 'drop' };
          }

          const content = await fs.promises.readFile(absFile, 'utf8');
          const hash = fileHash(content);

          if (!force && knownHashes[relFile] === hash) {
            return { kind: 'unchanged' };
          }

          const fileSymbols = await this.resolveFileSymbols(relFile);
          const preparedChunks = await this.preprocessContent(content, fileSymbols);
          return {
            kind: 'index',
            chunks: preparedChunks.map((chunk) => ({
              filePath: relFile,
              startLine: chunk.startLine,
              endLine: chunk.endLine,
              text: chunk.text,
              hash,
              terms: chunk.terms,
              relatedSymbols: chunk.relatedSymbols,
            })),
          };
        };

        for (let index = 0; index < candidateEntries.length; index += prepareConcurrency) {
          const slice = candidateEntries.slice(index, index + prepareConcurrency);
          const results = await Promise.all(slice.map(async (entry) => {
            try {
              return await prepareFile(entry);
            } catch {
              return null;
            }
          }));

          /* 这一批要删的路径先攒起来, 出了循环一次发过去 —— 一个路径一条 DELETE
           * 就等于把 worker 当同步库用, 往返开销比省下来的 SQL 还贵。 */
          const pendingDeletes: string[] = [];

          for (let offset = 0; offset < slice.length; offset += 1) {
            const entry = slice[offset];
            const relFile = entry.relPath;
            const prepared = results[offset];
            if (prepared?.kind === 'drop') {
              pendingDeletes.push(relFile);
              droppedPaths.add(relFile);
              filesIndexed += 1;
            } else if (prepared?.kind === 'index') {
              pendingDeletes.push(relFile);
              currentBatch.push(...prepared.chunks);
              settledEntries.push(entry);
              filesIndexed += 1;
            } else if (prepared?.kind === 'unchanged') {
              unchangedFiles += 1;
              settledEntries.push(entry);
            } else {
              failedPaths.add(relFile);
              settledEntries.push(entry);
            }

            done += 1;
            this.emit('progress', { phase: 'indexing', done, total });
            await maybeYield();
          }

          await db.deleteFiles(pendingDeletes);
          if (currentBatch.length >= BATCH) await flushPendingBatch();
        }

        await flushPendingBatch();

        for (const relPath of failedPaths) {
          this.indexState?.recordDirty(relPath, 'update', 'build');
        }

        await db.setMeta('last_built', String(Date.now()));

        const clearedDirty = (fullScan
          ? (this.indexState?.listDirtyEntries('embedding').map((entry) => entry.relPath) ?? [])
          : [...new Set([...candidateEntries.map((entry) => entry.relPath), ...removedPaths])])
          .filter((relPath) => !failedPaths.has(relPath));
        if (fullScan) {
          this.indexState?.replaceSnapshot(settledEntries);
          this.indexState?.clearDirtyEntries('embedding', clearedDirty);
        } else if (startupPlan) {
          this.indexState?.upsertFiles(settledEntries);
          this.indexState?.removeFiles([...removedPaths, ...droppedPaths]);
          this.indexState?.clearDirtyEntries('embedding', clearedDirty);
        }
        this.indexState?.setTargetVersion('embedding', EMBEDDING_INDEX_VERSION);

        this.emit('progress', { phase: 'done', done: total, total });
        const result = { filesIndexed, chunksCreated, timeMs: Math.round(performance.now() - startedAt) };
        diagnostics.markPhaseEnd('embedding-build', {
          filesIndexed,
          chunksCreated,
          flushCount,
          unchangedFiles,
          droppedPaths: droppedPaths.size,
          failedPaths: failedPaths.size,
          removedPaths: removedPaths.length,
          fileCount: total,
          elapsedMs: roundMs(performance.now() - startedAt),
        });
        if (startupPlan?.needsAudit) {
          this.scheduleAudit();
        }
        return result;
      } catch (err) {
        diagnostics.log('embedding-build:failed', {
          error: err instanceof Error ? err.message : String(err),
          elapsedMs: roundMs(performance.now() - startedAt),
        });
        throw err;
      } finally {
        this.indexing = false;
        this.currentBuild = null;
      }
    })();

    return this.currentBuild;
  }

  // ─── Incremental ───────────────────────────────────────────────────────

  private async reindexFile(absPath: string): Promise<boolean> {
    if (!this.db || !this.workspaceRoot) return false;
    const relPath = normalizeRelPath(path.relative(this.workspaceRoot, absPath));
    if (!(await this.shouldIndexPath(relPath, absPath))) {
      return this.deleteFile(absPath);
    }

    try {
      const db = this.db;
      const stat = fs.statSync(absPath);
      const content = await fs.promises.readFile(absPath, 'utf8');
      const hash = fileHash(content);
      const known = await db.getFileHashes([relPath]);
      if (known[relPath] === hash) {
        this.indexState?.upsertFiles([{ relPath, size: stat.size, mtime: stat.mtimeMs }]);
        return true;
      }

      await db.deleteFiles([relPath]);
      const fileSymbols = await this.resolveFileSymbols(relPath);
      const chunks = await this.preprocessContent(content, fileSymbols);
      await db.insertChunks(chunks.map((c) => ({
        filePath: relPath,
        startLine: c.startLine,
        endLine: c.endLine,
        text: c.text,
        hash,
        terms: c.terms,
        relatedSymbols: c.relatedSymbols,
      })));
      this.indexState?.upsertFiles([{ relPath, size: stat.size, mtime: stat.mtimeMs }]);
      return true;
    } catch {
      return false;
    }
  }

  private async deleteFile(absPath: string): Promise<boolean> {
    if (!this.db || !this.workspaceRoot) return false;
    const relPath = normalizeRelPath(path.relative(this.workspaceRoot, absPath));
    try {
      await this.db.deleteFiles([relPath]);
      this.indexState?.removeFiles([relPath]);
      return true;
    } catch {
      return false;
    }
  }

  // ─── Search ────────────────────────────────────────────────────────────

  async search(query: string, topK = 5): Promise<SearchResult[]> {
    if (!this.db) return [];
    return this.db.search(query, topK);
  }

  // ─── Status ────────────────────────────────────────────────────────────

  async getStatus(): Promise<StatusResult> {
    if (!this.db) {
      return { ready: false, fileCount: 0, chunkCount: 0, lastBuilt: null, indexing: this.indexing };
    }
    try {
      const { fileCount, chunkCount, lastBuilt } = await this.db.status();
      return { ready: chunkCount > 0, fileCount, chunkCount, lastBuilt, indexing: this.indexing };
    } catch {
      return { ready: false, fileCount: 0, chunkCount: 0, lastBuilt: null, indexing: this.indexing };
    }
  }

  // ─── Clear ─────────────────────────────────────────────────────────────

  async clear(): Promise<void> {
    if (!this.db) return;
    await this.db.clear();
  }
}
