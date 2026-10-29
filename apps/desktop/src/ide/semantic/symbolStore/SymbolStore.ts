/**
 * SymbolStore —— SQLite backed persistence for symbols / files / references.
 *
 * 设计目标
 * --------
 * 1. **同步 API**：better-sqlite3 是同步的，我们 *不* 假装异步 ——
 *    所有查询都是同步返回。这避免了 await 链路的 latency 累积。
 * 2. **预编译语句**：热路径查询全部用 prepare() 缓存，查询开销 <0.1ms。
 * 3. **事务化写入**：indexFile() 一次 parse 出的几十个符号必须在同一个事务
 *    里写入，失败则整体回滚。
 * 4. **无 ORM**：直接写 SQL。百行代码，没 abstraction tax。
 *
 * 并发模型
 * --------
 * - 本类是 *单线程* 使用的 —— 整个 SemanticService 在 Node 主进程或一个
 *   独立 Worker 内持有一个 SymbolStore 实例，不跨线程共享。
 * - 多个并发查询？不需要 —— JS 单线程天然就是串行。
 * - Parse worker 如何写入？Parser worker 把结果 postMessage 回主线程，
 *   主线程调 this.indexFile()，不是让 worker 直接持 sqlite 句柄。
 */

import type Database from 'better-sqlite3';
import type {
  FileInfo,
  ReferenceInfo,
  SymbolInfo,
  SymbolKind,
} from '../types.js';
import {
  CURRENT_SCHEMA_VERSION,
  INITIAL_SCHEMA_SQL,
  MIGRATIONS,
} from './schema.js';

/**
 * DB schema 与代码期望不一致的错误. 由 `ensureSchema` 在以下情况抛出:
 *   1. DB schema_version > CURRENT_SCHEMA_VERSION (用户降级 / 开发者本地回退)
 *   2. migration 链路断裂 (代码期望 v3 但只能从 v2 起步)
 *
 * 调用方 (SemanticBridge) 应当 catch 并走"删库重建"路径 —— 索引是纯缓存,
 * 丢了重建即可, 远好过悄悄用错误 schema 写入脏数据.
 */
export class SchemaMismatchError extends Error {
  constructor(
    public readonly dbVersion: number,
    public readonly codeVersion: number,
    public readonly kind: 'db-newer' | 'migration-gap',
    message?: string,
  ) {
    super(message ?? `Schema mismatch: db=v${dbVersion} code=v${codeVersion} kind=${kind}`);
    this.name = 'SchemaMismatchError';
  }
}

// ============================================================================
// 对 better-sqlite3 的类型约束，避免硬依赖 Database 类型（测试时可注入 mock）
// ============================================================================

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  transaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T;
  pragma(sql: string, options?: { simple: true }): unknown;
  close(): void;
}

export interface SqliteStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

// ============================================================================
// Row 类型 —— 对应 SQL 表的一行
// ============================================================================

interface FileRow {
  id: number;
  path: string;
  language: string;
  mtime: number;
  hash: string;
  indexed_at: number;
  symbol_count: number;
}

interface SymbolRow {
  id: number;
  file_id: number;
  name: string;
  kind: string;
  start_line: number;
  start_column: number;
  end_line: number;
  end_column: number;
  name_start_line: number | null;
  name_start_column: number | null;
  name_end_line: number | null;
  name_end_column: number | null;
  signature: string | null;
  documentation: string | null;
  parent_id: number | null;
  container_name: string | null;
  exported: number;
  modifiers: string | null;
  // 下面两列在 join 查询时才会有（file_path + language）
  file_path?: string;
  file_language?: string;
}

interface SymbolRefRow {
  id: number;
  symbol_id: number;
  file_id: number;
  line: number;
  column: number;
  preview: string | null;
  file_path?: string;
}

// ============================================================================
// 写入用的 "未持久化" 符号 —— 没有 id，有 file_id 或 file_path
// ============================================================================

export interface SymbolInput {
  name: string;
  kind: SymbolKind;
  range: { start: { line: number; column: number }; end: { line: number; column: number } };
  nameRange?: { start: { line: number; column: number }; end: { line: number; column: number } };
  signature?: string;
  documentation?: string;
  parentIndex?: number; // 在同一批写入的数组里的下标（用于建立父子关系）
  containerName?: string;
  exported?: boolean;
  modifiers?: string;
}

/** 一次 identifier 出现点 —— 用于 Find Usages */
export interface IdentifierUsageInput {
  name: string;
  line: number;
  column: number;
  endColumn: number;
  preview?: string;
  isDeclaration?: boolean;
}

/** 查询返回的使用点 */
export interface IdentifierUsage {
  id: number;
  filePath: string;
  name: string;
  line: number;
  column: number;
  endColumn: number;
  preview?: string;
  isDeclaration: boolean;
}

// ============================================================================
// SymbolStore
// ============================================================================

export class SymbolStore {
  private readonly db: SqliteDatabase;

  // 预编译语句缓存 —— 热路径查询全部走缓存
  private readonly stmts: {
    getFileByPath: SqliteStatement;
    insertFile: SqliteStatement;
    updateFile: SqliteStatement;
    deleteFileByPath: SqliteStatement;
    getAllFiles: SqliteStatement;
    insertSymbol: SqliteStatement;
    deleteSymbolsByFile: SqliteStatement;
    updateSymbolParent: SqliteStatement;
    getSymbolsByFile: SqliteStatement;
    getSymbolsByNamePrefix: SqliteStatement;
    getSymbolById: SqliteStatement;
    getSymbolAtPosition: SqliteStatement;
    countSymbols: SqliteStatement;
    insertRef: SqliteStatement;
    deleteRefsByFile: SqliteStatement;
    getRefsBySymbol: SqliteStatement;
    insertUsage: SqliteStatement;
    deleteUsagesByFile: SqliteStatement;
    findUsagesByName: SqliteStatement;
  };

  constructor(db: SqliteDatabase) {
    this.db = db;
    this.applyPragmas();
    this.ensureSchema();
    this.stmts = this.prepareStatements();
  }

  // --------------------------------------------------------------------------
  // 连接级 PRAGMA —— 必须在任何写入前设置
  // --------------------------------------------------------------------------
  // - journal_mode = WAL: 读写不互相阻塞, 索引大量文件时 bootstrap 不卡 hover
  // - synchronous = NORMAL: 放弃 fsync-every-commit, 崩溃最多丢最后一次事务
  //   (索引是纯缓存, 可接受)
  // - temp_store = MEMORY: 临时表放内存, 对 find-usages 的 sort 很关键
  // - cache_size = -16000: ~16MB 页缓存, 5 万文件级索引查询命中率显著提升
  // - mmap_size = 64MB: 大读取走 mmap, 减少 syscall
  //
  // 测试 stub 的 pragma() 是 no-op, 不影响单测.
  private applyPragmas(): void {
    try { this.db.pragma('journal_mode = WAL'); } catch { /* best-effort */ }
    try { this.db.pragma('synchronous = NORMAL'); } catch { /* best-effort */ }
    try { this.db.pragma('temp_store = MEMORY'); } catch { /* best-effort */ }
    try { this.db.pragma('cache_size = -16000'); } catch { /* best-effort */ }
    try { this.db.pragma('mmap_size = 67108864'); } catch { /* best-effort */ }
  }

  // --------------------------------------------------------------------------
  // Schema bootstrap
  // --------------------------------------------------------------------------

  private ensureSchema(): void {
    // 先跑一次初始 DDL —— 所有 CREATE 都是 IF NOT EXISTS，安全重入
    this.db.exec(INITIAL_SCHEMA_SQL);

    // 读当前 schema_version
    const row = this.db
      .prepare(`SELECT value FROM meta WHERE key = 'schema_version'`)
      .get() as { value: string } | undefined;

    const currentVersion = row ? parseInt(row.value, 10) : 0;

    if (currentVersion === 0) {
      // 全新 DB —— 写入当前版本号
      this.db
        .prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)`)
        .run(String(CURRENT_SCHEMA_VERSION));
      return;
    }

    // 防降级: DB 版本高于代码, 继续写入会破坏未来字段. 抛出让 bridge 重建.
    if (currentVersion > CURRENT_SCHEMA_VERSION) {
      throw new SchemaMismatchError(
        currentVersion,
        CURRENT_SCHEMA_VERSION,
        'db-newer',
        `SymbolStore DB v${currentVersion} is newer than code v${CURRENT_SCHEMA_VERSION}; refusing to open.`,
      );
    }

    if (currentVersion < CURRENT_SCHEMA_VERSION) {
      // 验证 migration 链路是否能从 currentVersion 一路连到 CURRENT_SCHEMA_VERSION.
      // 每一步必须有 from=X → to=X+1 的 migration (或跨多版本的 migration 覆盖该段).
      let reached = currentVersion;
      const progress = new Set<number>();
      progress.add(reached);
      let changed = true;
      while (reached < CURRENT_SCHEMA_VERSION && changed) {
        changed = false;
        for (const m of MIGRATIONS) {
          if (m.from <= reached && m.to > reached && m.to <= CURRENT_SCHEMA_VERSION) {
            reached = m.to;
            progress.add(reached);
            changed = true;
          }
        }
      }

      if (reached < CURRENT_SCHEMA_VERSION) {
        // 覆盖历史: 早期代码的 INITIAL_SCHEMA_SQL 是增量添加表 (IF NOT EXISTS
        // 总能补齐新表), 但新字段/索引就没法隐式补上. 容错策略:
        //   - 如果目标版本缺字段 → 抛 SchemaMismatchError, bridge 会 drop+重建
        //   - 否则 (只加新表) → 继续, 靠 INITIAL_SCHEMA_SQL 补
        // 这里我们只能保守假设 "有新字段", 除非 migration 显式声明.
        console.warn('[SymbolStore] migration gap detected', {
          dbVersion: currentVersion,
          codeVersion: CURRENT_SCHEMA_VERSION,
          reachable: reached,
        });
        throw new SchemaMismatchError(
          currentVersion,
          CURRENT_SCHEMA_VERSION,
          'migration-gap',
          `No migration path from v${currentVersion} to v${CURRENT_SCHEMA_VERSION}; rebuild required.`,
        );
      }

      // 跑 migrations (按 from 排序, 确保依赖顺序)
      const sortedMigrations = [...MIGRATIONS].sort((a, b) => a.from - b.from);
      for (const m of sortedMigrations) {
        if (m.from >= currentVersion && m.to <= CURRENT_SCHEMA_VERSION) {
          this.db.exec(m.sql);
        }
      }
      this.db
        .prepare(`UPDATE meta SET value = ? WHERE key = 'schema_version'`)
        .run(String(CURRENT_SCHEMA_VERSION));
    }
  }

  private prepareStatements(): SymbolStore['stmts'] {
    return {
      getFileByPath: this.db.prepare(`SELECT * FROM files WHERE path = ?`),
      insertFile: this.db.prepare(`
        INSERT INTO files (path, language, mtime, hash, indexed_at, symbol_count)
        VALUES (?, ?, ?, ?, ?, 0)
      `),
      updateFile: this.db.prepare(`
        UPDATE files
        SET language = ?, mtime = ?, hash = ?, indexed_at = ?, symbol_count = ?
        WHERE id = ?
      `),
      deleteFileByPath: this.db.prepare(`DELETE FROM files WHERE path = ?`),
      getAllFiles: this.db.prepare(`SELECT * FROM files`),

      insertSymbol: this.db.prepare(`
        INSERT INTO symbols (
          file_id, name, kind,
          start_line, start_column, end_line, end_column,
          name_start_line, name_start_column, name_end_line, name_end_column,
          signature, documentation, parent_id, container_name, exported, modifiers
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      deleteSymbolsByFile: this.db.prepare(`DELETE FROM symbols WHERE file_id = ?`),
      updateSymbolParent: this.db.prepare(`UPDATE symbols SET parent_id = ? WHERE id = ?`),

      getSymbolsByFile: this.db.prepare(`
        SELECT s.*, f.path AS file_path, f.language AS file_language
        FROM symbols s JOIN files f ON f.id = s.file_id
        WHERE s.file_id = ?
        ORDER BY s.start_line, s.start_column
      `),
      getSymbolsByNamePrefix: this.db.prepare(`
        SELECT s.*, f.path AS file_path, f.language AS file_language
        FROM symbols s JOIN files f ON f.id = s.file_id
        WHERE s.name LIKE ? COLLATE NOCASE
        ORDER BY s.exported DESC, length(s.name) ASC
        LIMIT ?
      `),
      getSymbolById: this.db.prepare(`
        SELECT s.*, f.path AS file_path, f.language AS file_language
        FROM symbols s JOIN files f ON f.id = s.file_id
        WHERE s.id = ?
      `),
      // Find the smallest symbol whose range contains (line, column). 同 IDEA
      // "goto containing symbol" / breadcrumbs 的后端. 假设 line/column 都
      // 0-based (Parser 与 SymbolInput 的约定).
      //
      // 覆盖判定:
      //   start <= (line, col) <= end
      // 展开为 SQL (避免 row-value compare 的兼容问题):
      //   (start_line < L) OR (start_line = L AND start_column <= C)
      //   AND
      //   (end_line > L)   OR (end_line = L   AND end_column >= C)
      //
      // 排序: 最小包围优先 —— (end_line-start_line) 再 (end_column-start_column).
      getSymbolAtPosition: this.db.prepare(`
        SELECT s.*, f.path AS file_path, f.language AS file_language
        FROM symbols s JOIN files f ON f.id = s.file_id
        WHERE f.path = ?
          AND (s.start_line < ? OR (s.start_line = ? AND s.start_column <= ?))
          AND (s.end_line > ?   OR (s.end_line   = ? AND s.end_column   >= ?))
        ORDER BY (s.end_line - s.start_line) ASC,
                 (s.end_column - s.start_column) ASC
        LIMIT 1
      `),
      countSymbols: this.db.prepare(`SELECT COUNT(*) AS c FROM symbols`),

      insertRef: this.db.prepare(`
        INSERT INTO symbol_refs (symbol_id, file_id, line, column, preview)
        VALUES (?, ?, ?, ?, ?)
      `),
      deleteRefsByFile: this.db.prepare(`DELETE FROM symbol_refs WHERE file_id = ?`),
      getRefsBySymbol: this.db.prepare(`
        SELECT r.*, f.path AS file_path
        FROM symbol_refs r JOIN files f ON f.id = r.file_id
        WHERE r.symbol_id = ?
        ORDER BY r.file_id, r.line
      `),

      insertUsage: this.db.prepare(`
        INSERT INTO identifier_usages (file_id, name, line, column, end_column, preview, is_declaration)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `),
      deleteUsagesByFile: this.db.prepare(`DELETE FROM identifier_usages WHERE file_id = ?`),
      findUsagesByName: this.db.prepare(`
        SELECT u.*, f.path AS file_path
        FROM identifier_usages u JOIN files f ON f.id = u.file_id
        WHERE u.name = ? COLLATE NOCASE
        ORDER BY u.file_id, u.line, u.column
        LIMIT ?
      `),
    };
  }

  // --------------------------------------------------------------------------
  // File operations
  // --------------------------------------------------------------------------

  /**
   * 查一个文件是否已经被索引过（用于增量跳过没变的文件）。
   * 返回 undefined 表示"没索引过"。
   */
  getFile(path: string): FileInfo | undefined {
    const row = this.stmts.getFileByPath.get(path) as FileRow | undefined;
    if (!row) return undefined;
    return rowToFileInfo(row);
  }

  getAllFiles(): FileInfo[] {
    return (this.stmts.getAllFiles.all() as FileRow[]).map(rowToFileInfo);
  }

  deleteFile(path: string): void {
    // CASCADE 会自动把 symbols / refs 也清掉
    this.stmts.deleteFileByPath.run(path);
  }

  /**
   * 写入 / 更新一个文件 + 它的所有符号 + 它的所有 identifier 使用点 —— 一次事务。
   *
   * @param path       文件路径（唯一键）
   * @param language   语言 id
   * @param mtime      文件 mtime
   * @param hash       文件内容 hash
   * @param symbols    parse 出来的符号数组；parentIndex 指向同数组内的下标
   * @param usages     （可选）所有 identifier 出现点，供 Find Usages 用
   * @returns          新的 fileId + 写入的符号 id 数组
   */
  indexFile(
    path: string,
    language: string,
    mtime: number,
    hash: string,
    symbols: SymbolInput[],
    usages: IdentifierUsageInput[] = [],
  ): { fileId: number; symbolIds: number[] } {
    const run = this.db.transaction((): { fileId: number; symbolIds: number[] } => {
      // 1. upsert files 记录
      const existing = this.stmts.getFileByPath.get(path) as FileRow | undefined;
      let fileId: number;
      const now = Date.now();
      if (existing) {
        fileId = existing.id;
        this.stmts.updateFile.run(language, mtime, hash, now, symbols.length, fileId);
        // 清掉旧的符号 + 引用 + usages，让新的覆盖上来
        this.stmts.deleteSymbolsByFile.run(fileId);
        this.stmts.deleteRefsByFile.run(fileId);
        this.stmts.deleteUsagesByFile.run(fileId);
      } else {
        const res = this.stmts.insertFile.run(path, language, mtime, hash, now);
        fileId = Number(res.lastInsertRowid);
      }

      // 2. 两遍写入符号：
      //    第一遍插入所有符号，记录 "数组下标 → 新 id" 的映射
      //    第二遍回填 parent_id（因为子可能先插入、父后插入，需要 id 拿到手才能 link）
      const symbolIds: number[] = new Array(symbols.length);
      for (let i = 0; i < symbols.length; i++) {
        const s = symbols[i];
        const res = this.stmts.insertSymbol.run(
          fileId,
          s.name,
          s.kind,
          s.range.start.line,
          s.range.start.column,
          s.range.end.line,
          s.range.end.column,
          s.nameRange?.start.line ?? null,
          s.nameRange?.start.column ?? null,
          s.nameRange?.end.line ?? null,
          s.nameRange?.end.column ?? null,
          s.signature ?? null,
          s.documentation ?? null,
          null, // parent_id 第二遍再填
          s.containerName ?? null,
          s.exported ? 1 : 0,
          s.modifiers ?? null,
        );
        symbolIds[i] = Number(res.lastInsertRowid);
      }

      for (let i = 0; i < symbols.length; i++) {
        const parentIdx = symbols[i].parentIndex;
        if (parentIdx !== undefined && parentIdx >= 0 && parentIdx < symbolIds.length) {
          this.stmts.updateSymbolParent.run(symbolIds[parentIdx], symbolIds[i]);
        }
      }

      // 3. 写入 identifier 使用点（Find Usages 的原料）
      for (const u of usages) {
        this.stmts.insertUsage.run(
          fileId,
          u.name,
          u.line,
          u.column,
          u.endColumn,
          u.preview ?? null,
          u.isDeclaration ? 1 : 0,
        );
      }

      // 4. 回写 file 的 symbol_count
      this.stmts.updateFile.run(language, mtime, hash, now, symbols.length, fileId);

      return { fileId, symbolIds };
    });

    return run();
  }

  /**
   * 按名字查 identifier 使用点。Find Usages 的后端。
   *
   * 注意：这不是"语义解析后的引用"—— 仅按字符串匹配。会有假阳性（比如
   * 不同文件里的同名变量），但在没有类型推断的情况下这是 IDEA 社区版
   * 一致的行为（Find Usages non-scoped mode）。
   *
   * @param includeDeclarations  是否包含声明位置本身（默认 false）
   */
  findUsagesByName(
    name: string,
    options?: { includeDeclarations?: boolean; limit?: number },
  ): IdentifierUsage[] {
    const limit = options?.limit ?? 5000;
    const rows = this.stmts.findUsagesByName.all(name, limit) as Array<{
      id: number;
      file_id: number;
      name: string;
      line: number;
      column: number;
      end_column: number;
      preview: string | null;
      is_declaration: number;
      file_path: string;
    }>;
    const includeDecl = options?.includeDeclarations ?? false;
    const results: IdentifierUsage[] = [];
    for (const r of rows) {
      if (!includeDecl && r.is_declaration === 1) continue;
      results.push({
        id: r.id,
        filePath: r.file_path,
        name: r.name,
        line: r.line,
        column: r.column,
        endColumn: r.end_column,
        preview: r.preview ?? undefined,
        isDeclaration: r.is_declaration === 1,
      });
    }
    return results;
  }

  // --------------------------------------------------------------------------
  // Symbol queries
  // --------------------------------------------------------------------------

  getSymbolsInFile(fileId: number): SymbolInfo[] {
    const rows = this.stmts.getSymbolsByFile.all(fileId) as SymbolRow[];
    return rows.map(rowToSymbolInfo);
  }

  /**
   * 模糊前缀搜索符号名。
   *
   * 这里用的是 SQL `LIKE 'prefix%'`，**不是**真正的 fuzzy 匹配 ——
   * 真正的 fzf 风格排序由 FuzzyMatcher 在内存里做二次精排。
   * 这里只负责"快速收集候选集"，候选量控制在 500 以内就交给 JS。
   */
  findSymbolsByNamePrefix(prefix: string, limit = 500): SymbolInfo[] {
    const likePattern = `${escapeLike(prefix)}%`;
    const rows = this.stmts.getSymbolsByNamePrefix.all(likePattern, limit) as SymbolRow[];
    return rows.map(rowToSymbolInfo);
  }

  getSymbolById(id: number): SymbolInfo | undefined {
    const row = this.stmts.getSymbolById.get(id) as SymbolRow | undefined;
    if (!row) return undefined;
    return rowToSymbolInfo(row);
  }

  /**
   * 按精确位置查找覆盖该位置的最小符号 —— IDEA "goto containing symbol" /
   * breadcrumbs / 精准 Hover 的后端.
   *
   * @param filePath 文件绝对路径 (必须是已索引文件)
   * @param line     0-based 行号
   * @param column   0-based 列号
   * @returns        覆盖 (line, column) 的最小符号; 未命中返回 undefined
   *
   * 典型用法:
   *   const containing = store.findSymbolAtPosition('/src/x.ts', 42, 10);
   *   // → 返回光标所在的 method / function / class
   */
  findSymbolAtPosition(
    filePath: string,
    line: number,
    column: number,
  ): SymbolInfo | undefined {
    const row = this.stmts.getSymbolAtPosition.get(
      filePath,
      line, line, column,    // start bound
      line, line, column,    // end bound
    ) as SymbolRow | undefined;
    if (!row) return undefined;
    return rowToSymbolInfo(row);
  }

  getSymbolCount(): number {
    const row = this.stmts.countSymbols.get() as { c: number };
    return row.c;
  }

  // --------------------------------------------------------------------------
  // Reference queries
  // --------------------------------------------------------------------------

  getReferences(symbolId: number): ReferenceInfo[] {
    const rows = this.stmts.getRefsBySymbol.all(symbolId) as SymbolRefRow[];
    return rows.map((r): ReferenceInfo => ({
      id: r.id,
      symbolId: r.symbol_id,
      filePath: r.file_path ?? '',
      range: {
        start: { line: r.line, column: r.column },
        end: { line: r.line, column: r.column },
      },
      preview: r.preview ?? undefined,
    }));
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  close(): void {
    this.db.close();
  }
}

// ============================================================================
// 辅助函数
// ============================================================================

function rowToFileInfo(row: FileRow): FileInfo {
  return {
    id: row.id,
    path: row.path,
    language: row.language,
    mtime: row.mtime,
    hash: row.hash,
    indexedAt: row.indexed_at,
    indexed: true,
    symbolCount: row.symbol_count,
  };
}

function rowToSymbolInfo(row: SymbolRow): SymbolInfo {
  const nameRange =
    row.name_start_line !== null &&
    row.name_start_column !== null &&
    row.name_end_line !== null &&
    row.name_end_column !== null
      ? {
          start: { line: row.name_start_line, column: row.name_start_column },
          end: { line: row.name_end_line, column: row.name_end_column },
        }
      : undefined;

  return {
    id: row.id,
    name: row.name,
    kind: row.kind as SymbolKind,
    filePath: row.file_path ?? '',
    range: {
      start: { line: row.start_line, column: row.start_column },
      end: { line: row.end_line, column: row.end_column },
    },
    nameRange,
    signature: row.signature ?? undefined,
    documentation: row.documentation ?? undefined,
    parentId: row.parent_id,
    containerName: row.container_name ?? undefined,
    exported: row.exported === 1,
    modifiers: row.modifiers ?? undefined,
  };
}

/** 转义 SQL LIKE 的特殊字符 % _ */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
