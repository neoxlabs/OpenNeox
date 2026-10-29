/**
 * SQLite schema for the Semantic Layer symbol store.
 *
 * 数据库文件位置（对齐 IDEA / VSCode）
 * ------------------------------------
 * 用户级缓存目录下的 `semantic/<sha256(workspace)>.db`：
 *   macOS:   ~/Library/Application Support/Neox/semantic/
 *   Windows: %APPDATA%/Neox/semantic/
 *   Linux:   ~/.config/neox/semantic/
 * 每个 workspace 独立一份（按绝对路径 hash），不污染项目目录。
 * 删了不影响代码，重建不慢。
 *
 * 表结构
 * ------
 * 1. meta         —— 单行元数据表（schema_version / last_bootstrap_at 等）
 * 2. files        —— 已索引的文件清单（path / mtime / hash / language）
 * 3. symbols      —— 所有符号（name / kind / range / parent / signature）
 * 4. symbol_refs  —— 符号引用点（反向边，Find Usages 用）
 *
 * 设计要点
 * --------
 * - 全部用整型主键 + 外键级联删除，减少 JS 侧 id 映射代码
 * - `name COLLATE NOCASE` 让符号搜索不区分大小写（和 IDEA 行为一致）
 * - indexes 覆盖所有常用查询路径：name 前缀、file 查 symbols、symbol 查 refs
 * - schema_version 预留版本化迁移能力，未来加字段不破坏现有 DB
 *
 * 迁移策略
 * --------
 * - 启动时读 meta.schema_version，跟 CURRENT_SCHEMA_VERSION 比对
 * - 版本不一致 → 跑 migrations 数组里对应的 SQL 脚本
 * - 本阶段只有 v1，未来加 v2/v3 时再加 migration 函数
 */

export const CURRENT_SCHEMA_VERSION = 2;

/**
 * v1 初始 schema —— 整个语义层地基。
 *
 * 写成单个字符串而不是数组，是因为 better-sqlite3 的 .exec() 可以一次吞多条 DDL。
 */
export const INITIAL_SCHEMA_SQL = `
-- ======================================================================
-- meta：单行 key=value 元数据表
-- ======================================================================
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ======================================================================
-- files：已被索引器看到的文件清单
-- ----------------------------------------------------------------------
-- 一行 = 一个源文件。symbols 表通过 file_id 外键引用。
-- ======================================================================
CREATE TABLE IF NOT EXISTS files (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  path         TEXT NOT NULL UNIQUE,
  language     TEXT NOT NULL,
  mtime        INTEGER NOT NULL,
  hash         TEXT NOT NULL,
  indexed_at   INTEGER NOT NULL,
  symbol_count INTEGER NOT NULL DEFAULT 0
);

-- 按路径查找（编辑器打开文件时"这个文件索引了没"的热点查询）
CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);

-- ======================================================================
-- symbols：所有被抽取出来的符号
-- ----------------------------------------------------------------------
-- 一行 = 一个符号。删除文件时通过外键级联把它的符号也一起删掉。
-- ======================================================================
CREATE TABLE IF NOT EXISTS symbols (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id         INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name            TEXT NOT NULL COLLATE NOCASE,
  kind            TEXT NOT NULL,
  -- range（整个定义体）
  start_line      INTEGER NOT NULL,
  start_column    INTEGER NOT NULL,
  end_line        INTEGER NOT NULL,
  end_column      INTEGER NOT NULL,
  -- name range（仅名字本身）
  name_start_line   INTEGER,
  name_start_column INTEGER,
  name_end_line     INTEGER,
  name_end_column   INTEGER,
  -- 辅助信息
  signature       TEXT,
  documentation   TEXT,
  parent_id       INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
  container_name  TEXT,
  exported        INTEGER NOT NULL DEFAULT 0, -- 0/1 —— SQLite 没 boolean
  modifiers       TEXT
);

-- 按名字前缀搜（Cmd+T 符号搜索的热点查询）
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);

-- 按文件快速拉全部符号（文件 outline、删除文件 cascade、重新 parse 时先 purge）
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);

-- 按 kind 过滤（只搜类 / 只搜函数 的高级搜索）
CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);

-- ======================================================================
-- symbol_refs：引用点（反向边），Find Usages 专用
-- ----------------------------------------------------------------------
-- 一行 = 一个 "这里用了某个符号" 的位置。
-- 刚启动阶段先占位，tree-sitter 只抽定义；等 Phase 3 再抽引用。
-- ======================================================================
CREATE TABLE IF NOT EXISTS symbol_refs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol_id  INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  file_id    INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  line       INTEGER NOT NULL,
  column     INTEGER NOT NULL,
  preview    TEXT
);

CREATE INDEX IF NOT EXISTS idx_refs_symbol ON symbol_refs(symbol_id);
CREATE INDEX IF NOT EXISTS idx_refs_file   ON symbol_refs(file_id);

-- ======================================================================
-- identifier_usages：所有 identifier 出现点（按名字索引）
-- ----------------------------------------------------------------------
-- 这是 Find Usages 的原料表。跟 symbol_refs 的区别：
--   - symbol_refs 需要 "这个使用点指向哪个符号" 的解析（难，跨文件，需要 LSP
--     级别的类型推断）
--   - identifier_usages 只记录 "在这个位置出现了一个叫 foo 的 identifier"，
--     没有解析。Find Usages 按名字查询即可，粒度跟 IDEA 的 "Find Usages"
--     (non-scoped) 一致
--
-- 包含定义位置吗？
--   - is_declaration = 1 → 同时出现在 symbols 表里
--   - is_declaration = 0 → 纯使用点
-- ======================================================================
CREATE TABLE IF NOT EXISTS identifier_usages (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id        INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name           TEXT NOT NULL COLLATE NOCASE,
  line           INTEGER NOT NULL,
  column         INTEGER NOT NULL,
  end_column     INTEGER NOT NULL,
  preview        TEXT,
  is_declaration INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_usages_name ON identifier_usages(name);
CREATE INDEX IF NOT EXISTS idx_usages_file ON identifier_usages(file_id);

-- ======================================================================
-- 索引完成后打开外键 + WAL 模式（WAL 让读写并发性能显著提升）
-- ======================================================================
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
`;

/**
 * 版本化 migrations。
 * 未来 CURRENT_SCHEMA_VERSION 升到 2 时，在这里追加 { from: 1, to: 2, sql: ... }。
 */
export interface SchemaMigration {
  from: number;
  to: number;
  sql: string;
}

export const MIGRATIONS: SchemaMigration[] = [
  // v1 → v2: 新增 identifier_usages 表和相关索引. INITIAL_SCHEMA_SQL 已包含
  // 这些 DDL, ensureSchema 会先跑一次补齐, 这里的 migration SQL 作显式声明,
  // 让 "migration 链路完整性" 检查 (ensureSchema 里) 能通过 v1→v2 跳段.
  {
    from: 1,
    to: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS identifier_usages (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id        INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        name           TEXT NOT NULL COLLATE NOCASE,
        line           INTEGER NOT NULL,
        column         INTEGER NOT NULL,
        end_column     INTEGER NOT NULL,
        preview        TEXT,
        is_declaration INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_usages_name ON identifier_usages(name);
      CREATE INDEX IF NOT EXISTS idx_usages_file ON identifier_usages(file_id);
    `,
  },
];
