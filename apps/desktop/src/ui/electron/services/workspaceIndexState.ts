import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createRequire } from 'module';
import { languageFromPath } from '../../../ide/semantic/index.js';
import { getIndexingCpuPool } from './indexingCpuPool.js';
import type { WorkspaceAuditScanResult } from './indexingCpuTypes.js';
import { DISTRIBUTION } from '@neoxlabs/kernel/platform/distribution.js';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const DEFAULT_INDEX_VERSION = '2026-04-16-v1';
const AUDIT_LOCKS = new Map<string, Promise<WorkspaceAuditResult>>();

export type WorkspaceIndexTarget = 'semantic' | 'embedding';
export type WorkspaceDirtyKind = 'update' | 'delete';
export type WorkspaceStartupMode = 'full_scan' | 'delta' | 'clean';

export interface WorkspaceIndexedFile {
  relPath: string;
  size: number;
  mtime: number;
  language: string | null;
  lastSeenAt: number;
}

export interface WorkspaceDirtyEntry {
  relPath: string;
  kind: WorkspaceDirtyKind;
  updatedAt: number;
  source: string;
}

export interface WorkspaceStartupPlan {
  mode: WorkspaceStartupMode;
  reason: string;
  files: WorkspaceIndexedFile[];
  changedFiles: WorkspaceIndexedFile[];
  removedPaths: string[];
  needsAudit: boolean;
}

export interface WorkspaceAuditResult {
  scannedFiles: number;
  changedPaths: string[];
  removedPaths: string[];
}

interface SqliteStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  transaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T;
  close(): void;
}

interface IndexedFileRow {
  rel_path: string;
  size: number;
  mtime: number;
  language: string | null;
  last_seen_at: number;
}

interface DirtyRow {
  rel_path: string;
  kind: WorkspaceDirtyKind;
  updated_at: number;
  source: string;
}

interface GitDelta {
  changedPaths: string[];
  removedPaths: string[];
}

function getNeoxConfigDir(): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', DISTRIBUTION.appName);
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), DISTRIBUTION.appName);
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdgConfig, 'neox');
}

function workspaceHash(workspaceRoot: string): string {
  return createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 16);
}

function getWorkspaceIndexStateDbPath(workspaceRoot: string): string {
  const dir = path.join(getNeoxConfigDir(), 'index-state');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return path.join(dir, `${workspaceHash(workspaceRoot)}.db`);
}

function normalizeRelPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

async function tryCollectGitDelta(workspaceRoot: string): Promise<GitDelta | null> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      cwd: workspaceRoot,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    const changed = new Set<string>();
    const removed = new Set<string>();
    const entries = String(stdout).split('\0').filter(Boolean);
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry.length < 4) continue;
      const status = entry.slice(0, 2);
      const relPath = normalizeRelPath(entry.slice(3));
      const x = status.charAt(0);
      const y = status.charAt(1);
      const isRename = x === 'R' || y === 'R';
      if (x === 'D' || y === 'D') {
        removed.add(relPath);
        changed.delete(relPath);
      } else {
        changed.add(relPath);
      }
      if (isRename && index + 1 < entries.length) {
        const oldPath = normalizeRelPath(entries[index + 1]);
        removed.add(oldPath);
        changed.delete(oldPath);
        index += 1;
      }
    }
    return {
      changedPaths: [...changed],
      removedPaths: [...removed],
    };
  } catch {
    return null;
  }
}

export class WorkspaceIndexState {
  private readonly workspaceRoot: string;
  private readonly db: SqliteDatabase;
  private readonly stmts: {
    listFiles: SqliteStatement;
    upsertFile: SqliteStatement;
    deleteFile: SqliteStatement;
    deleteMissingFiles: SqliteStatement;
    listDirtySemantic: SqliteStatement;
    listDirtyEmbedding: SqliteStatement;
    upsertDirty: SqliteStatement;
    clearDirtySemantic: SqliteStatement;
    clearDirtyEmbedding: SqliteStatement;
    deleteSettledDirty: SqliteStatement;
    getMeta: SqliteStatement;
    upsertMeta: SqliteStatement;
  };

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    const Database = loadBetterSqlite();
    this.db = new Database(getWorkspaceIndexStateDbPath(workspaceRoot)) as SqliteDatabase;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspace_files (
        rel_path TEXT PRIMARY KEY,
        size INTEGER NOT NULL,
        mtime REAL NOT NULL,
        language TEXT,
        last_seen_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dirty_files (
        rel_path TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        source TEXT NOT NULL,
        semantic_pending INTEGER NOT NULL DEFAULT 1,
        embedding_pending INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_workspace_files_seen ON workspace_files(last_seen_at);
      CREATE INDEX IF NOT EXISTS idx_dirty_semantic ON dirty_files(semantic_pending, updated_at);
      CREATE INDEX IF NOT EXISTS idx_dirty_embedding ON dirty_files(embedding_pending, updated_at);
    `);
    this.stmts = {
      listFiles: this.db.prepare(`SELECT rel_path, size, mtime, language, last_seen_at FROM workspace_files ORDER BY rel_path ASC`),
      upsertFile: this.db.prepare(`
        INSERT INTO workspace_files (rel_path, size, mtime, language, last_seen_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(rel_path) DO UPDATE SET
          size = excluded.size,
          mtime = excluded.mtime,
          language = excluded.language,
          last_seen_at = excluded.last_seen_at
      `),
      deleteFile: this.db.prepare(`DELETE FROM workspace_files WHERE rel_path = ?`),
      deleteMissingFiles: this.db.prepare(`DELETE FROM workspace_files WHERE last_seen_at < ?`),
      listDirtySemantic: this.db.prepare(`
        SELECT rel_path, kind, updated_at, source
        FROM dirty_files
        WHERE semantic_pending = 1
        ORDER BY updated_at ASC
      `),
      listDirtyEmbedding: this.db.prepare(`
        SELECT rel_path, kind, updated_at, source
        FROM dirty_files
        WHERE embedding_pending = 1
        ORDER BY updated_at ASC
      `),
      upsertDirty: this.db.prepare(`
        INSERT INTO dirty_files (rel_path, kind, updated_at, source, semantic_pending, embedding_pending)
        VALUES (?, ?, ?, ?, 1, 1)
        ON CONFLICT(rel_path) DO UPDATE SET
          kind = excluded.kind,
          updated_at = excluded.updated_at,
          source = excluded.source,
          semantic_pending = 1,
          embedding_pending = 1
      `),
      clearDirtySemantic: this.db.prepare(`UPDATE dirty_files SET semantic_pending = 0 WHERE rel_path = ?`),
      clearDirtyEmbedding: this.db.prepare(`UPDATE dirty_files SET embedding_pending = 0 WHERE rel_path = ?`),
      deleteSettledDirty: this.db.prepare(`DELETE FROM dirty_files WHERE semantic_pending = 0 AND embedding_pending = 0`),
      getMeta: this.db.prepare(`SELECT value FROM meta WHERE key = ?`),
      upsertMeta: this.db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
    };
  }

  getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }

  close(): void {
    this.db.close();
  }

  listFiles(): WorkspaceIndexedFile[] {
    return (this.stmts.listFiles.all() as IndexedFileRow[]).map((row) => ({
      relPath: row.rel_path,
      size: Number(row.size),
      mtime: Number(row.mtime),
      language: row.language ?? null,
      lastSeenAt: Number(row.last_seen_at),
    }));
  }

  upsertFiles(files: Array<{ relPath: string; size: number; mtime: number; language?: string | null }>, seenAt = Date.now()): void {
    if (files.length === 0) return;
    const tx = this.db.transaction((entries: typeof files, snapshotSeenAt: number) => {
      for (const file of entries) {
        this.stmts.upsertFile.run(
          normalizeRelPath(file.relPath),
          file.size,
          file.mtime,
          file.language ?? languageFromPath(file.relPath) ?? null,
          snapshotSeenAt,
        );
      }
    });
    tx(files, seenAt);
  }

  replaceSnapshot(files: Array<{ relPath: string; size: number; mtime: number; language?: string | null }>, seenAt = Date.now()): void {
    const tx = this.db.transaction((entries: typeof files, snapshotSeenAt: number) => {
      for (const file of entries) {
        this.stmts.upsertFile.run(
          normalizeRelPath(file.relPath),
          file.size,
          file.mtime,
          file.language ?? languageFromPath(file.relPath) ?? null,
          snapshotSeenAt,
        );
      }
      this.stmts.deleteMissingFiles.run(snapshotSeenAt);
    });
    tx(files, seenAt);
  }

  removeFiles(relPaths: string[]): void {
    if (relPaths.length === 0) return;
    const tx = this.db.transaction((pathsToDelete: string[]) => {
      for (const relPath of pathsToDelete) {
        this.stmts.deleteFile.run(normalizeRelPath(relPath));
      }
    });
    tx(relPaths);
  }

  recordDirty(relPath: string, kind: WorkspaceDirtyKind, source = 'watch'): void {
    this.stmts.upsertDirty.run(normalizeRelPath(relPath), kind, Date.now(), source);
  }

  listDirtyEntries(target: WorkspaceIndexTarget): WorkspaceDirtyEntry[] {
    const stmt = target === 'semantic' ? this.stmts.listDirtySemantic : this.stmts.listDirtyEmbedding;
    return (stmt.all() as DirtyRow[]).map((row) => ({
      relPath: row.rel_path,
      kind: row.kind,
      updatedAt: Number(row.updated_at),
      source: row.source,
    }));
  }

  clearDirtyEntries(target: WorkspaceIndexTarget, relPaths: string[]): void {
    if (relPaths.length === 0) return;
    const clearStmt = target === 'semantic' ? this.stmts.clearDirtySemantic : this.stmts.clearDirtyEmbedding;
    const tx = this.db.transaction((pathsToClear: string[]) => {
      for (const relPath of pathsToClear) {
        clearStmt.run(normalizeRelPath(relPath));
      }
      this.stmts.deleteSettledDirty.run();
    });
    tx(relPaths);
  }

  getTargetVersion(target: WorkspaceIndexTarget): string | null {
    const row = this.stmts.getMeta.get(`${target}:version`) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setTargetVersion(target: WorkspaceIndexTarget, version: string): void {
    this.stmts.upsertMeta.run(`${target}:version`, version || DEFAULT_INDEX_VERSION);
  }

  async buildStartupPlan(target: WorkspaceIndexTarget, version: string): Promise<WorkspaceStartupPlan> {
    const files = this.listFiles();
    if (files.length === 0) {
      return { mode: 'full_scan', reason: 'missing-manifest', files: [], changedFiles: [], removedPaths: [], needsAudit: false };
    }
    if (this.getTargetVersion(target) !== version) {
      return { mode: 'full_scan', reason: 'version-mismatch', files, changedFiles: [], removedPaths: [], needsAudit: false };
    }
    const dirty = this.listDirtyEntries(target);
    if (dirty.length > 0) {
      return this.buildDeltaPlan(files, dirty, 'dirty-journal', true);
    }
    // 决策立即返回 clean + needsAudit=true,bootstrap 瞬间完成并恢复交互;
    // SemanticBridge/EmbeddingBridge 会在后台触发 runSharedWorkspaceAudit(worker 线程扫盘对比 mtime/size),
    // 发现真实变更后写 dirty 表,watch coordinator 随后做增量重索引。
    //
    // 代价:启动后 ~200-800ms 窗口内,索引查询结果对当天外部改动略微过期。
    // 换来:冷启动可交互时间从 500ms-2s 降到 <50ms。
    // (audit 的扫盘能力等价甚至强于 `git status`:不限 git 状态,纯 mtime+size 对比)
    return { mode: 'clean', reason: 'manifest-cached', files, changedFiles: [], removedPaths: [], needsAudit: true };
  }

  private async buildDeltaPlan(
    files: WorkspaceIndexedFile[],
    dirty: WorkspaceDirtyEntry[],
    reason: string,
    needsAudit: boolean,
  ): Promise<WorkspaceStartupPlan> {
    const changedPaths = dirty.filter((entry) => entry.kind !== 'delete').map((entry) => entry.relPath);
    const removedPaths = dirty.filter((entry) => entry.kind === 'delete').map((entry) => entry.relPath);
    return this.buildDeltaPlanFromPaths(files, changedPaths, removedPaths, reason, needsAudit);
  }

  private async buildDeltaPlanFromPaths(
    files: WorkspaceIndexedFile[],
    changedPaths: string[],
    removedPaths: string[],
    reason: string,
    needsAudit: boolean,
  ): Promise<WorkspaceStartupPlan> {
    const changedFiles: WorkspaceIndexedFile[] = [];
    const seen = new Set<string>();
    const removed = new Set<string>(removedPaths.map((entry) => normalizeRelPath(entry)));
    for (const relPath of changedPaths) {
      const normalized = normalizeRelPath(relPath);
      if (seen.has(normalized) || removed.has(normalized)) continue;
      seen.add(normalized);
      const absPath = path.join(this.workspaceRoot, normalized);
      try {
        const stat = await fs.promises.stat(absPath);
        changedFiles.push({
          relPath: normalized,
          size: stat.size,
          mtime: stat.mtimeMs,
          language: languageFromPath(normalized) ?? null,
          lastSeenAt: Date.now(),
        });
      } catch {
        removed.add(normalized);
      }
    }
    return {
      mode: changedFiles.length > 0 || removed.size > 0 ? 'delta' : 'clean',
      reason,
      files,
      changedFiles,
      removedPaths: [...removed],
      needsAudit,
    };
  }
}

export async function runSharedWorkspaceAudit(
  state: WorkspaceIndexState,
  options?: { ignore?: string[] },
): Promise<WorkspaceAuditResult> {
  const cacheKey = state.getWorkspaceRoot();
  const existing = AUDIT_LOCKS.get(cacheKey);
  if (existing) return existing;
  const promise = (async () => {
    const ignore = options?.ignore ?? [];
    const auditScan = await getIndexingCpuPool().run({
      kind: 'workspace-audit',
      payload: {
        workspaceRoot: state.getWorkspaceRoot(),
        ignore,
      },
    }) as WorkspaceAuditScanResult;
    const previous = new Map(state.listFiles().map((entry) => [entry.relPath, entry]));
    const snapshotSeenAt = Date.now();
    const snapshot = auditScan.files.map((entry) => ({
      relPath: normalizeRelPath(entry.relPath),
      size: entry.size,
      mtime: entry.mtime,
      language: languageFromPath(entry.relPath) ?? null,
    }));
    const changedPaths: string[] = [];
    for (const file of snapshot) {
      const existingFile = previous.get(file.relPath);
      if (!existingFile || existingFile.size !== file.size || existingFile.mtime !== file.mtime) {
        changedPaths.push(file.relPath);
      }
      previous.delete(file.relPath);
    }
    const removedPaths = [...previous.keys()];
    state.replaceSnapshot(snapshot, snapshotSeenAt);
    for (const relPath of changedPaths) {
      state.recordDirty(relPath, 'update', 'audit');
    }
    for (const relPath of removedPaths) {
      state.recordDirty(relPath, 'delete', 'audit');
    }
    return {
      scannedFiles: snapshot.length,
      changedPaths,
      removedPaths,
    };
  })();
  AUDIT_LOCKS.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    AUDIT_LOCKS.delete(cacheKey);
  }
}

let BetterSqlite: any;

function loadBetterSqlite(): any {
  if (!BetterSqlite) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    BetterSqlite = require('better-sqlite3');
  }
  return BetterSqlite.default ?? BetterSqlite;
}
