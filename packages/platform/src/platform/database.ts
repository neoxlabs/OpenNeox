
// 类型导入（编译期擦除，不加载 .node binary）
import type Database from 'better-sqlite3';
import type { ContextTokenBreakdown } from '@neoxlabs/kernel/utils/contextBreakdown.js';
import type { SessionCacheUsage } from '../shared/ipc/context.js';
import { AGENT_SCHEMA_SQL, SCHEMA_V3_SQL } from '../runtime/store/schema.js';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { neoxHome } from '@neoxlabs/kernel/platform/neoxHome.js';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import * as _dbCipher from './dbCipher.js';
import * as _auditLog from './auditLog.js';
import { getCurrentUserId } from '../utils/config.js';
import { withLocalUsageScope } from './databaseLocalUsage.js';
import {
  orderAttachKeys,
  peekLooksLikePlaintextSqliteFile,
  runPerUserDbToGlobalMigrate,
  sqlcipherAttachKeyClause,
} from './databasePerUserMigrate.js';
// 懒加载 better-sqlite3
const _require = createRequire(import.meta.url);
let _DatabaseClass: (new (path: string, options?: Database.Options) => Database.Database) | null = null;

const _isBun = typeof process !== 'undefined' && !!(process.versions as Record<string, string | undefined>)?.bun;

/* 把 bun:sqlite 的 Database 包成 better-sqlite3 兼容形态: 加 .pragma() (bun 没这方法),
 * 吃掉 better-sqlite3 专用的 nativeBinding 选项, 映射 readonly/fileMustExist。
 * prepare/run/get/all/exec/transaction/close + 位置参数(?) 两者本就一致 (bun:sqlite 照 better-sqlite3 设计)。 */
function makeBunSqliteClass(): unknown {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const BunDatabase: any = (_require('bun:sqlite') as any).Database;
    return class NeoxBunDatabase extends BunDatabase {
        constructor(filename: string, options?: any) {
            const o: any = {};
            if (options?.readonly) {
                o.readonly = true;                             // 只读
            } else {
                o.readwrite = true;                            // 非只读必须显式 readwrite
                o.create = true;                               // 默认建库 (对齐 better-sqlite3)
            }
            if (options?.fileMustExist) o.create = false;      // 不建新库 (覆盖上面的 create:true)
            // nativeBinding: better-sqlite3 专用 → bun 不需要, 忽略
            super(filename, o);
        }
        /* better-sqlite3 的 db.pragma('journal_mode = WAL') → bun:sqlite 没这方法。
         * 设置型 (含 =) 走 exec; 读取型走 query.all() 返回 (database.ts 只用设置型, 但都覆盖以防万一)。 */
        static readonly ALLOWED_PRAGMAS = new Set([
            'journal_mode', 'wal_checkpoint', 'wal_autocheckpoint', 'busy_timeout',
            'synchronous', 'foreign_keys', 'cache_size', 'mmap_size', 'page_size',
            'table_info', 'integrity_check', 'quick_check', 'user_version', 'temp_store',
            'journal_size_limit',
        ]);
        pragma(source: string): unknown {
            const s = String(source).trim();
            const pragmaName = s.split(/[\s=(]/)[0].replace(/^(src|main)\./, '').toLowerCase();
            if (!(this.constructor as any).ALLOWED_PRAGMAS.has(pragmaName)) {
                throw new Error(`Disallowed PRAGMA: ${pragmaName}`);
            }
            if (s.includes('=')) { (this as any).exec(`PRAGMA ${s}`); return undefined; }
            try { return (this as any).query(`PRAGMA ${s}`).all(); }
            catch { try { (this as any).exec(`PRAGMA ${s}`); } catch { /* ignore */ } return undefined; }
        }
        exec(sql: string): any {
            const stripped = String(sql ?? '').replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
            if (!stripped) return undefined;
            /* super.exec(sql) 保留 this 绑定 (bun:sqlite exec 需 this=db 实例).
             * 不能写 (super.exec)(sql) — 那样取出方法引用当普通函数调, this 丢失 → exec 静默失败. */
            return super.exec(sql);
        }
    };
    /* eslint-enable @typescript-eslint/no-explicit-any */
}

// CLI 时如果 node_modules 的 .node 是 Electron ABI，用 dist/native/ 的备份
// 通过 better-sqlite3 的 nativeBinding 选项指定，不覆盖任何文件。
//
// 历史 bug: 只查 neox-core/dist/native/, 但 rebuild-native.cjs 把备份写到
// neox-cli/dist/native/ → 路径对不上, 备份永远找不到, CLI 回落到 node_modules 的
// Electron-ABI .node 直接崩 (用户报 "NODE_MODULE_VERSION 143 vs 127")。
// 现在两个候选路径都查, 谁有用谁。
let _cliNativeBindingPlain: string | undefined;
let _cliNativeBindingCipher: string | undefined;
if (!process.versions.electron && !_isBun) {
    const findFirst = (filename: string): string | undefined => {
        const candidates = [
            fileURLToPath(new URL(`../../../core/dist/native/${filename}`, import.meta.url)),
            fileURLToPath(new URL(`../../../../packages/core/dist/native/${filename}`, import.meta.url)),
            fileURLToPath(new URL(`../../dist/native/${filename}`, import.meta.url)),
            fileURLToPath(new URL(`../../../apps/cli/dist/native/${filename}`, import.meta.url)),
        ];
        for (const p of candidates) {
            try { if (fs.existsSync(p)) return p; } catch { /* skip */ }
        }
        return undefined;
    };
    _cliNativeBindingPlain = findFirst('better_sqlite3.node');
    _cliNativeBindingCipher = findFirst('better_sqlite3_cipher.node');
}

function getDatabaseClass() {
    /* 不缓存 — env NEOX_DB_ENCRYPT 可能动态变 (测试 / 同进程先无后有). _require 本身 cache 模块,
     * 这里只是按当前 env 选哪一个返回, 开销忽略不计. */
    if (_isBun) {
        if (!_DatabaseClass) _DatabaseClass = makeBunSqliteClass() as typeof _DatabaseClass;
        return _DatabaseClass!;
    }
    /* P4 step 2: 启用加密时强制 multi-cipher (含 sqlcipher); 否则 better-sqlite3 (兼容 _cliNativeBinding). */
    let Klass: any = null;
    try {
        if (process.env.NEOX_DB_ENCRYPT !== '0') {
            Klass = _require('better-sqlite3-multiple-ciphers');
        }
    } catch { /* 没装 → fallback */ }
    if (!Klass) { Klass = _require('better-sqlite3'); }
    return Klass as typeof _DatabaseClass;
}

/** 当前 sqlite 实现是否带 sqlcipher (multiple-ciphers 包) — 决定能否真加密. */
function hasSqlcipherSupport(): boolean {
    if (_isBun) return false;
    try { _require('better-sqlite3-multiple-ciphers'); return true; } catch { return false; }
}

function effectiveNativeBinding(): string | undefined {
    if (process.env.NEOX_DB_ENCRYPT !== '0') {
        return _cliNativeBindingCipher;
    }
    return _cliNativeBindingPlain;
}

/** 打开一个独立的附属 sqlite 库 (knowledge FTS 索引等) — 复用 bun:sqlite / better-sqlite3 /
 *  Electron-ABI backup 的全套驱动适配, 但与主库完全无关: 不加密、不走主 schema,
 *  调用方自管 schema 与生命周期。 */
export function openAuxiliaryDatabase(filePath: string): Database.Database {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const DB: any = getDatabaseClass();
    const nb = effectiveNativeBinding();
    const db = nb ? new DB(filePath, { nativeBinding: nb }) : new DB(filePath);
    try { db.pragma('journal_mode = WAL'); } catch { /* 某些包装不支持 — 非致命 */ }
    return db as Database.Database;
}

/**
 * 只读打开一个已存在的 SQLite —— neox-monitor 等旁路工具用, 绝不改库 (readonly, 不建表不改 pragma)。
 * 复用主库同一套 native binding 解析 (双 ABI 安全)。加密库会用当前 machine-id 派生 key 解锁;
 * readonly 不 rekey, 密钥不匹配时保留原始失败状态。
 * 文件不存在 / 解不开 (key 不对) 会抛 (加密库无 key 时报 "file is not a database")。
 */
export function openReadonlyDatabase(filePath: string): Database.Database {
    const DB: any = getDatabaseClass();
    const nb = effectiveNativeBinding();
    const mkOpts = () => {
        const o: any = { readonly: true, fileMustExist: true };
        if (nb) o.nativeBinding = nb;
        return o;
    };
    let db = new DB(filePath, mkOpts());

    // 加密库: 只读也要先解锁, 否则 sqlcipher 把密文头读成 "file is not a database"。
    try {
        const { isDbEncryptionEnabled, getMasterKeyHex, getLegacyMachineIdKeyHex } = _dbCipher;
        if (isDbEncryptionEnabled() && hasSqlcipherSupport()) {
            const hex = getMasterKeyHex();
            if (hex) {
                const unlock = (h: string): boolean => {
                    try {
                        db.pragma(`key = "x'${h}'"`);
                        db.prepare('SELECT name FROM sqlite_master LIMIT 1').get();
                        return true;
                    } catch { return false; }
                };
                if (!unlock(hex)) {
                    // 当前 key 解不开 → 可能是 legacy machine-id key 加密的旧库。readonly 不能 rekey,
                    // 关掉重开再试 legacy key (PRAGMA key 一个连接只能设一次)。
                    const legacyHex = getLegacyMachineIdKeyHex();
                    if (legacyHex && legacyHex !== hex) {
                        try { db.close(); } catch { /* ignore */ }
                        db = new DB(filePath, mkOpts());
                        unlock(legacyHex);
                    }
                }
            }
        }
    } catch { /* dbCipher 不可用 → 当明文库 (下游 query 若失败自会报错) */ }

    return db as Database.Database;
}

/** 把指定路径上的明文 SQLite 文件迁成加密版本.
 *   multiple-ciphers 不暴露 sqlcipher_export(), VACUUM INTO 也不支持 KEY 子句,
 *   只能走 ATTACH + 手动复制 schema (CREATE TABLE/INDEX/VIEW/TRIGGER) + INSERT...SELECT 数据.
 *
 *   流程:
 *     1) 开明文 db, 先 wal_checkpoint(TRUNCATE) 确保所有 frame 进主 db
 *     2) ATTACH tmp.enc.db AS enc KEY 'x<hex>'  → 创建空加密 db
 *     3) 遍历 sqlite_master, 把每个对象的 CREATE 语句改成 CREATE ... enc.<name> ... 执行
 *     4) 每张表 INSERT INTO enc.<t> SELECT * FROM <t>
 *     5) DETACH + close, 把原明文 db 改名 .plaintext-backup, tmp.enc.db 改名为原路径
 *     6) 清旧 WAL/SHM
 *   抛错 = tmp 未替换原文件 (回滚干净).
 */
function encryptPlaintextDb(plaintextPath: string, keyHex: string): void {
    const tmpPath = `${plaintextPath}.encrypting.${Date.now()}`;
    try { fs.unlinkSync(tmpPath); } catch { /* 不存在最好 */ }
    const Klass = _require('better-sqlite3-multiple-ciphers');
    const nb = _cliNativeBindingCipher;
    let plain: any;
    try {
        plain = nb ? new Klass(plaintextPath, { nativeBinding: nb }) : new Klass(plaintextPath);
        try { plain.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* WAL 没就跳 */ }
        try { plain.pragma('foreign_keys = OFF'); } catch { /* 老绑定不支持就算了 */ }

        plain.exec(`ATTACH DATABASE '${tmpPath.replace(/'/g, "''")}' AS enc KEY "x'${keyHex}'"`);

        /* 复制 schema — 必须按 master 表 rowid 顺序 (表→索引→触发器→视图依赖关系正确) */
        const objs = plain.prepare(
            "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY rowid"
        ).all() as Array<{ type: string; name: string; sql: string }>;
        for (const o of objs) {
            /* 把 CREATE TABLE foo / CREATE UNIQUE INDEX foo / CREATE TRIGGER foo 等
             * 改成 CREATE ... enc.foo, 用 word boundary 防误伤同名子字符串. */
            const re = new RegExp(`(CREATE\\s+(?:UNIQUE\\s+)?(?:TEMP\\s+)?\\w+\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?)("?)${o.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}("?)`, 'i');
            const sql = o.sql.replace(re, `$1$2enc.${o.name}$3`);
            try { plain.exec(sql); }
            catch (e: any) { throw new Error(`migrate schema ${o.type} ${o.name} failed: ${e?.message ?? e}`); }
        }

        /* 复制每张表的数据 */
        const tables = plain.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        ).all() as Array<{ name: string }>;
        for (const t of tables) {
            plain.exec(`INSERT INTO enc.${t.name} SELECT * FROM ${t.name}`);
        }
        plain.exec(`DETACH DATABASE enc`);
    } catch (err) {
        /* 失败就把半成品删掉 —— 不然每次启动留一份 (上面那 150 个就是这么来的) */
        try { plain?.close(); } catch { /* ignore */ }
        plain = null;
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        throw err;
    } finally {
        try { plain?.close(); } catch { /* ignore */ }
    }

    /* 替换原文件 — 先把旧明文存 .plaintext-backup.<ts> (人工确认后可删) */
    const backup = `${plaintextPath}.plaintext-backup.${Date.now()}`;
    fs.renameSync(plaintextPath, backup);
    fs.renameSync(tmpPath, plaintextPath);
    /* 清旧 WAL/SHM (新加密 db 自己会创建) */
    for (const suffix of ['-wal', '-shm']) {
        try { fs.unlinkSync(backup + suffix); } catch { /* 没就跳 */ }
    }
    cliLogger.info('DATABASE', `plaintext backup kept at ${backup} (人工确认无误后可删)`);
}

/**
 * 清掉迁移留下的半成品 `<db>.encrypting.<ts>` (纯函数, 有单测)。
 * 退出时清理是优化, 启动时清扫才是保证 —— 迁移进程被杀 / 抛错都会留下这种文件, 只有启动时扫一遍
 * 才能把历史欠账收干净。只删够旧的 (默认 1 小时), 免得删到另一个正在迁移的进程的临时文件。
 * `.plaintext-backup.*` 是用户数据的备份, **不碰**。
 */
export function sweepStaleEncryptingTemps(dbPath: string, now = Date.now(), olderThanMs = 60 * 60_000): string[] {
    const dir = path.dirname(dbPath);
    const base = path.basename(dbPath);
    const removed: string[] = [];
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { return removed; }
    for (const name of names) {
        const m = name.startsWith(`${base}.encrypting.`) ? /\.encrypting\.(\d+)$/.exec(name) : null;
        if (!m) continue;
        const ts = Number(m[1]);
        if (!Number.isFinite(ts) || now - ts < olderThanMs) continue;
        try { fs.unlinkSync(path.join(dir, name)); removed.push(name); } catch { /* 删不掉下次再来 */ }
    }
    return removed;
}

// ==================== 配置 ====================

function getConfigDir(): string {
    /* 极简版有**自己的一整套用户目录** (~/.neox-lite) —— 这是"同机共存"的前提:
     * 两个版本的库、配置、会话必须互不可见, 否则装了极简版就会去动标准版的数据。
     *
     * 这里之前漏了这一层, 于是极简版的库落在了 Application Support/Neox ——
     * 也就是标准版的目录里。表现还特别隐蔽: ui-state 那族 handler 把
     * "file is not a database" catch 成 { success: false }, 界面上一点征兆都没有,
     * 只是所有 UI 状态都存不住 (侧栏、右栏、当前 tab 全部每次重来)。 */
    if (String(process.env.NEOX_EDITION || '').trim().toLowerCase() === 'lite') {
        return neoxHome();
    }
    const profile = (process.env.NEOX_PROFILE || '').toLowerCase();
    const isElectronDev = !!(process as any).versions?.electron
        && process.env.NODE_ENV === 'development'
        && profile !== 'prod';
    const appName = isElectronDev ? 'Neox Dev' : 'Neox';
    const platform = process.platform;
    if (platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Application Support', appName);
    } else if (platform === 'win32') {
        return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), appName);
    }
    const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    return path.join(xdgConfig, isElectronDev ? 'neox-dev' : 'neox');
}

const CONFIG_DIR = getConfigDir();
const GLOBAL_DB_PATH = path.join(CONFIG_DIR, 'neox.db');
/* 老代码别处仍在引用 ANONYMOUS_DB_PATH 变量名, 保留别名 */
const ANONYMOUS_DB_PATH = GLOBAL_DB_PATH;

/* userId 进路径前的清洗 — 保留给 migratePerUserDbToGlobal 扫 per-user 桶名字. */
function sanitizeUserIdForPath(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return cleaned || 'unknown';
}

function getActiveDbPath(): string {
  const override = process.env.NEOX_DB_PATH?.trim();
  if (override) return override;
  const isElectron = !!(process as any).versions?.electron;
  return isElectron ? GLOBAL_DB_PATH : path.join(CONFIG_DIR, 'neox-cli.db');
}

export function migratePerUserDbToGlobal(): { picked: string | null; sessions: number; dbFiles: number; failedDbFiles: number } {
  return runPerUserDbToGlobalMigrate({
    configDir: CONFIG_DIR,
    globalDbPath: GLOBAL_DB_PATH,
    closeDatabase,
    openGlobal: () => new NeoxDatabase(GLOBAL_DB_PATH),
    attachSource: attachSourceDatabase,
    mergeAttached: mergeAttachedSourceDatabase,
  });
}

export { migrateLiteHomeToStandard } from './liteHomeMerge.js';

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function quoteIdent(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`Invalid SQL identifier: ${value}`);
  }
  return `"${value}"`;
}

function getDbKeyCandidates(): Array<string | null> {
  const keys: Array<string | null> = [];
  try {
    const { isDbEncryptionEnabled, getMasterKeyHex, getLegacyMachineIdKeyHex } = _dbCipher;
    if (isDbEncryptionEnabled() && hasSqlcipherSupport()) {
      const current = getMasterKeyHex();
      const legacy = getLegacyMachineIdKeyHex();
      if (current) keys.push(current);
      if (legacy && legacy !== current) keys.push(legacy);
    }
  } catch { /* plaintext path */ }
  keys.push(null);
  return keys;
}

function attachSourceDatabase(dst: Database.Database, sourcePath: string): void {
  const looksPlain = peekLooksLikePlaintextSqliteFile(sourcePath);
  const cipherHex = getDbKeyCandidates().filter((k): k is string => typeof k === 'string' && k.length > 0);
  let lastErr: unknown = null;
  for (const key of orderAttachKeys(looksPlain, cipherHex)) {
    try {
      dst.exec(`ATTACH DATABASE ${sqlString(sourcePath)} AS src${sqlcipherAttachKeyClause(key)}`);
      dst.prepare("SELECT name FROM src.sqlite_master WHERE type='table' LIMIT 1").get();
      return;
    } catch (err) {
      lastErr = err;
      try { dst.exec('DETACH DATABASE src'); } catch { /* ignore */ }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? 'attach failed'));
}

function tableExists(db: Database.Database, schema: 'main' | 'src', table: string): boolean {
  return !!db.prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE type='table' AND name=?`).get(table);
}

type TableColumnInfo = { name: string; type?: string; pk?: number };

function tableColumns(db: Database.Database, schema: 'main' | 'src', table: string): TableColumnInfo[] {
  return db.prepare(`PRAGMA ${schema}.table_info(${quoteIdent(table)})`).all() as TableColumnInfo[];
}

function insertColumnsForMerge(dstCols: TableColumnInfo[], srcCols: TableColumnInfo[]): string[] {
  const dstByName = new Map(dstCols.map(c => [c.name, c]));
  return srcCols
    .filter(c => dstByName.has(c.name))
    .map(c => c.name)
    .filter(name => {
      const dstCol = dstByName.get(name);
      const isIntegerPk = name === 'id' && Number(dstCol?.pk ?? 0) > 0 && /int/i.test(String(dstCol?.type ?? ''));
      return !isIntegerPk;
    });
}

function copyTableFromAttachedSource(db: Database.Database, table: string): void {
  if (!tableExists(db, 'src', table) || !tableExists(db, 'main', table)) return;
  const srcCols = tableColumns(db, 'src', table);
  const dstCols = tableColumns(db, 'main', table);
  const common = insertColumnsForMerge(dstCols, srcCols);
  if (common.length === 0) return;
  const cols = common.map(quoteIdent).join(', ');
  const tableIdent = quoteIdent(table);
  const omittedIntegerId = srcCols.some(c => c.name === 'id')
    && dstCols.some(c => c.name === 'id' && Number(c.pk ?? 0) > 0 && /int/i.test(String(c.type ?? '')))
    && !common.includes('id');

  if (!omittedIntegerId) {
    db.exec(`INSERT OR IGNORE INTO main.${tableIdent} (${cols}) SELECT ${cols} FROM src.${tableIdent}`);
    return;
  }

  const selectCols = common.map(col => `s.${quoteIdent(col)}`).join(', ');
  const duplicatePredicate = common
    .map(col => {
      const q = quoteIdent(col);
      return `(m.${q} = s.${q} OR (m.${q} IS NULL AND s.${q} IS NULL))`;
    })
    .join(' AND ');
  db.exec(`
    INSERT INTO main.${tableIdent} (${cols})
    SELECT ${selectCols}
      FROM src.${tableIdent} AS s
     WHERE NOT EXISTS (
       SELECT 1 FROM main.${tableIdent} AS m
        WHERE ${duplicatePredicate}
     )
  `);
}

function updateNewerSessionsFromAttachedSource(db: Database.Database): void {
  if (!tableExists(db, 'src', 'sessions') || !tableExists(db, 'main', 'sessions')) return;
  const srcCols = tableColumns(db, 'src', 'sessions');
  const dstCols = tableColumns(db, 'main', 'sessions');
  const common = insertColumnsForMerge(dstCols, srcCols).filter(c => c !== 'id');
  if (!common.includes('updated_at')) return;
  const assignments = common
    .map(col => `${quoteIdent(col)} = (SELECT s.${quoteIdent(col)} FROM src.sessions s WHERE s.id = main.sessions.id)`)
    .join(', ');
  if (!assignments) return;
  db.exec(`
    UPDATE main.sessions
       SET ${assignments}
     WHERE EXISTS (
       SELECT 1 FROM src.sessions s
        WHERE s.id = main.sessions.id
          AND COALESCE(s.updated_at, 0) > COALESCE(main.sessions.updated_at, 0)
     )
  `);
}

function mergeAttachedSourceDatabase(db: Database.Database): number {
  if (!tableExists(db, 'src', 'sessions')) return 0;
  if (!tableExists(db, 'main', 'sessions')) return 0;

  const before = db.prepare('SELECT COUNT(1) AS c FROM main.sessions').get() as { c?: number } | undefined;
  const preferredOrder = [
    'sessions',
    'messages',
    'timeline_entries',
    'token_usage',
    'agents',
    'teams',
    'tasks',
    'agent_progress',
    'agent_messages',
    'agent_snapshots',
    'team_board_entries',
    'steward_commitments',
    'steward_missions',
    'steward_schedulers',
    'steward_world_state',
    'team_sessions',
    'actionlog_memories',
    'actionlog_graph_nodes',
    'actionlog_graph_edges',
    'actionlog_session_summaries',
    'actionlog_events',
    'session_items',
    'interrupted_runs',
    'background_processes',
    'pending_ask_user',
    'service_instances',
  ];
  const skip = new Set(['_schema_version', 'app_state', 'sqlite_sequence', 'conversation_ledger']);
  const srcTables = (db.prepare("SELECT name FROM src.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>)
    .map(r => r.name)
    .filter(name => !skip.has(name));
  const ordered = [
    ...preferredOrder.filter(name => srcTables.includes(name)),
    ...srcTables.filter(name => !preferredOrder.includes(name)),
  ];

  const tx = db.transaction(() => {
    for (const table of ordered) {
      copyTableFromAttachedSource(db, table);
      if (table === 'sessions') updateNewerSessionsFromAttachedSource(db);
    }
  });
  tx();

  const after = db.prepare('SELECT COUNT(1) AS c FROM main.sessions').get() as { c?: number } | undefined;
  return Math.max(0, Number(after?.c ?? 0) - Number(before?.c ?? 0));
}

// ==================== Schema ====================

// 注意: safeAddColumn 批次只在 migrate() 内跑, 而 migrate() 只在 currentVersion < SCHEMA_VERSION 时调 —
//   所以给存量库加列, 除了写 safeAddColumn 还【必须】bump 这个版本号, 否则已在最新版的库跳过整段迁移。
const SCHEMA_VERSION = 11;


export interface DbQuarantineProbe {
    /** _schema_version 表读到的版本; 读不出 (表缺/损坏) 为 null */
    storedSchemaVersion: number | null;
    /** sessions 表是否有行 — 有 = 库里有用户数据, 绝不隔离 */
    hasUserData: boolean;
    userDataUnknown: boolean;
}

/** 空壳 SQLite 库的体量上限 — 只有头页 + 少量 schema 页。超过它说明盘上真有内容。 */
const EMPTY_DB_MAX_BYTES = 8 * 1024;

export type DbInitFailureAction = 'quarantine' | 'version-skew' | 'throw';

export function decideDbInitFailureAction(
    errorMessage: string,
    probe: DbQuarantineProbe,
    codeSchemaVersion: number,
): DbInitFailureAction {
    const msg = errorMessage || '';
    const isTrueCorruption = /corrupt|malformed|not a database|disk image is malformed/i.test(msg);
    const isSchemaIssue = /no such table|no such column|database schema has changed/i.test(msg);

    /* 探针读不出结论 = 可能满库数据 (最常见: 加密库 key 没解开) — 一律拒绝启动, 不碰文件。
     * 放在所有分支之前: 连 SELECT 都跑不了时, hasUserData / storedSchemaVersion 全无意义。 */
    if (probe.userDataUnknown) return 'throw';

    if (isTrueCorruption) {
        /* 真损坏且确实读不出数据 → 隔离重建; 但探针还能读出用户数据 (报错来自局部页损坏)
         * → 拒绝启动, 留给用户/工具做恢复, 不整库隔离。 */
        return probe.hasUserData ? 'throw' : 'quarantine';
    }
    if (isSchemaIssue) {
        if (probe.storedSchemaVersion !== null && probe.storedSchemaVersion > codeSchemaVersion) {
            /* 库比本进程新 = 版本偏差 (老桌面开新库) — 提示升级, 数据文件不动 */
            return 'version-skew';
        }
        if (probe.hasUserData) return 'throw';
        return 'quarantine';
    }
    return 'throw';
}

const SCHEMA_SQL = `
-- WAL 模式 + 性能优化
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA cache_size = -8000;
PRAGMA temp_store = MEMORY;

-- Schema 版本管理
CREATE TABLE IF NOT EXISTS _schema_version (
  version INTEGER NOT NULL
);

-- ==================== Sessions ====================
CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  model_id          TEXT NOT NULL,
  workspace_path    TEXT NOT NULL DEFAULT '',
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  total_tokens      INTEGER NOT NULL DEFAULT 0,
  context_used      INTEGER NOT NULL DEFAULT 0,
  context_window    INTEGER,
  file_rollback_checkpoint_id TEXT,
  file_reapply_checkpoint_id  TEXT,
  file_reverted_map  TEXT DEFAULT '{}',
  file_confirmed_map TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_path);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);

-- ==================== Messages (替代 JSONL timeline) ====================
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  item_type   TEXT NOT NULL,
  item_data   TEXT NOT NULL,
  timestamp   INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, seq);
-- 按 item_type 定位最新一行 (SessionContext 找最新 compaction_snapshot 的热查询, 2026-08-13).
-- 没有它就要沿 (session_id, seq) 倒序逐行回表判 item_type, 一直扫到命中为止。
CREATE INDEX IF NOT EXISTS idx_messages_session_type_seq ON messages(session_id, item_type, seq DESC);

-- ==================== Timeline Entries (UI 持久化) ====================
CREATE TABLE IF NOT EXISTS timeline_entries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  entry_data  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_timeline_session ON timeline_entries(session_id);

-- ==================== Image Turns (图片会话直连出图产物, 2026-07-15) ====================
-- 直连图片模式的每次出图 (prompt + 结果图路径 + 参数) 持久化到这里, 按 session_id 分组.
-- 不占 LLM 上下文 (不进 messages/timeline), 但重启/切会话能恢复. session_id 不强制外键 —
-- 过渡期 'image-studio' 固定 id 无 session 行, 且图产物可先于/独立于 session 存在.
CREATE TABLE IF NOT EXISTS image_turns (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  turn_id     TEXT NOT NULL,
  payload     TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_image_turns_session_turn ON image_turns(session_id, turn_id);
CREATE INDEX IF NOT EXISTS idx_image_turns_session ON image_turns(session_id);

-- 素材库/项目: 项目=通用容器, image_asset_project 把生成图路径归属到项目.
CREATE TABLE IF NOT EXISTS image_projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  cover_path  TEXT,
  created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS image_asset_project (
  asset_path  TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_image_asset_project_pid ON image_asset_project(project_id);

-- ==================== Token Usage ====================
CREATE TABLE IF NOT EXISTS token_usage (
  id              TEXT PRIMARY KEY,
  timestamp       INTEGER NOT NULL,
  provider        TEXT NOT NULL,
  model           TEXT NOT NULL,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  billable_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  total_tokens    INTEGER NOT NULL DEFAULT 0,
  cached_tokens   INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0,
  cache_write_tokens INTEGER DEFAULT 0,
  openai_cached   INTEGER DEFAULT 0,
  anthropic_cache_read    INTEGER DEFAULT 0,
  anthropic_cache_create  INTEGER DEFAULT 0,
  anthropic_cache_5m      INTEGER DEFAULT 0,
  anthropic_cache_1h      INTEGER DEFAULT 0,
  duration        INTEGER NOT NULL DEFAULT 0,
  -- 2026-07-10 感知延迟指标: 首个可见输出延迟 (回合起点→首 token, ms) / 生成窗口时长
  -- (首 token→末 token, ms; 含回合内工具间隙, tokens/s 的分母). duration 是整轮含工具循环.
  first_token_ms  INTEGER,
  generation_ms   INTEGER,
  success         INTEGER NOT NULL DEFAULT 1,
  error           TEXT,
  session_id      TEXT,
  request_type    TEXT DEFAULT 'chat'
);

CREATE INDEX IF NOT EXISTS idx_token_usage_time ON token_usage(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_token_usage_provider ON token_usage(provider);

-- ==================== Agent 吞吐埋点 (2026-07-16) ====================
-- 一 turn 一行: 用户可 SQL 聚合 action_yield / failed_edit_rate / duplicate_read / ttfa 的走势.
CREATE TABLE IF NOT EXISTS agent_turn_metrics (
  id                     TEXT PRIMARY KEY,
  timestamp              INTEGER NOT NULL,     -- turn 结束时刻 (ms)
  session_id             TEXT,
  turn_index             INTEGER,              -- 该 session 内第几轮
  provider               TEXT,
  model                  TEXT,
  inferences             INTEGER NOT NULL DEFAULT 0,   -- 本轮 LLM 调用次数
  tool_calls             INTEGER NOT NULL DEFAULT 0,   -- 本轮工具调用总数
  action_yield           REAL,                          -- tool_calls / inferences
  tool_failures          INTEGER NOT NULL DEFAULT 0,
  command_failures       INTEGER NOT NULL DEFAULT 0,    -- shell 命令退出码非0 (测试/构建/lint 挂)
  turn_error             TEXT,                          -- turn 级失败归因 (provider/timeout/... LLM 调用失败)
  edit_calls             INTEGER NOT NULL DEFAULT 0,
  edit_failures          INTEGER NOT NULL DEFAULT 0,
  failed_edit_rate       REAL,                          -- edit_failures / edit_calls
  duplicate_read_count   INTEGER NOT NULL DEFAULT 0,    -- readfile 命中账本 (省下的重复读)
  duplicate_search_count INTEGER NOT NULL DEFAULT 0,
  ttfa_ms                INTEGER,                        -- time-to-first-action (回合起点→首 token/工具)
  duration_ms            INTEGER,                        -- 整轮墙钟 (含工具循环)
  gap_ms                 INTEGER,                        -- 死空档: 既没跑工具也没推理的时间 (稳定性)
  max_gap_ms             INTEGER,                        -- 单个最长空档 (一次卡顿/挂起时长)
  input_tokens           INTEGER,
  output_tokens          INTEGER,
  cache_read_tokens      INTEGER,
  waste_json             TEXT                            -- loopWasteStats 原始 blob
);
CREATE INDEX IF NOT EXISTS idx_atm_time ON agent_turn_metrics(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_atm_session ON agent_turn_metrics(session_id);

-- 一工具调用一行: 落库版 tool-trace, 可 SQL 聚合 (哪个工具最慢/最常失败/最多重复).
CREATE TABLE IF NOT EXISTS agent_tool_metrics (
  id            TEXT PRIMARY KEY,
  timestamp     INTEGER NOT NULL,
  session_id    TEXT,
  turn_index    INTEGER,
  tool_name     TEXT NOT NULL,
  success       INTEGER NOT NULL DEFAULT 1,
  duration_ms   INTEGER,
  is_duplicate  INTEGER NOT NULL DEFAULT 0,    -- read/search 去重命中
  error_kind    TEXT,                          -- string_not_found / ambiguous_match / ...
  failure_class TEXT,                          -- 失败归因: bad_args/not_found/stale/blocked/timeout/provider/harness
  args_hash     TEXT
);
CREATE INDEX IF NOT EXISTS idx_atoolm_time ON agent_tool_metrics(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_atoolm_session ON agent_tool_metrics(session_id);
CREATE INDEX IF NOT EXISTS idx_atoolm_tool ON agent_tool_metrics(tool_name);

-- ==================== App State (KV store) ====================
CREATE TABLE IF NOT EXISTS app_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// 最大 token_usage 记录数
const MAX_TOKEN_USAGE_RECORDS = 2000;
const TOKEN_USAGE_BACKFILL_KEY = 'migration:token_usage_backfill_v1';

type SchemaVersionRow = { version?: number };

type SessionRow = {
    id: string;
    name: string;
    model_id: string;
    workspace_path: string;
    created_at: number;
    updated_at: number;
    total_tokens: number;
    context_used: number;
    context_window: number | null;
    context_breakdown?: string | null;
    latest_request_usage?: string | null;
    session_usage?: string | null;
    file_rollback_checkpoint_id?: string | null;
    file_reapply_checkpoint_id?: string | null;
    file_reverted_map?: string | null;
    file_confirmed_map?: string | null;
    parent_session_id?: string | null;
};

type MessageRow = {
    seq: number;
    item_type: string;
    item_data: string;
    timestamp: number;
};

type TimelineEntryRow = { entry_data: string };
type CountRow = { count?: number; c?: number; max_seq?: number; seq?: number };
type AppStateRow = { value: string };

type TokenUsageSummaryRow = {
    total_requests?: number;
    total_tokens?: number;
    total_input_tokens?: number;
    total_billable_input_tokens?: number;
    total_output_tokens?: number;
    total_cached_tokens?: number;
    total_cache_read_tokens?: number;
    total_cache_write_tokens?: number;
    total_openai_cached?: number;
    total_anthropic_cache_read?: number;
    total_anthropic_cache_create?: number;
    provider_count?: number;
    last_request_time?: number;
};

type TokenUsageModelRow = {
    model: string;
    requests: number;
    input_tokens: number;
    billable_input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cached_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
};

type SessionTokenUsageSummaryRow = {
    requests?: number;
    input_tokens?: number;
    billable_input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
};

/** team_sessions 行 (Team P2 team_run 落盘) — memberIds 序列化进 member_ids TEXT 列 */
export interface TeamSessionRecord {
    teamId: string;
    workspacePath: string;
    sessionId: string;
    goal: string;
    mode?: string | null;
    status: string;
    leaderId?: string | null;
    memberIds: string[];
    /** 黑板整板 JSON (TeamBlackboard.serialize 产物) */
    blackboard?: string | null;
    /** 泳道图快照 JSON (lanes + milestones + lane 终态) */
    missionGraph?: string | null;
    createdAt?: number;
    updatedAt?: number;
}

// ==================== Database Class ====================

export class NeoxDatabase {
    private db: Database.Database;
    private stmtCache = new Map<string, Database.Statement>();
    // 缓存各表已有列，避免每次启动重复执行 ALTER TABLE
    private _tableColumns = new Map<string, Set<string>>();
    /** timeline 行级 upsert 是否可用 — 唯一索引 (session_id, entry_id) 建立成功才 true */
    private timelineUpsertReady = false;
    private walCheckpointTimer: ReturnType<typeof setInterval> | null = null;
    private static readonly WAL_CHECKPOINT_INTERVAL_MS = 5 * 60_000;

    constructor(dbPath?: string) {
        const finalPath = dbPath || getActiveDbPath();

        // 确保目录存在
        const dir = path.dirname(finalPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        }

        try {
            const { isDbEncryptionEnabled, getMasterKeyHex } = _dbCipher;
            if (isDbEncryptionEnabled() && hasSqlcipherSupport()) {
                const hex = getMasterKeyHex();
                try {
                    const swept = sweepStaleEncryptingTemps(finalPath);
                    if (swept.length) cliLogger.info('DATABASE', `swept ${swept.length} stale .encrypting temp file(s)`);
                } catch { /* 扫不动不影响启动 */ }
                if (hex && fs.existsSync(finalPath)) {
                    /* 探测当前 db 是否已加密: 临时开一个不带 key 的 connection, 试读 sqlite_master.
                     * 能读 = 明文 → 触发迁移. 不能读 = 已加密 (或损坏, 让 corruption 路径处理). */
                    let dbIsPlaintext = false;
                    try {
                        const DB0: any = getDatabaseClass();
                        const nb = effectiveNativeBinding();
                        const probe: any = nb
                            ? new DB0(finalPath, { nativeBinding: nb, readonly: true })
                            : new DB0(finalPath, { readonly: true });
                        try { probe.prepare("SELECT name FROM sqlite_master LIMIT 1").get(); dbIsPlaintext = true; }
                        catch { /* 不能裸读 = 已加密, OK */ }
                        try { probe.close(); } catch { /* ignore */ }
                    } catch { /* probe 起不来无所谓, 进 normal 流程 */ }

                    if (dbIsPlaintext) {
                        cliLogger.info('DATABASE', `plaintext db detected, encrypting in-place at ${finalPath}`);
                        try {
                            encryptPlaintextDb(finalPath, hex);
                            cliLogger.info('DATABASE', 'encryption migration succeeded');
                        } catch (err: any) {
                            this.openAsPlaintext = true;
                            cliLogger.error('DATABASE', `encryption migration FAILED, opening as plaintext this time: ${err?.message ?? err}`);
                        }
                    }
                }
            }
        } catch (err: any) {
            /* dbCipher 不可用 → 跳过 (cliLogger 静默, 防 cold start 时 logger 没准备好) */
            try { cliLogger.warn('DATABASE', `migration block error: ${err?.message ?? err}`); } catch { /* logger 没起 */ }
        }

        // 打开数据库
        // CLI 传 nativeBinding 指向 dist/native/ 的 Node ABI 版本
        // Electron 走默认路径（node_modules 里 electron:rebuild 编译的）
        // 启用加密时 effectiveNativeBinding() 返 undefined → 走 multi-cipher 自带 .node
        const DB: any = getDatabaseClass();
        const nb = effectiveNativeBinding();
        this.db = nb
            ? new DB(finalPath, { nativeBinding: nb })
            : new DB(finalPath);

        if (process.platform !== 'win32') {
            for (const p of [finalPath, `${finalPath}-wal`, `${finalPath}-shm`]) {
                try {
                    if (fs.existsSync(p)) {
                        const st = fs.statSync(p);
                        if ((st.mode & 0o777) !== 0o600) fs.chmodSync(p, 0o600);
                    }
                } catch { /* 权限不对不阻塞启动, 但会留在 open, 上层 audit 会 warn. */ }
            }
        }

        // 初始化 schema
        try { this.db.pragma('busy_timeout = 8000'); } catch { /* 老 binding 不支持则跳过 */ }
        try {
            this.initSchema();
        } catch (firstErr: any) {
            const firstMsg = firstErr?.message ?? '';
            if (/database is locked|attempt to write a readonly database/i.test(firstMsg)) {
                let lastErr: any = firstErr;
                let recovered = false;
                for (let attempt = 1; attempt <= 3 && !recovered; attempt++) {
                    const waitMs = attempt * 1000;
                    const until = Date.now() + waitMs;
                    while (Date.now() < until) { /* 同步等待 — ctor 内无 async, busy 场景 1-3s 内多能拿到锁 */ }
                    try {
                        this.initSchema();
                        recovered = true;
                        cliLogger.info('DATABASE', `initSchema succeeded after lock retry #${attempt}`);
                    } catch (retryErr: any) {
                        lastErr = retryErr;
                        if (!/database is locked|attempt to write a readonly database/i.test(retryErr?.message ?? '')) break;
                    }
                }
                if (!recovered) {
                    cliLogger.error('DATABASE', `db locked/readonly after retries — NOT quarantining (healthy data): ${lastErr?.message ?? lastErr}`);
                    throw lastErr;
                }
                this.startWalCheckpointTimer();
                return;
            }
            const initErr = firstErr;
            const msg = firstMsg;
            const probe = this.probeDbForQuarantineDecision(finalPath);
            const action = decideDbInitFailureAction(msg, probe, SCHEMA_VERSION);
            if (action === 'version-skew') {
                try { this.db.close(); } catch { /* best-effort */ }
                throw new Error(
                    `数据库 schema 版本 (${probe.storedSchemaVersion}) 比本进程 (${SCHEMA_VERSION}) 新 — ` +
                    `这个数据库由更新版本的 Neox 创建。请升级当前端 (CLI/桌面) 后再启动, 数据文件未做任何改动。原始错误: ${msg.slice(0, 120)}`,
                );
            }
            if (action === 'throw') {
                cliLogger.error('DATABASE', `init failed but db contains user data — NOT quarantining: ${msg.slice(0, 120)}`);
                try { this.db.close(); } catch { /* best-effort */ }
                throw initErr;
            }
            /* action === 'quarantine' */
            {
                const ts = Date.now();
                const quarantinedPath = `${finalPath}.broken.${ts}`;
                cliLogger.warn('DATABASE', `SQLite init failed (${msg.slice(0, 80)}). Quarantining → ${quarantinedPath}, rebuilding fresh db.`);
                try { this.db.close(); } catch { /* best-effort */ }
                try { fs.renameSync(finalPath, quarantinedPath); } catch { /* best-effort */ }
                for (const suffix of ['-wal', '-shm']) {
                    try { if (fs.existsSync(finalPath + suffix)) fs.renameSync(finalPath + suffix, quarantinedPath + suffix); } catch { /* best-effort */ }
                }
                const DB: any = getDatabaseClass();
                const nb2 = effectiveNativeBinding();
                this.db = nb2
                    ? new DB(finalPath, { nativeBinding: nb2 } as any)
                    : new DB(finalPath);
                try { this.db.pragma('busy_timeout = 8000'); } catch { /* noop */ }
                try {
                    this.initSchema();
                    cliLogger.info('DATABASE', `db rebuilt from scratch, old kept at ${quarantinedPath}`);
                } catch (retryErr: any) {
                    cliLogger.error('DATABASE', `db re-init failed after quarantine: ${retryErr?.message ?? retryErr}`);
                    throw retryErr;
                }
            }
        }
        this.startWalCheckpointTimer();
    }

    /** 见 walCheckpointTimer 字段注释。unref 保证短命 CLI 进程不被定时器拖住不退出。 */
    private startWalCheckpointTimer(): void {
        if (this.walCheckpointTimer) return;
        this.walCheckpointTimer = setInterval(() => {
            try {
                this.db.pragma('wal_checkpoint(TRUNCATE)');
            } catch { /* busy (reader 持锁) 属正常, 下个周期再试; 不能因维护任务打日志刷屏 */ }
        }, NeoxDatabase.WAL_CHECKPOINT_INTERVAL_MS);
        this.walCheckpointTimer.unref?.();
    }

    /** 隔离决策探针 — init 失败后读 schema 版本 + 是否存在用户数据。
     *  探针自身失败 (真损坏时读不出) → 返回 unknown, 由决策函数按损坏处理。 */
    private probeDbForQuarantineDecision(dbPath?: string): DbQuarantineProbe {
        const probe: DbQuarantineProbe = { storedSchemaVersion: null, hasUserData: false, userDataUnknown: false };
        try {
            const row = this.db.prepare('SELECT version FROM _schema_version LIMIT 1').get() as { version?: number } | undefined;
            if (row && typeof row.version === 'number') probe.storedSchemaVersion = row.version;
        } catch { /* 表不存在/损坏 → null */ }
        try {
            const row = this.db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n?: number } | undefined;
            probe.hasUserData = (row?.n ?? 0) > 0;
        } catch (err: any) {
            /* 区分两种"读不到":
             *   (a) sessions 表不存在 (no such table) → 确认过, 空壳库, hasUserData=false 成立;
             *   (b) 一条 SELECT 都跑不了 (not a database / file is encrypted / 加密 key 没解开)
             *       → 什么都没确认, 库里可能是满的。绝不能当成 false。 */
            const m = String(err?.message ?? err);
            const unreadable = /not a database|file is encrypted|disk image is malformed|corrupt/i.test(m);
            if (unreadable) probe.userDataUnknown = true;
        }
        /* 二次保险 — 库文件在盘上明显有内容, 而探针一个 schema 版本都没读出来:
         * 同样按"可能有数据"处理。空壳库只有一个头页 (<= 8KB)。 */
        if (!probe.hasUserData && !probe.userDataUnknown && probe.storedSchemaVersion === null && dbPath) {
            try {
                if (fs.statSync(dbPath).size > EMPTY_DB_MAX_BYTES) probe.userDataUnknown = true;
            } catch { /* 文件读不到 → 维持原判 */ }
        }
        return probe;
    }

    /** 明文迁移失败时置位: 这一次按明文打开, 别套 key (见 ctor 的 migration block) */
    private openAsPlaintext = false;

    private initSchema(): void {
        /* sqlcipher 加密.
         *   - 用 machine-id 派生的 master key 试 open.
         *   - 探针 SELECT 通过即认证成功.
         *   - 明文 db → ctor 的 migration block 已处理, 这里 SELECT 抛走 catch (静默, 不重复迁移).
         *   - 密钥不匹配时不尝试 Keychain、不 rekey, 交给下面的数据库保护逻辑拒绝启动。 */
        try {
            const { isDbEncryptionEnabled, getMasterKeyHex } = _dbCipher;
            if (isDbEncryptionEnabled() && hasSqlcipherSupport() && !this.openAsPlaintext) {
                const hex = getMasterKeyHex();
                if (hex) {
                    try {
                        this.db.pragma(`key = "x'${hex}'"`);
                        this.db.prepare("SELECT name FROM sqlite_master LIMIT 1").get();
                        cliLogger.info('DATABASE', 'opened with current master key');
                    } catch { /* key 不匹配时保留错误, 由 initSchema 外层保护逻辑处理 */ }
                } else {
                    cliLogger.warn('DATABASE', 'encryption ON but machine-id master key is not derivable');
                }
            }
        } catch { /* dbCipher 不可用 → 明文路径 */ }

        // 设置 PRAGMA（必须在 schema 创建前）
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');
        this.db.pragma('foreign_keys = ON');
        this.db.pragma('cache_size = -8000'); // 8MB cache
        this.db.pragma('temp_store = MEMORY');
        /* server (daemon port 4399) 和 desktop (Electron main) 是两个独立进程都开同一个 DB
         * 文件, WAL 允许多读单写, 但两边并发写仍会互锁. 设 busy_timeout 让锁竞争自动重试 5s,
         * 不直接抛 "SqliteError: database is locked". */
        this.db.pragma('busy_timeout = 5000');
        this.db.pragma('wal_autocheckpoint = 1000');
        this.db.pragma('journal_size_limit = 67108864'); // 64MB hard cap, 防 WAL 失控涨到 GB

        /* G2: 启动 integrity check — 一次性 PRAGMA integrity_check.
         * 检测物理/逻辑 db 损坏, 也能识别"用 wrong key 解了但读得到表结构"那种半坏状态.
         * 失败不 throw — 写 audit log + cliLogger.error, 让用户跑诊断. */
        try {
            const { appendEntry } = _auditLog;
            void appendEntry('db.opened', { ok: true });
        } catch { /* ignore */ }
        this.scheduleIntegrityCheck();

        // 检查是否需要初始化
        const hasSchemaTable = this.db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='_schema_version'"
        ).get();

        if (!hasSchemaTable) {
            // 首次初始化：创建所有表
            this.db.exec(`
        CREATE TABLE IF NOT EXISTS _schema_version (version INTEGER NOT NULL);
        INSERT INTO _schema_version (version) VALUES (${SCHEMA_VERSION});
      `);
            // 创建其余表
            this.db.exec(SCHEMA_SQL.split('PRAGMA')[0]); // 跳过 PRAGMA 行（已单独设置）
            // 直接执行建表语句
            this.createTables();
            this.createAgentTables();
            this.createV3Tables();
            this.createV5Tables();
            this.createV6Tables();
        } else {
            const row = this.db.prepare('SELECT version FROM _schema_version LIMIT 1').get() as SchemaVersionRow | undefined;
            const currentVersion = row?.version || 0;
            if (currentVersion < SCHEMA_VERSION) {
                this.migrate(currentVersion, SCHEMA_VERSION);
            } else if (currentVersion > SCHEMA_VERSION) {
                throw new Error(
                    `Neox DB schema 版本 ${currentVersion} 比当前 Neox 二进制 (期望 ${SCHEMA_VERSION}) 高. ` +
                    `这通常是因为你之前装过更新版本的 Neox. 请升级到最新 Neox, 或备份 ~/.neox/neox.db ` +
                    `后删除它重新开始 (历史会话会丢, 但配置/凭据不影响).`,
                );
            }
        }

        this.migrateConversationLedgerToMessages();

        this.safeAddColumn('sessions', 'context_breakdown', 'TEXT');
        this.safeAddColumn('sessions', 'latest_request_usage', 'TEXT');
        this.safeAddColumn('sessions', 'session_usage', 'TEXT');
        this.safeAddColumn('sessions', 'approval_mode', 'TEXT');
        this.safeAddColumn('sessions', 'parent_session_id', 'TEXT');
        this.safeAddColumn('sessions', 'agent_mode', 'TEXT');
        this.db.exec("UPDATE sessions SET agent_mode = 'work' WHERE agent_mode = 'assistant'");
        this.safeAddColumn('sessions', 'kind', "TEXT DEFAULT 'chat'");
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS image_turns (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  TEXT NOT NULL,
        turn_id     TEXT NOT NULL,
        payload     TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_image_turns_session_turn ON image_turns(session_id, turn_id);
      CREATE INDEX IF NOT EXISTS idx_image_turns_session ON image_turns(session_id);
    `);
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS image_projects (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        cover_path  TEXT,
        created_at  INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS image_asset_project (
        asset_path  TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_image_asset_project_pid ON image_asset_project(project_id);
    `);
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_turn_metrics (
        id                     TEXT PRIMARY KEY,
        timestamp              INTEGER NOT NULL,
        session_id             TEXT,
        turn_index             INTEGER,
        provider               TEXT,
        model                  TEXT,
        inferences             INTEGER NOT NULL DEFAULT 0,
        tool_calls             INTEGER NOT NULL DEFAULT 0,
        action_yield           REAL,
        tool_failures          INTEGER NOT NULL DEFAULT 0,
        command_failures       INTEGER NOT NULL DEFAULT 0,
        turn_error             TEXT,
        edit_calls             INTEGER NOT NULL DEFAULT 0,
        edit_failures          INTEGER NOT NULL DEFAULT 0,
        failed_edit_rate       REAL,
        duplicate_read_count   INTEGER NOT NULL DEFAULT 0,
        duplicate_search_count INTEGER NOT NULL DEFAULT 0,
        ttfa_ms                INTEGER,
        duration_ms            INTEGER,
        gap_ms                 INTEGER,
        max_gap_ms             INTEGER,
        input_tokens           INTEGER,
        output_tokens          INTEGER,
        cache_read_tokens      INTEGER,
        waste_json             TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_atm_time ON agent_turn_metrics(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_atm_session ON agent_turn_metrics(session_id);
      CREATE TABLE IF NOT EXISTS agent_tool_metrics (
        id            TEXT PRIMARY KEY,
        timestamp     INTEGER NOT NULL,
        session_id    TEXT,
        turn_index    INTEGER,
        tool_name     TEXT NOT NULL,
        success       INTEGER NOT NULL DEFAULT 1,
        duration_ms   INTEGER,
        is_duplicate  INTEGER NOT NULL DEFAULT 0,
        error_kind    TEXT,
        failure_class TEXT,
        args_hash     TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_atoolm_time ON agent_tool_metrics(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_atoolm_session ON agent_tool_metrics(session_id);
      CREATE INDEX IF NOT EXISTS idx_atoolm_tool ON agent_tool_metrics(tool_name);
    `);
        this.safeAddColumn('token_usage', 'billable_input_tokens', 'INTEGER NOT NULL DEFAULT 0');
        this.safeAddColumn('token_usage', 'cache_read_tokens', 'INTEGER DEFAULT 0');
        this.safeAddColumn('token_usage', 'cache_write_tokens', 'INTEGER DEFAULT 0');
        this.safeAddColumn('sessions', 'user_id', 'TEXT');
        this.safeAddColumn('token_usage', 'user_id', 'TEXT');
        this.safeAddColumn('token_usage', 'first_token_ms', 'INTEGER');
        this.safeAddColumn('token_usage', 'generation_ms', 'INTEGER');
        try {
            this.db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, updated_at DESC)');
            this.db.exec('CREATE INDEX IF NOT EXISTS idx_token_usage_user ON token_usage(user_id)');
        } catch { /* 索引创建失败不致命, 查询仍正确只是慢 */ }

        this.safeAddColumn('tasks', 'agent_role', 'TEXT');
        this.safeAddColumn('tasks', 'assigned_at', 'INTEGER');
        this.safeAddColumn('tasks', 'blocked_reason', 'TEXT');
        this.safeAddColumn('tasks', 'escalation_id', 'TEXT');
        this.safeAddColumn('tasks', 'review_score', 'REAL');
        this.safeAddColumn('tasks', 'progress_pct', 'INTEGER');
        this.safeAddColumn('tasks', 'progress_msg', 'TEXT');
        this.safeAddColumn('tasks', 'tool_calls', 'INTEGER DEFAULT 0');
        this.safeAddColumn('tasks', 'last_tool', 'TEXT');
        this.safeAddColumn('tasks', 'source', "TEXT DEFAULT 'user'");
        this.safeAddColumn('tasks', 'kind', "TEXT DEFAULT 'worker_task'");
        this.safeAddColumn('tasks', 'leader_pid', 'TEXT');
        this.safeAddColumn('tasks', 'phase', 'TEXT');

        this.safeAddColumn('timeline_entries', 'entry_id', 'TEXT');
        this.safeAddColumn('timeline_entries', 'updated_at', 'INTEGER');
        this.backfillTimelineEntryIds();
        try {
            this.db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_timeline_session_entry
          ON timeline_entries(session_id, entry_id);
        CREATE INDEX IF NOT EXISTS idx_timeline_session_rowid
          ON timeline_entries(session_id, id);
      `);
            this.timelineUpsertReady = true;
        } catch (err) {
            /* 唯一索引建失败 (残留重复行) → upsert 降级不可用, 下次启动 backfill 幂等重试。
             * 读路径与老 setTimeline 不受影响。 */
            this.timelineUpsertReady = false;
            // eslint-disable-next-line no-console
            console.warn('[NeoxDatabase] timeline unique index failed (upsert degraded):', err);
        }
    }

    private static readonly INTEGRITY_CHECK_INTERVAL_DAYS = 7;
    /* 60s: 要落在启动那一波 (窗口、会话恢复、索引、agent server) 全部安静下来之后 */
    private static readonly INTEGRITY_CHECK_DELAY_MS = 60_000;
    private integrityTimer: ReturnType<typeof setTimeout> | null = null;

    private scheduleIntegrityCheck(): void {
        let lastDay = 0;
        try {
            /* 两种驱动返回形状不同: better-sqlite3 给 [{user_version: N}], bun:sqlite 兼容层
             * 也走 .all()。不传 { simple: true } —— 兼容层的 pragma() 只收一个参数, 传了会被吞。 */
            const raw: any = this.db.pragma('user_version');
            lastDay = Number(Array.isArray(raw) ? raw[0]?.user_version : raw) || 0;
        } catch { return; }
        const today = Math.floor(Date.now() / 86_400_000);
        /* 未来的时间戳 (改过系统时钟 / 换机器) 一律当"该查了", 别把自己永久锁在不查的状态 */
        if (lastDay > 0 && lastDay <= today && today - lastDay < NeoxDatabase.INTEGRITY_CHECK_INTERVAL_DAYS) return;
        this.integrityTimer = setTimeout(() => {
            this.integrityTimer = null;
            this.runIntegrityCheck(today);
        }, NeoxDatabase.INTEGRITY_CHECK_DELAY_MS);
        this.integrityTimer.unref?.();
    }

    /** 真正跑自检。已在关键路径之外 —— 只上报, 不改数据。 */
    private runIntegrityCheck(today: number): void {
        try {
            const q: any = this.db.prepare('PRAGMA quick_check').get();
            const quick = q?.quick_check || q?.integrity_check || q?.result || JSON.stringify(q);
            if (quick === 'ok') {
                try { this.db.pragma(`user_version = ${today}`); } catch { /* 记不上就下次再查 */ }
                try {
                    const { appendEntry } = _auditLog;
                    void appendEntry('db.integrity.ok', { mode: 'quick' });
                } catch { /* ignore */ }
                return;
            }
            /* quick_check 不过 → 花全量的钱换一份能定位的细节, 但**不**记账, 下次启动还会再查 */
            const r: any = this.db.prepare('PRAGMA integrity_check').get();
            const result = r?.integrity_check || r?.result || JSON.stringify(r);
            cliLogger.error('DATABASE', `integrity_check NOT OK: ${result}`);
            try {
                const { appendEntry } = _auditLog;
                void appendEntry('db.integrity.bad', { result, quick });
            } catch { /* audit log 不可用就跳 */ }
        } catch (e: any) {
            cliLogger.warn('DATABASE', `integrity_check failed to run: ${e?.message ?? e}`);
        }
    }

    /** timeline_entries.entry_id 一次性回填 (幂等: 无 NULL 行时零成本)。 */
    private backfillTimelineEntryIds(): void {
        try {
            const pending = this.db.prepare(
                'SELECT COUNT(*) AS n FROM timeline_entries WHERE entry_id IS NULL'
            ).get() as { n: number };
            if (!pending || pending.n === 0) return;

            this.db.transaction(() => {
                const rows = this.db.prepare(
                    'SELECT id, entry_data FROM timeline_entries WHERE entry_id IS NULL'
                ).all() as Array<{ id: number; entry_data: string }>;
                const update = this.db.prepare('UPDATE timeline_entries SET entry_id = ? WHERE id = ?');
                for (const row of rows) {
                    const parsed = this.safeJsonParse(row.entry_data, null) as { id?: unknown } | null;
                    const entryId = parsed && typeof parsed.id === 'string' && parsed.id ? parsed.id : null;
                    if (entryId) update.run(entryId, row.id);
                    /* 提不出业务 id 的行留 NULL — 唯一索引不管 NULL, 读路径照常返回 */
                }
                /* 去重: 同 (session_id, entry_id) 多行只留 rowid 最大的最新行 —
                 * 老 setTimeline 全量重写模式下理论不该有, 防御历史脏数据挡住唯一索引 */
                this.db.prepare(`
          DELETE FROM timeline_entries
          WHERE entry_id IS NOT NULL
            AND id NOT IN (
              SELECT MAX(id) FROM timeline_entries
              WHERE entry_id IS NOT NULL
              GROUP BY session_id, entry_id
            )
        `).run();
            })();
            // eslint-disable-next-line no-console
            console.log(`[NeoxDatabase] timeline entry_id backfilled: ${pending.n} rows`);
        } catch (err) {
            // 回填失败不阻塞启动 — 唯一索引建立会随之失败, 下次启动幂等重试
            // eslint-disable-next-line no-console
            console.warn('[NeoxDatabase] timeline entry_id backfill failed:', err);
        }
    }

    private createTables(): void {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id                TEXT PRIMARY KEY,
        name              TEXT NOT NULL,
        model_id          TEXT NOT NULL,
        workspace_path    TEXT NOT NULL DEFAULT '',
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL,
        total_tokens      INTEGER NOT NULL DEFAULT 0,
        context_used      INTEGER NOT NULL DEFAULT 0,
        context_window    INTEGER,
        file_rollback_checkpoint_id TEXT,
        file_reapply_checkpoint_id  TEXT,
        file_reverted_map  TEXT DEFAULT '{}',
        file_confirmed_map TEXT DEFAULT '{}',
        context_breakdown  TEXT,
        latest_request_usage TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_path);
      CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);

      CREATE TABLE IF NOT EXISTS messages (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq         INTEGER NOT NULL,
        item_type   TEXT NOT NULL,
        item_data   TEXT NOT NULL,
        timestamp   INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, seq);
      CREATE INDEX IF NOT EXISTS idx_messages_session_type_seq ON messages(session_id, item_type, seq DESC);

      CREATE TABLE IF NOT EXISTS timeline_entries (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        entry_data  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_timeline_session ON timeline_entries(session_id);

      CREATE TABLE IF NOT EXISTS token_usage (
        id              TEXT PRIMARY KEY,
        timestamp       INTEGER NOT NULL,
        provider        TEXT NOT NULL,
        model           TEXT NOT NULL,
        input_tokens    INTEGER NOT NULL DEFAULT 0,
        billable_input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens   INTEGER NOT NULL DEFAULT 0,
        total_tokens    INTEGER NOT NULL DEFAULT 0,
        cached_tokens   INTEGER DEFAULT 0,
        cache_read_tokens INTEGER DEFAULT 0,
        cache_write_tokens INTEGER DEFAULT 0,
        openai_cached   INTEGER DEFAULT 0,
        anthropic_cache_read    INTEGER DEFAULT 0,
        anthropic_cache_create  INTEGER DEFAULT 0,
        anthropic_cache_5m      INTEGER DEFAULT 0,
        anthropic_cache_1h      INTEGER DEFAULT 0,
        duration        INTEGER NOT NULL DEFAULT 0,
        first_token_ms  INTEGER,
        generation_ms   INTEGER,
        success         INTEGER NOT NULL DEFAULT 1,
        error           TEXT,
        session_id      TEXT,
        request_type    TEXT DEFAULT 'chat'
      );
      CREATE INDEX IF NOT EXISTS idx_token_usage_time ON token_usage(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_token_usage_provider ON token_usage(provider);

      CREATE TABLE IF NOT EXISTS app_state (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    }

    private migrate(from: number, to: number): void {
        // V1 → V2: Agent OS 表
        if (from < 2) {
            this.createAgentTables();
        }
        // V2 → V3: Steward + ActionLog + Session SQLite 化
        if (from < 3) {
            this.createV3Tables();
        }
        // V3 → V4: 把老 conversation_ledger 数据并入 messages 表, 然后 DROP 老表.
        // ConversationLedger 类已经重构成单源 (messages 表), 老表自 2026-04 写入路径死亡,
        // 留它只占空间. 历史数据 (4 月之前的对话) 平滑迁移过来, 不丢用户上下文.
        if (from < 4) {
            this.migrateConversationLedgerToMessages();
        }
        // V4 → V5: service_instances 表 — ProcessManager 持久化
        if (from < 5) {
            this.createV5Tables();
        }
        // V5 → V6: target_missions 表 — Target Mission 持久化 (session 崩溃 resume 能续)
        if (from < 6) {
            this.createV6Tables();
        }
        // V6 → V7: 去掉 target_missions.session_id 的 REFERENCES sessions(id) 外键
        //   桌面 cloud session 不落 sessions 表, FK 会打回所有 INSERT → 持久化恒 fail
        if (from < 7) {
            this.migrateTargetMissionsRemoveFk();
        }
        this.db.prepare('UPDATE _schema_version SET version = ?').run(to);

        this.safeAddColumn('sessions', 'context_breakdown', 'TEXT');
        this.safeAddColumn('sessions', 'latest_request_usage', 'TEXT');
        this.safeAddColumn('sessions', 'session_usage', 'TEXT');
        this.safeAddColumn('token_usage', 'billable_input_tokens', 'INTEGER NOT NULL DEFAULT 0');
        this.safeAddColumn('token_usage', 'cache_read_tokens', 'INTEGER DEFAULT 0');
        this.safeAddColumn('token_usage', 'cache_write_tokens', 'INTEGER DEFAULT 0');
        // V7 → V8: 用户隔离列 (幂等, 与 initSchema 一致)
        this.safeAddColumn('sessions', 'user_id', 'TEXT');
        this.safeAddColumn('token_usage', 'user_id', 'TEXT');
        // 感知延迟指标列 (幂等, 与 initSchema 一致)
        this.safeAddColumn('token_usage', 'first_token_ms', 'INTEGER');
        this.safeAddColumn('token_usage', 'generation_ms', 'INTEGER');
        this.safeAddColumn('agent_turn_metrics', 'gap_ms', 'INTEGER');
        this.safeAddColumn('agent_turn_metrics', 'max_gap_ms', 'INTEGER');
        this.safeAddColumn('agent_tool_metrics', 'failure_class', 'TEXT');
        this.safeAddColumn('agent_turn_metrics', 'command_failures', 'INTEGER NOT NULL DEFAULT 0');
        this.safeAddColumn('agent_turn_metrics', 'turn_error', 'TEXT');

        this.safeAddColumn('service_instances', 'origin', "TEXT NOT NULL DEFAULT 'spawned'");
        try {
            this.db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, updated_at DESC)');
            this.db.exec('CREATE INDEX IF NOT EXISTS idx_token_usage_user ON token_usage(user_id)');
            this.db.exec('CREATE INDEX IF NOT EXISTS idx_messages_session_type_seq ON messages(session_id, item_type, seq DESC)');
        } catch { /* 非致命 */ }
    }

    /**
     * V3 → V4 数据迁移: conversation_ledger → messages.
     *
     *   每个 (session_id, ledger 行) 在 messages 表追加一条 item_type='message' 行,
     *   seq 续在该 session 现有 MAX(seq) 之后, 不跟既有 messages 行号冲突.
     *
     *   去重策略: 用 idempotency_key 风格的复合检测 — 如果某个 ledger.id 对应的
     *   item_data 已在 messages 表 (ledger_id 字段) 找到, 跳过. 第一次跑后再跑是 no-op.
     *
     *   失败容忍: 整个迁移在 try/catch 里, 任意 row 出错只 warn 不阻断 schema 升级.
     *   conversation_ledger 表不存在时直接跳过 (新装用户没有这张表).
     */
    private migrateConversationLedgerToMessages(): void {
        try {
            /* 老表是否存在 */
            const tableExists = this.db.prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_ledger'"
            ).get();
            if (!tableExists) return;

            const rows = this.db.prepare(
                `SELECT id, session_id, role, content, ts, turn_id FROM conversation_ledger ORDER BY session_id, seq ASC`
            ).all() as Array<{
                id: number; session_id: string; role: string; content: string; ts: number; turn_id: string;
            }>;

            if (rows.length === 0) {
                this.db.exec('DROP TABLE conversation_ledger');
                return;
            }

            /* 关键: messages.session_id 有 FK 约束 (REFERENCES sessions(id) ON DELETE CASCADE).
             * conversation_ledger 里的 session_id 可能是孤儿 (sessions 表早删的老 / 测试 session,
             * 但 conversation_ledger 自己没级联删). 直接 INSERT 这些孤儿会触发 FK error
             * 整个事务回滚 → 老表保留 → 用户重启再撞同一个坑.
             *
             * 修法: 一次性查出哪些 session_id 在 sessions 表里, 只迁移这些;
             * 孤儿数据 (用不上的) 直接丢, 然后 DROP 老表. */
            const validSessionIds = new Set(
                (this.db.prepare(
                    `SELECT DISTINCT cl.session_id FROM conversation_ledger cl
                       WHERE EXISTS (SELECT 1 FROM sessions s WHERE s.id = cl.session_id)`
                ).all() as Array<{ session_id: string }>).map(r => r.session_id)
            );
            const orphanCount = new Set(rows.map(r => r.session_id)).size - validSessionIds.size;

            /* 按 session 分组, 每组在 messages.seq 之后续号. 跳过孤儿 session. */
            const bySession = new Map<string, typeof rows>();
            for (const r of rows) {
                if (!validSessionIds.has(r.session_id)) continue;
                const arr = bySession.get(r.session_id) || [];
                arr.push(r);
                bySession.set(r.session_id, arr);
            }

            let migrated = 0;
            const tx = this.db.transaction(() => {
                for (const [sessionId, sessionRows] of bySession) {
                    /* 去重: 看 messages 里有没有写过 ledger_legacy_id 标记的行
                     * (data 里塞 _legacy_ledger_id 让二次跑 idempotent) */
                    const existingMarkers = this.db.prepare(
                        `SELECT json_extract(item_data, '$._legacy_ledger_id') AS lid
                           FROM messages WHERE session_id = ? AND item_type = 'message'`
                    ).all(sessionId) as Array<{ lid: number | null }>;
                    const seenLids = new Set(existingMarkers.map(m => m.lid).filter(x => x != null));

                    const maxRow = this.db.prepare(
                        'SELECT MAX(seq) AS m FROM messages WHERE session_id = ?'
                    ).get(sessionId) as { m: number | null };
                    let nextSeq = (maxRow.m ?? -1) + 1;

                    const insert = this.db.prepare(
                        'INSERT INTO messages (session_id, seq, item_type, item_data, timestamp) VALUES (?, ?, ?, ?, ?)'
                    );

                    for (const r of sessionRows) {
                        if (seenLids.has(r.id)) continue; /* 已迁移过 */
                        const data = JSON.stringify({
                            role: r.role,
                            content: r.content,
                            turnId: r.turn_id || '',
                            _legacy_ledger_id: r.id, /* 幂等 marker */
                        });
                        insert.run(sessionId, nextSeq++, 'message', data, r.ts);
                        migrated += 1;
                    }
                }
                /* 全部迁移成功才 DROP. 孤儿数据虽然不迁也不影响 DROP. */
                this.db.exec('DROP TABLE conversation_ledger');
            });
            tx();
            console.info(`[DB:migrate v3→v4] migrated ${migrated} rows (skipped ${orphanCount} orphan sessions), conversation_ledger dropped`);
        } catch (err: any) {
            /* schema 升级不能因为这条迁移失败而阻断启动. log + 继续. */
            console.warn(`[DB:migrate v3→v4] conversation_ledger migration failed (skipping): ${err.message}`);
        }
    }

    private createAgentTables(): void {
        try {
            this.db.exec(AGENT_SCHEMA_SQL);
        } catch {
            // Non-fatal: agent tables are supplementary
        }
    }

    private createV3Tables(): void {
        try {
            this.db.exec(SCHEMA_V3_SQL);
        } catch {
            // Non-fatal
        }
    }

    /**
     * V6/V7: target_missions — Target Mission Phase 1.2 持久化.
     *
     * 每个 session 至多 1 条 target (session_id PK). session 崩溃 / 进程退出重启后
     * Boot 时读回状态自动 rehydrate — 主 agent 继续长跑不丢.
     *
     * V6 初版有 REFERENCES sessions(id) ON DELETE CASCADE 外键. 但桌面端 cloud-only session
     * 根本不写本地 sessions 表 (只在 server + 内存 Map), 外键约束触发 SQLITE_CONSTRAINT_FOREIGNKEY
     * → 静默吞异常 → target 从未成功持久化. V7 去掉外键, 改由应用层 (sessionStore.deleteSession +
     * cloud delete handler) 显式清孤儿行.
     *
     * Fields:
     *   status               'active'|'paused'|'satisfied'|'abandoned'|'expired'
     *   target_text          用户/agent 声明的目标文本
     *   rationale            激活时的理由
     *   plan_json            plan_target 声明的 sub-missions 数组 JSON
     *   last_done_check_json 最近一次 check_target_done 结果 {done, reason, ts}
     *   abandon_reason       abandoned 状态的原因
     *   activated_at         首次激活时间戳 (elapsed 显示锚点)
     *   updated_at           最后写入时间戳
     *   max_run_time_ms      P1.4 time ceiling: 超时→expired. NULL 表示无 ceiling.
     */
    private createV6Tables(): void {
        try {
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS target_missions (
                    session_id           TEXT PRIMARY KEY,
                    status               TEXT NOT NULL,
                    target_text          TEXT NOT NULL,
                    rationale            TEXT,
                    plan_json            TEXT,
                    last_done_check_json TEXT,
                    abandon_reason       TEXT,
                    activated_at         INTEGER NOT NULL,
                    updated_at           INTEGER NOT NULL,
                    max_run_time_ms      INTEGER
                );
                CREATE INDEX IF NOT EXISTS idx_target_missions_status
                  ON target_missions(status, updated_at DESC);
            `);
        } catch (err: any) {
            console.warn('[DB:V6] createV6Tables failed:', err?.message);
        }
    }

    /**
     * V6 → V7: DROP + CREATE target_missions 去掉外键约束.
     *
     * V6 表加了 REFERENCES sessions(id), 但桌面 cloud session 根本没进 sessions 表 → INSERT 恒 fail.
     * V7 直接换成裸 PK. 因为 V6 表实际从未有过成功写入 (INSERT 每次都被外键约束打回), DROP 不会
     * 丢用户数据. 万一有幸有数据 (CLI 场景 sessions 表有 row 的 session), 也只是丢 target 状态,
     * 用户下次 activate 重来即可 — 不阻塞升级.
     */
    private migrateTargetMissionsRemoveFk(): void {
        try {
            const row = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='target_missions'").get() as { sql?: string } | undefined;
            if (!row?.sql) {
                // 表不存在, 直接建 V7 版即可
                this.createV6Tables();
                return;
            }
            if (!/REFERENCES\s+sessions/i.test(row.sql)) {
                // 已经是无外键版本 (可能之前手动改过 / 全新装), 无需迁移
                return;
            }
            // 确实是 V6 有外键版本 → drop + recreate
            this.db.exec('DROP TABLE IF EXISTS target_missions;');
            this.createV6Tables();
        } catch (err: any) {
            console.warn('[DB:V7] migrateTargetMissionsRemoveFk failed:', err?.message);
        }
    }

    private createV5Tables(): void {
        try {
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS service_instances (
                    pid                 INTEGER NOT NULL,
                    start_time          INTEGER NOT NULL,
                    workspace_root      TEXT NOT NULL,
                    command             TEXT NOT NULL,
                    cwd                 TEXT NOT NULL,
                    status              TEXT NOT NULL,
                    exit_code           INTEGER,
                    end_time            INTEGER,
                    port                INTEGER,
                    display_name        TEXT,
                    config_id           TEXT,
                    kind                TEXT,
                    adoptable           INTEGER NOT NULL DEFAULT 0,
                    background          INTEGER NOT NULL DEFAULT 1,
                    log_file_path       TEXT,
                    user_killed         INTEGER NOT NULL DEFAULT 0,
                    restart_count       INTEGER NOT NULL DEFAULT 0,
                    healthy             INTEGER,
                    health_checked_at   INTEGER,
                    updated_at          INTEGER NOT NULL,
                    PRIMARY KEY (pid, start_time)
                );
                CREATE INDEX IF NOT EXISTS idx_service_instances_workspace
                  ON service_instances(workspace_root, status);
                CREATE INDEX IF NOT EXISTS idx_service_instances_status
                  ON service_instances(status, updated_at);
            `);
        } catch (err: any) {
            console.warn('[DB:V5] createV5Tables failed:', err?.message);
        }
    }

    /**
     * 安全添加列：先用 PRAGMA table_info 检查列是否存在，存在则跳过。
     * 比 try/catch ALTER TABLE 快约 10x（只读查询 vs 写操作）。
     */
    private safeAddColumn(table: string, column: string, type: string): void {
        const identifierRe = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
        if (!identifierRe.test(table) || !identifierRe.test(column) || !identifierRe.test(type.split(/\s/)[0])) {
            throw new Error(`Invalid SQL identifier in safeAddColumn: ${table}.${column} ${type}`);
        }
        if (!this._tableColumns.has(table)) {
            const cols = this.db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
            this._tableColumns.set(table, new Set(cols.map(c => c.name)));
        }
        if (this._tableColumns.get(table)!.has(column)) return;
        this.db.exec(`ALTER TABLE "${table}" ADD COLUMN ${column} ${type}`);
        this._tableColumns.get(table)!.add(column);
    }

    // ==================== Prepared Statement 缓存 ====================

    private stmt(sql: string): Database.Statement {
        let s = this.stmtCache.get(sql);
        if (!s) {
            s = this.db.prepare(sql);
            this.stmtCache.set(sql, s);
        }
        return s;
    }

    // ==================== 事务辅助 ====================

    transaction<T>(fn: () => T): T {
        return this.db.transaction(fn)();
    }

    // ==================== Sessions CRUD ====================

    upsertSession(session: {
        id: string;
        name: string;
        modelId: string;
        workspacePath: string;
        createdAt: number;
        updatedAt: number;
        totalTokens: number;
        contextUsed: number;
        contextWindow?: number;
        fileRollbackCheckpointId?: string | null;
        fileReapplyCheckpointId?: string | null;
        fileRevertedMap?: Record<string, boolean>;
        fileConfirmedMap?: Record<string, boolean>;
        contextBreakdown?: ContextTokenBreakdown | null;
        latestRequestUsage?: {
    model?: string;
            inputTokens: number;
            billableInputTokens?: number;
            outputTokens: number;
            cacheReadTokens?: number;
            cacheWriteTokens?: number;
            totalTokens: number;
            breakdown?: ContextTokenBreakdown;
        } | null;
        parentSessionId?: string | null;
        kind?: 'chat' | 'image';
    }): void {
        /* 用户隔离: INSERT 时 stamp 当前登录用户 (匿名=NULL); ON CONFLICT 用 COALESCE 保留
         *   首建归属不被后续 update 篡改 (session 归属一旦定, 不随谁 update 而变)。 */
        this.stmt(`
      INSERT INTO sessions
        (id, name, model_id, workspace_path, created_at, updated_at,
         total_tokens, context_used, context_window,
         file_rollback_checkpoint_id, file_reapply_checkpoint_id,
         file_reverted_map, file_confirmed_map, context_breakdown, latest_request_usage, parent_session_id, kind, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name,
        model_id=excluded.model_id,
        workspace_path=excluded.workspace_path,
        updated_at=excluded.updated_at,
        total_tokens=excluded.total_tokens,
        context_used=excluded.context_used,
        context_window=excluded.context_window,
        file_rollback_checkpoint_id=excluded.file_rollback_checkpoint_id,
        file_reapply_checkpoint_id=excluded.file_reapply_checkpoint_id,
        file_reverted_map=excluded.file_reverted_map,
        file_confirmed_map=excluded.file_confirmed_map,
        context_breakdown=excluded.context_breakdown,
        latest_request_usage=excluded.latest_request_usage,
        parent_session_id=COALESCE(excluded.parent_session_id, sessions.parent_session_id),
        kind=COALESCE(sessions.kind, excluded.kind),
        user_id=COALESCE(sessions.user_id, excluded.user_id)
    `).run(
            session.id,
            session.name,
            session.modelId,
            session.workspacePath,
            session.createdAt,
            session.updatedAt,
            session.totalTokens,
            session.contextUsed,
            session.contextWindow ?? null,
            session.fileRollbackCheckpointId ?? null,
            session.fileReapplyCheckpointId ?? null,
            JSON.stringify(session.fileRevertedMap || {}),
            JSON.stringify(session.fileConfirmedMap || {}),
            session.contextBreakdown ? JSON.stringify(session.contextBreakdown) : null,
            session.latestRequestUsage ? JSON.stringify(session.latestRequestUsage) : null,
            session.parentSessionId ?? null,
            session.kind ?? 'chat',
            getCurrentUserId(),
        );
    }

    private userScope(_col = 'user_id'): { clause: string; params: string[] } {
        return { clause: `1=1`, params: [] };
    }

    getSession(sessionId: string): any | null {
        const row = this.stmt('SELECT * FROM sessions WHERE id = ?').get(sessionId) as SessionRow | undefined;
        if (!row) return null;
        return this.rowToSession(row);
    }

    listSessions(workspacePath?: string): any[] {
        const scope = this.userScope();
        let rows: SessionRow[];
        if (workspacePath) {
            rows = this.stmt(
                `SELECT * FROM sessions WHERE workspace_path = ? AND ${scope.clause} ORDER BY updated_at DESC`
            ).all(workspacePath, ...scope.params) as SessionRow[];
        } else {
            rows = this.stmt(
                `SELECT * FROM sessions WHERE ${scope.clause} ORDER BY updated_at DESC`
            ).all(...scope.params) as SessionRow[];
        }
        return rows.map(row => this.rowToSession(row));
    }

    updateSessionField(sessionId: string, field: string, value: any): void {
        // 白名单验证字段名，防止 SQL 注入
        const allowedFields = [
            'name', 'model_id', 'workspace_path', 'updated_at',
            'total_tokens', 'context_used', 'context_window',
            'file_rollback_checkpoint_id', 'file_reapply_checkpoint_id',
            'file_reverted_map', 'file_confirmed_map',
        ];
        if (!allowedFields.includes(field)) {
            throw new Error(`Field "${field}" is not allowed for update`);
        }
        this.db.prepare(`UPDATE sessions SET ${field} = ?, updated_at = ? WHERE id = ?`).run(
            value, Date.now(), sessionId
        );
    }

    /** 一次性迁移 (幂等): 把 agent_mode=work 但 workspace_path 不在 home 的会话改绑到 home.
     *  历史遗留 —— 在 code 项目里建的 Work 会话 bake 了 code 路径, 侧栏归到 code 项目下.
     *  只改会话绑定 (grouping + 未来写入路径), 不搬已有文件. 返回改绑条数. */
    rebindModeSessionsToHome(homes: { work?: string }): number {
        let moved = 0;
        for (const mode of ['work'] as const) {
            const home = homes[mode];
            if (!home) continue;
            const rows = this.db.prepare(
                'SELECT id, workspace_path FROM sessions WHERE agent_mode = ?'
            ).all(mode) as Array<{ id: string; workspace_path: string }>;
            for (const r of rows) {
                if (r.workspace_path !== home) {
                    this.db.prepare('UPDATE sessions SET workspace_path = ? WHERE id = ?').run(home, r.id);
                    moved++;
                }
            }
        }
        return moved;
    }

    updateSessionContextUsed(
        sessionId: string,
        contextUsed: number,
        contextWindow?: number,
        contextBreakdown?: ContextTokenBreakdown,
        latestRequestUsage?: {
            inputTokens: number;
            billableInputTokens?: number;
            outputTokens: number;
            cacheReadTokens?: number;
            cacheWriteTokens?: number;
            totalTokens: number;
            breakdown?: ContextTokenBreakdown;
        } | null,
        sessionUsage?: SessionCacheUsage | null,
    ): void {
        const breakdownJson = contextBreakdown ? JSON.stringify(contextBreakdown) : null;
        const latestRequestUsageJson = latestRequestUsage ? JSON.stringify(latestRequestUsage) : null;
        const sessionUsageJson = sessionUsage ? JSON.stringify(sessionUsage) : null;
        if (contextWindow !== undefined && contextWindow > 0) {
            this.stmt(
                'UPDATE sessions SET context_used = ?, context_window = ?, context_breakdown = COALESCE(?, context_breakdown), latest_request_usage = COALESCE(?, latest_request_usage), session_usage = COALESCE(?, session_usage), updated_at = ? WHERE id = ?'
            ).run(contextUsed, contextWindow, breakdownJson, latestRequestUsageJson, sessionUsageJson, Date.now(), sessionId);
        } else {
            this.stmt(
                'UPDATE sessions SET context_used = ?, context_breakdown = COALESCE(?, context_breakdown), latest_request_usage = COALESCE(?, latest_request_usage), session_usage = COALESCE(?, session_usage), updated_at = ? WHERE id = ?'
            ).run(contextUsed, breakdownJson, latestRequestUsageJson, sessionUsageJson, Date.now(), sessionId);
        }
    }

    deleteSession(sessionId: string): void {
        // CASCADE 会自动删除 messages 和 timeline_entries
        this.stmt('DELETE FROM sessions WHERE id = ?').run(sessionId);
    }

    /* per-session approval mode 读写 — 持久化 ApprovalModeResolver.scopedModes */
    getSessionApprovalMode(sessionId: string): string | null {
        const row = this.stmt('SELECT approval_mode FROM sessions WHERE id = ?').get(sessionId) as { approval_mode?: string | null } | undefined;
        return row?.approval_mode ?? null;
    }

    setSessionApprovalMode(sessionId: string, mode: string | null): void {
        /* 不动 updated_at — 审批模式不算"会话内容变更", 避免列表排序被噪声打乱 */
        this.stmt('UPDATE sessions SET approval_mode = ? WHERE id = ?').run(mode, sessionId);
    }

    listSessionApprovalModes(): Array<{ sessionId: string; mode: string }> {
        const scope = this.userScope();
        const rows = this.stmt(
            `SELECT id, approval_mode FROM sessions WHERE approval_mode IS NOT NULL AND approval_mode != '' AND ${scope.clause}`
        ).all(...scope.params) as Array<{ id: string; approval_mode: string }>;
        return rows.map(r => ({ sessionId: r.id, mode: r.approval_mode }));
    }

    getSessionAgentMode(sessionId: string): string | null {
        const row = this.stmt('SELECT agent_mode FROM sessions WHERE id = ?').get(sessionId) as { agent_mode?: string | null } | undefined;
        return row?.agent_mode ?? null;
    }

    setSessionAgentMode(sessionId: string, mode: string | null): void {
        /* 不动 updated_at — 切模式不算"会话内容变更", 避免列表排序被噪声打乱 */
        this.stmt('UPDATE sessions SET agent_mode = ? WHERE id = ?').run(mode, sessionId);
    }

    /** 单会话改绑工作区根 — 中途切模式 (code → work/life) 时把会话从旧项目根改绑到 mode home.
     *  与 boot 期一次性迁移 rebindModeSessionsToHome 同语义, 只是作用于一条会话.
     *  同样不动 updated_at: 改绑不是会话内容变更, 不该打乱侧栏排序. */
    setSessionWorkspacePath(sessionId: string, workspacePath: string): void {
        this.stmt('UPDATE sessions SET workspace_path = ? WHERE id = ?').run(workspacePath, sessionId);
    }

    setSessionKind(sessionId: string, kind: 'chat' | 'image'): void {
        this.stmt('UPDATE sessions SET kind = ? WHERE id = ?').run(kind, sessionId);
    }

    // ==================== Image Turns CRUD (图片会话产物) ====================

    /** upsert 一条图片出图 turn (按 session_id + turn_id 幂等). payload = JSON 序列化的 turn 对象. */
    upsertImageTurn(sessionId: string, turnId: string, payload: string, createdAt: number): void {
        this.stmt(`
      INSERT INTO image_turns (session_id, turn_id, payload, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id, turn_id) DO UPDATE SET
        payload = excluded.payload
    `).run(sessionId, turnId, payload, createdAt);
    }

    /** 列一个 session 的全部图片 turn, 按 created_at 升序 (老→新, UI 顺序追加). */
    listImageTurns(sessionId: string): Array<{ turnId: string; payload: string; createdAt: number }> {
        const rows = this.stmt('SELECT turn_id, payload, created_at FROM image_turns WHERE session_id = ? ORDER BY created_at ASC').all(sessionId) as Array<{ turn_id: string; payload: string; created_at: number }>;
        return rows.map(r => ({ turnId: r.turn_id, payload: r.payload, createdAt: r.created_at }));
    }

    /** 删一个 session 的全部图片 turn (会话删除时清理). */
    deleteImageTurns(sessionId: string): void {
        this.stmt('DELETE FROM image_turns WHERE session_id = ?').run(sessionId);
    }


    /** 建项目. */
    createImageProject(id: string, name: string, createdAt: number): void {
        this.stmt('INSERT OR REPLACE INTO image_projects (id, name, cover_path, created_at) VALUES (?, ?, (SELECT cover_path FROM image_projects WHERE id = ?), ?)').run(id, name, id, createdAt);
    }

    /** 列全部项目 + 各自素材数, 新→旧. */
    listImageProjects(): Array<{ id: string; name: string; coverPath: string | null; createdAt: number; count: number }> {
        const rows = this.stmt(`
      SELECT p.id, p.name, p.cover_path, p.created_at,
             (SELECT COUNT(*) FROM image_asset_project ap WHERE ap.project_id = p.id) AS cnt
      FROM image_projects p ORDER BY p.created_at DESC
    `).all() as Array<{ id: string; name: string; cover_path: string | null; created_at: number; cnt: number }>;
        return rows.map(r => ({ id: r.id, name: r.name, coverPath: r.cover_path, createdAt: r.created_at, count: r.cnt }));
    }

    renameImageProject(id: string, name: string): void {
        this.stmt('UPDATE image_projects SET name = ? WHERE id = ?').run(name, id);
    }

    /** 删项目 (连带解除素材归属, 不删文件). */
    deleteImageProject(id: string): void {
        this.stmt('DELETE FROM image_asset_project WHERE project_id = ?').run(id);
        this.stmt('DELETE FROM image_projects WHERE id = ?').run(id);
    }

    /** 素材归属到项目 (projectId=null 解除归属 → 回"未分类"). */
    assignImageAsset(assetPath: string, projectId: string | null, createdAt: number): void {
        if (!projectId) {
            this.stmt('DELETE FROM image_asset_project WHERE asset_path = ?').run(assetPath);
            return;
        }
        this.stmt('INSERT OR REPLACE INTO image_asset_project (asset_path, project_id, created_at) VALUES (?, ?, ?)').run(assetPath, projectId, createdAt);
        /* 项目没封面就用这张 */
        this.stmt("UPDATE image_projects SET cover_path = ? WHERE id = ? AND (cover_path IS NULL OR cover_path = '')").run(assetPath, projectId);
    }

    /** 取素材路径 → projectId 映射 (给图库标注/筛选). */
    getImageAssetProjectMap(): Record<string, string> {
        const rows = this.stmt('SELECT asset_path, project_id FROM image_asset_project').all() as Array<{ asset_path: string; project_id: string }>;
        const map: Record<string, string> = {};
        for (const r of rows) map[r.asset_path] = r.project_id;
        return map;
    }

    private rowToSession(row: SessionRow): any {
        return {
            id: row.id,
            name: row.name,
            modelId: row.model_id,
            workspacePath: row.workspace_path,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            totalTokens: row.total_tokens,
            contextUsed: row.context_used,
            contextWindow: row.context_window,
            contextBreakdown: this.safeJsonParse(row.context_breakdown, null),
            latestRequestUsage: this.safeJsonParse(row.latest_request_usage, null),
            sessionUsage: this.safeJsonParse(row.session_usage, null),
            fileRollbackCheckpointId: row.file_rollback_checkpoint_id,
            fileReapplyCheckpointId: row.file_reapply_checkpoint_id,
            fileRevertedMap: this.safeJsonParse(row.file_reverted_map, {}),
            fileConfirmedMap: this.safeJsonParse(row.file_confirmed_map, {}),
            parentSessionId: row.parent_session_id ?? null,
            agentMode: (row as { agent_mode?: string | null }).agent_mode ?? null,
            kind: ((row as { kind?: string | null }).kind === 'image' ? 'image' : 'chat'),
        };
    }

    // ==================== Messages CRUD ====================

    insertMessage(sessionId: string, seq: number, itemType: string, itemData: any, timestamp: number): void {
        this.stmt(`
      INSERT INTO messages (session_id, seq, item_type, item_data, timestamp)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id, seq) DO UPDATE SET
        item_type = excluded.item_type,
        item_data = excluded.item_data,
        timestamp = excluded.timestamp
    `).run(sessionId, seq, itemType, JSON.stringify(itemData), timestamp);
    }

    insertMessagesBatch(sessionId: string, items: Array<{ seq: number; itemType: string; itemData: any; timestamp: number }>): void {
        const insert = this.stmt(`
      INSERT INTO messages (session_id, seq, item_type, item_data, timestamp)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id, seq) DO UPDATE SET
        item_type = excluded.item_type,
        item_data = excluded.item_data,
        timestamp = excluded.timestamp
    `);
        this.db.transaction(() => {
            for (const item of items) {
                insert.run(sessionId, item.seq, item.itemType, JSON.stringify(item.itemData), item.timestamp);
            }
        })();
    }

    getMessages(sessionId: string, limit?: number): Array<{ seq: number; itemType: string; itemData: any; timestamp: number }> {
        let rows: MessageRow[];
        if (limit !== undefined) {
            rows = this.stmt(
                'SELECT seq, item_type, item_data, timestamp FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT ?'
            ).all(sessionId, limit) as MessageRow[];
            rows.reverse(); // 恢复正序
        } else {
            rows = this.stmt(
                'SELECT seq, item_type, item_data, timestamp FROM messages WHERE session_id = ? ORDER BY seq'
            ).all(sessionId) as MessageRow[];
        }
        return rows.map(row => ({
            seq: row.seq,
            itemType: row.item_type,
            itemData: this.safeJsonParse(row.item_data, {}),
            timestamp: row.timestamp,
        }));
    }

    getMessagesByType(sessionId: string, itemType: string): Array<{ seq: number; itemType: string; itemData: any; timestamp: number }> {
        const rows = this.stmt(
            'SELECT seq, item_type, item_data, timestamp FROM messages WHERE session_id = ? AND item_type = ? ORDER BY seq'
        ).all(sessionId, itemType) as MessageRow[];
        return rows.map(row => ({
            seq: row.seq,
            itemType: row.item_type,
            itemData: this.safeJsonParse(row.item_data, {}),
            timestamp: row.timestamp,
        }));
    }

    /** 全部会话的聊天消息统计 (条数 + 首条消息 item_data) — 一次 GROUP BY 全表扫,
     * 给轻量 listSessions 用, 替代 N 会话 × 全量 getTimeline 的启动读放大。
     * 口径与 timelineEntryToChatMessage 一致: item_type='message' 且 role ∈ 三态。 */
    getSessionMessageStats(): Array<{ sessionId: string; count: number; firstItemData: string | null }> {
        const rows = this.stmt(`
            SELECT s.session_id AS session_id, s.cnt AS cnt, m.item_data AS item_data
            FROM (
                SELECT session_id, COUNT(*) AS cnt, MIN(seq) AS first_seq
                FROM messages
                WHERE item_type = 'message'
                  AND json_extract(item_data, '$.role') IN ('user','assistant','system')
                GROUP BY session_id
            ) s
            LEFT JOIN messages m ON m.session_id = s.session_id AND m.seq = s.first_seq
        `).all() as Array<{ session_id: string; cnt: number; item_data: string | null }>;
        return rows.map((r) => ({ sessionId: r.session_id, count: r.cnt, firstItemData: r.item_data }));
    }

    searchMessages(
        query: string,
        opts?: { workspacePath?: string; limit?: number },
    ): Array<{ sessionId: string; sessionName: string; sessionUpdatedAt: number; seq: number; itemData: any; timestamp: number }> {
        const q = (query || '').trim();
        if (!q) return [];
        const scope = this.userScope();
        const limit = Math.max(1, Math.min(opts?.limit ?? 200, 1000));
        /* LIKE 的通配符要转义, 否则用户搜 "100%" 会退化成匹配一切 */
        const escaped = q.replace(/[\\%_]/g, (c) => '\\' + c);
        const like = `%${escaped}%`;
        const wsClause = opts?.workspacePath ? ' AND s.workspace_path = ?' : '';
        const params: any[] = [like];
        if (opts?.workspacePath) params.push(opts.workspacePath);
        const rows = this.stmt(`
            SELECT m.session_id AS session_id, m.seq AS seq, m.item_data AS item_data,
                   m.timestamp AS timestamp, s.name AS name, s.updated_at AS updated_at
            FROM messages m
            JOIN sessions s ON s.id = m.session_id
            WHERE m.item_type = 'message'
              AND json_extract(m.item_data, '$.role') IN ('user','assistant','system')
              AND lower(m.item_data) LIKE lower(?) ESCAPE '\\'
              ${wsClause}
              AND ${scope.clause}
            ORDER BY m.timestamp DESC
            LIMIT ${limit}
        `).all(...params, ...scope.params) as Array<{
            session_id: string; seq: number; item_data: string; timestamp: number; name: string; updated_at: number;
        }>;
        return rows.map((r) => ({
            sessionId: r.session_id,
            sessionName: r.name || '',
            sessionUpdatedAt: r.updated_at || 0,
            seq: r.seq,
            itemData: this.safeJsonParse(r.item_data, {}),
            timestamp: r.timestamp,
        }));
    }

    getMessageCount(sessionId: string): number {
        const row = this.stmt(
            'SELECT COUNT(*) as count FROM messages WHERE session_id = ?'
        ).get(sessionId) as CountRow | undefined;
        return row?.count || 0;
    }

    getMaxMessageSeq(sessionId: string): number {
        const row = this.stmt(
            'SELECT MAX(seq) as max_seq FROM messages WHERE session_id = ?'
        ).get(sessionId) as CountRow | undefined;
        return row?.max_seq ?? -1;
    }

    getLastMessage(sessionId: string): { seq: number; itemType: string; itemData: any; timestamp: number } | null {
        const row = this.stmt(
            'SELECT seq, item_type, item_data, timestamp FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT 1'
        ).get(sessionId) as MessageRow | undefined;
        if (!row) return null;
        return {
            seq: row.seq,
            itemType: row.item_type,
            itemData: this.safeJsonParse(row.item_data, {}),
            timestamp: row.timestamp,
        };
    }

    getLastMessages(sessionId: string, count: number): Array<{ seq: number; itemType: string; itemData: any; timestamp: number }> {
        const rows = this.stmt(
            'SELECT seq, item_type, item_data, timestamp FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT ?'
        ).all(sessionId, count) as MessageRow[];
        // 返回正序（最早的在前）
        rows.reverse();
        return rows.map(row => ({
            seq: row.seq,
            itemType: row.item_type,
            itemData: this.safeJsonParse(row.item_data, {}),
            timestamp: row.timestamp,
        }));
    }

    deleteMessage(sessionId: string, seq: number): void {
        this.stmt('DELETE FROM messages WHERE session_id = ? AND seq = ?').run(sessionId, seq);
    }

    deleteLastMessages(sessionId: string, count: number): void {
        this.db.prepare(`
      DELETE FROM messages WHERE id IN (
        SELECT id FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT ?
      )
    `).run(sessionId, count);
    }

    deleteFromNthLastUserMessage(sessionId: string, k: number): number {
        if (!Number.isInteger(k) || k < 1) return -1;
        const row = this.stmt(
            `SELECT seq FROM messages
             WHERE session_id = ? AND item_type = 'message'
               AND json_extract(item_data, '$.role') = 'user'
             ORDER BY seq DESC LIMIT 1 OFFSET ?`
        ).get(sessionId, k - 1) as CountRow | undefined;
        if (!row || typeof row.seq !== 'number') return -1;
        /* seq >= 而不是 > —— 被编辑的那条用户消息**自己也要删**, 新文本会作为新消息重发。 */
        const result = this.db.prepare(
            'DELETE FROM messages WHERE session_id = ? AND seq >= ?'
        ).run(sessionId, row.seq);
        return result.changes;
    }

    rollbackToCheckpoint(sessionId: string, checkpointId: string): number {
        // 找到 checkpoint 的 seq
        const row = this.stmt(
            "SELECT seq FROM messages WHERE session_id = ? AND item_type = 'checkpoint' AND json_extract(item_data, '$.id') = ?"
        ).get(sessionId, checkpointId) as CountRow | undefined;

        if (!row) throw new Error(`Checkpoint not found: ${checkpointId}`);

        // 删除 checkpoint 之后的所有条目
        const result = this.db.prepare(
            'DELETE FROM messages WHERE session_id = ? AND seq > ?'
        ).run(sessionId, row.seq);

        return result.changes;
    }

    getCheckpoints(sessionId: string): Array<{ id: string; name?: string; timestamp: number }> {
        const rows = this.stmt(
            "SELECT item_data, timestamp FROM messages WHERE session_id = ? AND item_type = 'checkpoint' ORDER BY seq"
        ).all(sessionId) as Array<Pick<MessageRow, 'item_data' | 'timestamp'>>;
        return rows.map(row => {
            const data = this.safeJsonParse(row.item_data, {});
            return {
                id: data.id,
                name: data.name,
                timestamp: row.timestamp,
            };
        });
    }

    getSessionMeta(sessionId: string): any | null {
        const row = this.stmt(
            "SELECT item_data FROM messages WHERE session_id = ? AND item_type = 'meta' ORDER BY seq LIMIT 1"
        ).get(sessionId) as Pick<MessageRow, 'item_data'> | undefined;
        if (!row) return null;
        return this.safeJsonParse(row.item_data, null);
    }

    clearMessages(sessionId: string): void {
        this.stmt('DELETE FROM messages WHERE session_id = ?').run(sessionId);
    }


    // ==================== Timeline CRUD ====================

    setTimeline(sessionId: string, entries: any[]): void {
        this.db.transaction(() => {
            this.stmt('DELETE FROM timeline_entries WHERE session_id = ?').run(sessionId);
            if (entries.length > 0) {
                /* 全量重写路径也带上 entry_id/updated_at — 与行级 upsert 口径一致,
                 * 否则 setTimeline 写的行 entry_id=NULL, 后续 upsert 同 id 会插重复行 */
                const insert = this.stmt(
                    'INSERT INTO timeline_entries (session_id, entry_id, entry_data, updated_at) VALUES (?, ?, ?, ?)'
                );
                const now = Date.now();
                for (const entry of entries) {
                    const entryId = entry && typeof entry.id === 'string' && entry.id ? entry.id : null;
                    insert.run(sessionId, entryId, JSON.stringify(entry), now);
                }
            }
        })();
    }

    getTimeline(sessionId: string): any[] {
        const rows = this.stmt(
            'SELECT entry_data FROM timeline_entries WHERE session_id = ? ORDER BY id'
        ).all(sessionId) as TimelineEntryRow[];
        return rows.map(row => this.safeJsonParse(row.entry_data, null)).filter(Boolean);
    }

    clearTimeline(sessionId: string): void {
        this.stmt('DELETE FROM timeline_entries WHERE session_id = ?').run(sessionId);
    }


    /** 行级批量 upsert。无业务 id 的条目跳过 (NULL 撞不上唯一约束会重复插入)。 */
    upsertTimelineEntries(sessionId: string, entries: any[]): { ok: boolean; written: number } {
        if (!Array.isArray(entries) || entries.length === 0) return { ok: true, written: 0 };
        if (!this.timelineUpsertReady) {
            /* 唯一索引缺失 (backfill 失败的罕见降级) → 回落全量重写语义: 读全量 merge 后 setTimeline。
             * 慢但正确, 且只影响这台机器直到下次启动 backfill 成功。 */
            const existing = this.getTimeline(sessionId);
            const byId = new Map<string, any>(
                existing.filter((e: any) => typeof e?.id === 'string').map((e: any) => [e.id, e]),
            );
            for (const e of entries) {
                if (e && typeof e.id === 'string' && e.id) byId.set(e.id, e);
            }
            this.setTimeline(sessionId, [...byId.values()]);
            return { ok: true, written: entries.length };
        }
        let written = 0;
        this.db.transaction(() => {
            const stmt = this.stmt(`
        INSERT INTO timeline_entries (session_id, entry_id, entry_data, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(session_id, entry_id)
        DO UPDATE SET entry_data = excluded.entry_data, updated_at = excluded.updated_at
      `);
            const now = Date.now();
            for (const entry of entries) {
                const entryId = entry && typeof entry.id === 'string' && entry.id ? entry.id : null;
                if (!entryId) continue;
                stmt.run(sessionId, entryId, JSON.stringify(entry), now);
                written++;
            }
        })();
        return { ok: true, written };
    }

    /** 分页读 (从最新端往回)。beforeRowId 缺省 = 取最新一页。entries 按时间正序返回。 */
    getTimelinePage(sessionId: string, limit = 1000, beforeRowId?: number): {
        entries: any[];
        oldestRowId: number | null;
        total: number;
    } {
        const safeLimit = Math.max(1, Math.min(5000, Math.floor(limit)));
        const total = (this.stmt(
            'SELECT COUNT(*) AS n FROM timeline_entries WHERE session_id = ?'
        ).get(sessionId) as { n: number }).n;
        const rows = (typeof beforeRowId === 'number' && Number.isFinite(beforeRowId)
            ? this.stmt(
                'SELECT id, entry_data FROM timeline_entries WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?'
            ).all(sessionId, beforeRowId, safeLimit)
            : this.stmt(
                'SELECT id, entry_data FROM timeline_entries WHERE session_id = ? ORDER BY id DESC LIMIT ?'
            ).all(sessionId, safeLimit)) as Array<{ id: number; entry_data: string }>;
        rows.reverse(); /* DESC 取页 → 正序返回 */
        const entries = rows
            .map((r) => this.safeJsonParse(r.entry_data, null))
            .filter(Boolean);
        return {
            entries,
            oldestRowId: rows.length > 0 ? rows[0].id : null,
            total,
        };
    }

    deleteTimelineEntryById(sessionId: string, entryId: string): boolean {
        const res = this.stmt(
            'DELETE FROM timeline_entries WHERE session_id = ? AND entry_id = ?'
        ).run(sessionId, entryId);
        return res.changes > 0;
    }

    countTimeline(sessionId: string): number {
        return (this.stmt(
            'SELECT COUNT(*) AS n FROM timeline_entries WHERE session_id = ?'
        ).get(sessionId) as { n: number }).n;
    }

    /** 超上限裁剪 — 删最旧的行到 cap 以内 (子代理 cap 场景用)。返回删除行数。 */
    trimTimelineToCap(sessionId: string, cap: number): number {
        const excess = this.countTimeline(sessionId) - Math.max(1, cap);
        if (excess <= 0) return 0;
        const res = this.stmt(`
      DELETE FROM timeline_entries
      WHERE session_id = ? AND id IN (
        SELECT id FROM timeline_entries WHERE session_id = ? ORDER BY id ASC LIMIT ?
      )
    `).run(sessionId, sessionId, excess);
        return res.changes;
    }

    // ==================== Token Usage ====================

    recordTokenUsage(record: {
        id: string;
        timestamp: number;
        provider: string;
        model: string;
        inputTokens: number;
        billableInputTokens?: number;
        outputTokens: number;
        totalTokens: number;
        cachedTokens?: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
        openaiCachedTokens?: number;
        anthropicCacheReadTokens?: number;
        anthropicCacheCreationTokens?: number;
        anthropicCacheCreation5mTokens?: number;
        anthropicCacheCreation1hTokens?: number;
        duration: number;
        firstTokenMs?: number;
        generationMs?: number;
        success: boolean;
        error?: string;
        sessionId?: string;
        requestType?: string;
    }): void {
        this.stmt(`
      INSERT OR REPLACE INTO token_usage
        (id, timestamp, provider, model, input_tokens, billable_input_tokens, output_tokens, total_tokens,
         cached_tokens, cache_read_tokens, cache_write_tokens, openai_cached, anthropic_cache_read, anthropic_cache_create,
         anthropic_cache_5m, anthropic_cache_1h, duration, first_token_ms, generation_ms, success, error, session_id, request_type, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
            record.id,
            record.timestamp,
            record.provider,
            record.model,
            record.inputTokens,
            record.billableInputTokens || 0,
            record.outputTokens,
            record.totalTokens,
            record.cachedTokens || 0,
            record.cacheReadTokens || 0,
            record.cacheWriteTokens || 0,
            record.openaiCachedTokens || 0,
            record.anthropicCacheReadTokens || 0,
            record.anthropicCacheCreationTokens || 0,
            record.anthropicCacheCreation5mTokens || 0,
            record.anthropicCacheCreation1hTokens || 0,
            record.duration,
            record.firstTokenMs ?? null,
            record.generationMs ?? null,
            record.success ? 1 : 0,
            record.error || null,
            record.sessionId || null,
            record.requestType || 'chat',
            getCurrentUserId(),
        );

        // 自动清理超出限制的旧记录 (按用户分桶, 防高频用户挤掉其他桶记录)
        this.trimTokenUsage();
    }

    private trimTokenUsage(): void {
        /* 用户隔离: 按当前桶裁剪, 不跨用户误删。 */
        const scope = this.userScope();
        const count = (this.stmt(`SELECT COUNT(*) as c FROM token_usage WHERE ${scope.clause}`).get(...scope.params) as CountRow | undefined)?.c || 0;
        if (count > MAX_TOKEN_USAGE_RECORDS) {
            const deleteCount = count - MAX_TOKEN_USAGE_RECORDS;
            this.db.prepare(`
        DELETE FROM token_usage WHERE id IN (
          SELECT id FROM token_usage WHERE ${scope.clause} ORDER BY timestamp ASC LIMIT ?
        )
      `).run(...scope.params, deleteCount);
        }
    }


    /** 落一行 turn 级指标 (一 turn 一行)。所有派生率 (action_yield 等) 由调用方算好传入或此处兜底算。 */
    recordTurnMetric(r: {
        id: string; timestamp: number; sessionId?: string; turnIndex?: number;
        provider?: string; model?: string;
        inferences?: number; toolCalls?: number;
        toolFailures?: number; commandFailures?: number; turnError?: string;
        editCalls?: number; editFailures?: number;
        duplicateReadCount?: number; duplicateSearchCount?: number;
        ttfaMs?: number; durationMs?: number; gapMs?: number; maxGapMs?: number;
        inputTokens?: number; outputTokens?: number; cacheReadTokens?: number;
        wasteJson?: string;
    }): void {
        const inferences = r.inferences ?? 0;
        const toolCalls = r.toolCalls ?? 0;
        const editCalls = r.editCalls ?? 0;
        const actionYield = inferences > 0 ? toolCalls / inferences : null;
        const failedEditRate = editCalls > 0 ? (r.editFailures ?? 0) / editCalls : null;
        this.stmt(`
      INSERT OR REPLACE INTO agent_turn_metrics
        (id, timestamp, session_id, turn_index, provider, model, inferences, tool_calls, action_yield,
         tool_failures, command_failures, turn_error, edit_calls, edit_failures, failed_edit_rate,
         duplicate_read_count, duplicate_search_count,
         ttfa_ms, duration_ms, gap_ms, max_gap_ms, input_tokens, output_tokens, cache_read_tokens, waste_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
            r.id, r.timestamp, r.sessionId ?? null, r.turnIndex ?? null, r.provider ?? null, r.model ?? null,
            inferences, toolCalls, actionYield,
            r.toolFailures ?? 0, r.commandFailures ?? 0, r.turnError ?? null, editCalls, r.editFailures ?? 0, failedEditRate,
            r.duplicateReadCount ?? 0, r.duplicateSearchCount ?? 0,
            r.ttfaMs ?? null, r.durationMs ?? null, r.gapMs ?? null, r.maxGapMs ?? null,
            r.inputTokens ?? null, r.outputTokens ?? null, r.cacheReadTokens ?? null,
            r.wasteJson ?? null,
        );
        this.trimAgentMetrics('agent_turn_metrics', 20000);
    }

    /** 落一行工具级指标 (一工具调用一行)。 */
    recordToolMetric(r: {
        id: string; timestamp: number; sessionId?: string; turnIndex?: number;
        toolName: string; success: boolean; durationMs?: number;
        isDuplicate?: boolean; errorKind?: string; failureClass?: string; argsHash?: string;
    }): void {
        this.stmt(`
      INSERT OR REPLACE INTO agent_tool_metrics
        (id, timestamp, session_id, turn_index, tool_name, success, duration_ms, is_duplicate, error_kind, failure_class, args_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
            r.id, r.timestamp, r.sessionId ?? null, r.turnIndex ?? null, r.toolName,
            r.success ? 1 : 0, r.durationMs ?? null, r.isDuplicate ? 1 : 0, r.errorKind ?? null, r.failureClass ?? null, r.argsHash ?? null,
        );
        this.trimAgentMetrics('agent_tool_metrics', 100000);
    }

    private trimAgentMetrics(table: 'agent_turn_metrics' | 'agent_tool_metrics', cap: number): void {
        const count = (this.stmt(`SELECT COUNT(*) as c FROM ${table}`).get() as CountRow | undefined)?.c || 0;
        if (count > cap) {
            this.db.prepare(`DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} ORDER BY timestamp ASC LIMIT ?)`).run(count - cap);
        }
    }

    /** monitor 读: 最近 N 条 turn 指标 (可选按 session 过滤)。 */
    getTurnMetrics(opts: { limit?: number; sessionId?: string; sinceMs?: number } = {}): any[] {
        const where: string[] = [];
        const params: any[] = [];
        if (opts.sessionId) { where.push('session_id = ?'); params.push(opts.sessionId); }
        if (opts.sinceMs) { where.push('timestamp >= ?'); params.push(opts.sinceMs); }
        const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
        params.push(Math.min(opts.limit ?? 500, 5000));
        return this.db.prepare(`SELECT * FROM agent_turn_metrics ${clause} ORDER BY timestamp DESC LIMIT ?`).all(...params);
    }

    /** monitor 读: 最近 N 条 tool 指标。 */
    getToolMetrics(opts: { limit?: number; sessionId?: string; sinceMs?: number } = {}): any[] {
        const where: string[] = [];
        const params: any[] = [];
        if (opts.sessionId) { where.push('session_id = ?'); params.push(opts.sessionId); }
        if (opts.sinceMs) { where.push('timestamp >= ?'); params.push(opts.sinceMs); }
        const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
        params.push(Math.min(opts.limit ?? 2000, 20000));
        return this.db.prepare(`SELECT * FROM agent_tool_metrics ${clause} ORDER BY timestamp DESC LIMIT ?`).all(...params);
    }

    /** monitor 读: 整体聚合 (headline 卡片用)。 */
    getAgentMetricsSummary(opts: { sinceMs?: number } = {}): any {
        const turnWhere = opts.sinceMs ? 'WHERE timestamp >= ?' : '';
        const turnParams = opts.sinceMs ? [opts.sinceMs] : [];
        const turn = this.db.prepare(`
      SELECT
        COUNT(*) AS turns,
        SUM(tool_calls) AS tool_calls,
        SUM(inferences) AS inferences,
        AVG(action_yield) AS avg_action_yield,
        SUM(tool_failures) AS tool_failures,
        SUM(edit_calls) AS edit_calls,
        SUM(edit_failures) AS edit_failures,
        SUM(duplicate_read_count) AS duplicate_reads,
        SUM(duplicate_search_count) AS duplicate_searches,
        AVG(ttfa_ms) AS avg_ttfa_ms,
        AVG(duration_ms) AS avg_duration_ms
      FROM agent_turn_metrics ${turnWhere}
    `).get(...turnParams) as any;
        const toolWhere = opts.sinceMs ? 'WHERE timestamp >= ?' : '';
        const byTool = this.db.prepare(`
      SELECT tool_name,
        COUNT(*) AS calls,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failures,
        SUM(is_duplicate) AS duplicates,
        AVG(duration_ms) AS avg_ms
      FROM agent_tool_metrics ${toolWhere}
      GROUP BY tool_name ORDER BY calls DESC
    `).all(...turnParams) as any[];
        const editCalls = turn?.edit_calls || 0;
        const toolCalls = turn?.tool_calls || 0;
        return {
            ...turn,
            failed_edit_rate: editCalls > 0 ? (turn.edit_failures || 0) / editCalls : null,
            duplicate_read_rate: toolCalls > 0 ? (turn.duplicate_reads || 0) / toolCalls : null,
            by_tool: byTool,
        };
    }

    clearAgentMetrics(): void {
        this.db.exec('DELETE FROM agent_turn_metrics; DELETE FROM agent_tool_metrics;');
    }

    getTokenUsageStats(): any[] {
        const scope = withLocalUsageScope(this.userScope());
        return this.db.prepare(`
      SELECT
        provider,
        COUNT(*) as total_requests,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as success_requests,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failed_requests,
        SUM(input_tokens) as total_input_tokens,
        SUM(billable_input_tokens) as total_billable_input_tokens,
        SUM(output_tokens) as total_output_tokens,
        SUM(total_tokens) as total_tokens,
        SUM(cached_tokens) as total_cached_tokens,
        SUM(cache_read_tokens) as total_cache_read_tokens,
        SUM(cache_write_tokens) as total_cache_write_tokens,
        SUM(openai_cached) as total_openai_cached,
        SUM(anthropic_cache_read) as total_anthropic_cache_read,
        SUM(anthropic_cache_create) as total_anthropic_cache_create,
        SUM(anthropic_cache_5m) as total_anthropic_cache_5m,
        SUM(anthropic_cache_1h) as total_anthropic_cache_1h,
        AVG(duration) as avg_duration,
        AVG(first_token_ms) as avg_first_token_ms,
        CASE WHEN SUM(CASE WHEN generation_ms > 0 THEN generation_ms ELSE 0 END) > 0
             THEN SUM(CASE WHEN generation_ms > 0 THEN output_tokens ELSE 0 END) * 1000.0
                  / SUM(CASE WHEN generation_ms > 0 THEN generation_ms ELSE 0 END)
             ELSE NULL END as avg_tokens_per_sec,
        MAX(timestamp) as last_request_time
      FROM token_usage
      WHERE ${scope.clause}
      GROUP BY provider
      ORDER BY last_request_time DESC
    `).all(...scope.params);
    }

    getTokenUsageByProvider(provider: string, limit = 100): any[] {
        const scope = this.userScope();
        return this.stmt(
            `SELECT * FROM token_usage WHERE provider = ? AND ${scope.clause} ORDER BY timestamp DESC LIMIT ?`
        ).all(provider, ...scope.params, limit);
    }

    getRecentTokenUsage(limit = 50): any[] {
        const scope = withLocalUsageScope(this.userScope());
        return this.stmt(
            `SELECT * FROM token_usage WHERE ${scope.clause} ORDER BY timestamp DESC LIMIT ?`
        ).all(...scope.params, limit);
    }

    getDailyTokenUsage(days = 30): any[] {
        const scope = withLocalUsageScope(this.userScope());
        const since = Date.now() - days * 24 * 60 * 60 * 1000;
        return this.stmt(`
      SELECT
        date(timestamp / 1000, 'unixepoch', 'localtime') AS day,
        COUNT(*)                              AS requests,
        COALESCE(SUM(input_tokens), 0)        AS input_tokens,
        COALESCE(SUM(output_tokens), 0)       AS output_tokens,
        COALESCE(SUM(total_tokens), 0)        AS total_tokens
      FROM token_usage
      WHERE timestamp >= ? AND ${scope.clause}
      GROUP BY day
      ORDER BY day ASC
    `).all(since, ...scope.params);
    }

    getSessionTurnUsage(sessionId: string): Array<{
        timestamp: number; model: string | null;
        inputTokens: number; outputTokens: number; cacheReadTokens: number; totalTokens: number;
    }> {
        const rows = this.stmt(`
      SELECT timestamp, model,
             COALESCE(input_tokens, 0)      AS input_tokens,
             COALESCE(output_tokens, 0)     AS output_tokens,
             COALESCE(cache_read_tokens, 0) AS cache_read_tokens
        FROM agent_turn_metrics
       WHERE session_id = ?
       ORDER BY timestamp ASC
    `).all(sessionId) as any[];
        return rows.map((r) => ({
            timestamp: Number(r.timestamp || 0),
            model: r.model ? String(r.model) : null,
            inputTokens: Number(r.input_tokens || 0),
            outputTokens: Number(r.output_tokens || 0),
            cacheReadTokens: Number(r.cache_read_tokens || 0),
            totalTokens: Number(r.input_tokens || 0) + Number(r.output_tokens || 0),
        }));
    }

    getTokenUsageSummary(): any {
        const scope = withLocalUsageScope(this.userScope());
        const row = this.db.prepare(`
      SELECT
        COUNT(*) as total_requests,
        COALESCE(SUM(total_tokens), 0) as total_tokens,
        COALESCE(SUM(input_tokens), 0) as total_input_tokens,
        COALESCE(SUM(billable_input_tokens), 0) as total_billable_input_tokens,
        COALESCE(SUM(output_tokens), 0) as total_output_tokens,
        COALESCE(SUM(cached_tokens), 0) as total_cached_tokens,
        COALESCE(SUM(cache_read_tokens), 0) as total_cache_read_tokens,
        COALESCE(SUM(cache_write_tokens), 0) as total_cache_write_tokens,
        COALESCE(SUM(openai_cached), 0) as total_openai_cached,
        COALESCE(SUM(anthropic_cache_read), 0) as total_anthropic_cache_read,
        COALESCE(SUM(anthropic_cache_create), 0) as total_anthropic_cache_create,
        COUNT(DISTINCT provider) as provider_count,
        AVG(first_token_ms) as avg_first_token_ms,
        CASE WHEN SUM(CASE WHEN generation_ms > 0 THEN generation_ms ELSE 0 END) > 0
             THEN SUM(CASE WHEN generation_ms > 0 THEN output_tokens ELSE 0 END) * 1000.0
                  / SUM(CASE WHEN generation_ms > 0 THEN generation_ms ELSE 0 END)
             ELSE NULL END as avg_tokens_per_sec,
        MAX(timestamp) as last_request_time
      FROM token_usage
      WHERE ${scope.clause}
    `).get(...scope.params) as TokenUsageSummaryRow | undefined;

        const totalInput = row?.total_input_tokens || 0;
        const totalCached = row?.total_cached_tokens || 0;

        return {
            totalRequests: row?.total_requests || 0,
            totalTokens: row?.total_tokens || 0,
            totalInputTokens: totalInput,
            totalBillableInputTokens: row?.total_billable_input_tokens || 0,
            totalOutputTokens: row?.total_output_tokens || 0,
            totalCachedTokens: totalCached,
            totalCacheReadTokens: row?.total_cache_read_tokens || 0,
            totalCacheWriteTokens: row?.total_cache_write_tokens || 0,
            totalOpenaiCachedTokens: row?.total_openai_cached || 0,
            totalAnthropicCacheReadTokens: row?.total_anthropic_cache_read || 0,
            totalAnthropicCacheCreationTokens: row?.total_anthropic_cache_create || 0,
            cacheHitRate: totalInput > 0 ? totalCached / totalInput : 0,
            providerCount: row?.provider_count || 0,
            avgFirstTokenMs: (row as any)?.avg_first_token_ms ?? null,
            avgTokensPerSec: (row as any)?.avg_tokens_per_sec ?? null,
            lastRequestTime: row?.last_request_time || 0,
        };
    }

    getSessionTokenUsageSummary(sessionId: string): {
        requests: number;
        inputTokens: number;
        baseInputTokens: number;
        outputTokens: number;
        totalTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        hitRate: number;
    } {
        const row = this.db.prepare(`
      SELECT
        COUNT(*) as requests,
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(billable_input_tokens), 0) as billable_input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens,
        COALESCE(SUM(total_tokens), 0) as total_tokens,
        COALESCE(SUM(cache_read_tokens), 0) as cache_read_tokens,
        COALESCE(SUM(cache_write_tokens), 0) as cache_write_tokens
      FROM token_usage
      WHERE session_id = ?
    `).get(sessionId) as SessionTokenUsageSummaryRow | undefined;

        const requests = row?.requests || 0;
        const inputTokens = row?.input_tokens || 0;
        const billableInputTokens = row?.billable_input_tokens;
        const cacheReadTokens = row?.cache_read_tokens || 0;
        const cacheWriteTokens = row?.cache_write_tokens || 0;
        const baseInputTokens = Math.max(
            0,
            billableInputTokens !== undefined ? billableInputTokens : (inputTokens - cacheReadTokens - cacheWriteTokens),
        );

        return {
            requests,
            inputTokens,
            baseInputTokens,
            outputTokens: row?.output_tokens || 0,
            totalTokens: row?.total_tokens || 0,
            cacheReadTokens,
            cacheWriteTokens,
            hitRate: inputTokens > 0 ? (cacheReadTokens / inputTokens) : 0,
        };
    }

    getTokenUsageModelStats(provider: string): Record<string, any> {
        const scope = this.userScope();
        const rows = this.db.prepare(`
      SELECT
        model,
        COUNT(*) as requests,
        SUM(input_tokens) as input_tokens,
        SUM(billable_input_tokens) as billable_input_tokens,
        SUM(output_tokens) as output_tokens,
        SUM(total_tokens) as total_tokens,
        SUM(cached_tokens) as cached_tokens,
        SUM(cache_read_tokens) as cache_read_tokens,
        SUM(cache_write_tokens) as cache_write_tokens
      FROM token_usage
      WHERE provider = ? AND ${scope.clause}
      GROUP BY model
    `).all(provider, ...scope.params) as TokenUsageModelRow[];

        const models: Record<string, any> = {};
        for (const row of rows) {
            models[row.model] = {
                requests: row.requests,
                inputTokens: row.input_tokens,
                billableInputTokens: row.billable_input_tokens,
                outputTokens: row.output_tokens,
                totalTokens: row.total_tokens,
                cachedTokens: row.cached_tokens,
                cacheReadTokens: row.cache_read_tokens,
                cacheWriteTokens: row.cache_write_tokens,
            };
        }
        return models;
    }

    /**
     * 获取指定 session 的按模型分组的 token 使用详情
     * 用于 session resume 时恢复 costTracker 状态
     */
    getSessionTokenUsageByModel(sessionId: string): Array<{
        model: string;
        provider: string;
        requests: number;
        inputTokens: number;
        outputTokens: number;
        cachedTokens: number;
        cacheWriteTokens: number;
    }> {
        const rows = this.db.prepare(`
      SELECT
        model,
        provider,
        COUNT(*) as requests,
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens,
        COALESCE(SUM(cached_tokens), 0) as cached_tokens,
        COALESCE(SUM(cache_write_tokens), 0) as cache_write_tokens
      FROM token_usage
      WHERE session_id = ?
      GROUP BY model, provider
    `).all(sessionId) as Array<{
            model: string;
            provider: string;
            requests: number;
            input_tokens: number;
            output_tokens: number;
            cached_tokens: number;
            cache_write_tokens: number;
        }>;

        return rows.map(row => ({
            model: row.model,
            provider: row.provider,
            requests: row.requests,
            inputTokens: row.input_tokens,
            outputTokens: row.output_tokens,
            cachedTokens: row.cached_tokens,
            cacheWriteTokens: row.cache_write_tokens,
        }));
    }

    clearTokenUsage(): void {
        /* 用户隔离: /usage clear 只清当前桶, 不动别的用户画像。 */
        const scope = this.userScope();
        this.db.prepare(`DELETE FROM token_usage WHERE ${scope.clause}`).run(...scope.params);
    }

    clearTokenUsageByProvider(provider: string): void {
        const scope = this.userScope();
        this.stmt(`DELETE FROM token_usage WHERE provider = ? AND ${scope.clause}`).run(provider, ...scope.params);
    }

    backfillHistoricalTokenUsage(): { updated: number; sessionUpdated: number; skipped: boolean } {
        const migrated = this.getAppState<{ completed: boolean; updated?: number }>(TOKEN_USAGE_BACKFILL_KEY);
        if (migrated?.completed) {
            return { updated: migrated.updated || 0, sessionUpdated: 0, skipped: true };
        }

        const rows = this.db.prepare(`
      SELECT id, provider, model, input_tokens, output_tokens, total_tokens, cached_tokens,
             billable_input_tokens, cache_read_tokens, cache_write_tokens,
             openai_cached, anthropic_cache_read, anthropic_cache_create
      FROM token_usage
      WHERE billable_input_tokens = 0
        AND cache_read_tokens = 0
        AND cache_write_tokens = 0
        AND (input_tokens > 0 OR cached_tokens > 0 OR total_tokens > output_tokens)
    `).all() as Array<{
            id: string;
            provider: string;
            model: string;
            input_tokens: number;
            output_tokens: number;
            total_tokens: number;
            cached_tokens: number;
            billable_input_tokens: number;
            cache_read_tokens: number;
            cache_write_tokens: number;
            openai_cached: number;
            anthropic_cache_read: number;
            anthropic_cache_create: number;
        }>;

        const detectFlavor = (provider: string, model: string): 'anthropic' | 'openai' | 'generic' => {
            const text = `${provider} ${model}`.toLowerCase();
            if (text.includes('anthropic') || text.includes('claude')) return 'anthropic';
            if (text.includes('openai') || text.includes('gpt') || text.includes('o1') || text.includes('o3') || text.includes('o4') || text.includes('kimi') || text.includes('doubao')) {
                return 'openai';
            }
            return 'generic';
        };

        const update = this.db.prepare(`
      UPDATE token_usage
      SET input_tokens = ?,
          billable_input_tokens = ?,
          cache_read_tokens = ?,
          cache_write_tokens = ?,
          openai_cached = ?,
          anthropic_cache_read = ?,
          anthropic_cache_create = ?
      WHERE id = ?
    `);

        const updateSessionContext = this.db.prepare(`
      UPDATE sessions
      SET context_used = ?
      WHERE id = ? AND COALESCE(context_used, 0) < ?
    `);

        this.db.transaction(() => {
            for (const row of rows) {
                const legacyBillableInput = row.input_tokens || 0;
                const contextInput = Math.max(0, (row.total_tokens || 0) - (row.output_tokens || 0));
                const cacheRead = row.cached_tokens || 0;
                const inferredCacheWrite = Math.max(0, contextInput - legacyBillableInput - cacheRead);
                const normalizedInput = contextInput > 0 ? contextInput : legacyBillableInput;
                const flavor = detectFlavor(row.provider, row.model);

                update.run(
                    normalizedInput,
                    legacyBillableInput,
                    cacheRead,
                    inferredCacheWrite,
                    flavor === 'openai' ? cacheRead : (row.openai_cached || 0),
                    flavor === 'anthropic' ? cacheRead : (row.anthropic_cache_read || 0),
                    flavor === 'anthropic' ? inferredCacheWrite : (row.anthropic_cache_create || 0),
                    row.id,
                );
            }

            const sessionRows = this.db.prepare(`
        SELECT session_id, MAX(total_tokens) AS max_total_tokens
        FROM token_usage
        WHERE session_id IS NOT NULL AND session_id != '' AND request_type = 'chat'
        GROUP BY session_id
      `).all() as Array<{ session_id: string; max_total_tokens: number }>;

            for (const sessionRow of sessionRows) {
                const maxTotalTokens = sessionRow.max_total_tokens || 0;
                if (maxTotalTokens <= 0) continue;
                updateSessionContext.run(maxTotalTokens, sessionRow.session_id, maxTotalTokens);
            }
        })();

        this.setAppState(TOKEN_USAGE_BACKFILL_KEY, {
            completed: true,
            completedAt: Date.now(),
            updated: rows.length,
        });

        const sessionUpdated = (this.db.prepare(`
      SELECT COUNT(*) AS c
      FROM sessions s
      WHERE EXISTS (
        SELECT 1 FROM token_usage tu
        WHERE tu.session_id = s.id
          AND tu.request_type = 'chat'
          AND tu.total_tokens = s.context_used
      )
    `).get() as CountRow | undefined)?.c || 0;

        return { updated: rows.length, sessionUpdated, skipped: false };
    }

    // ==================== Team Sessions (Team P2 team_run) ====================
    /* team_sessions 表由 SCHEMA_V3_SQL 建立 (runtime/store/schema.ts), 字段与
     * TEAM_MODE_DESIGN §3.3/§8 一一对应: leader_id / member_ids / blackboard / mission_graph。
     * 这里只提供 team_run 工具需要的最小读写: 整行 upsert + 按 team_id 读回。 */

    upsertTeamSession(record: TeamSessionRecord): void {
        const now = Date.now();
        this.stmt(
            `INSERT INTO team_sessions (
               team_id, workspace_path, session_id, goal, mode, status,
               leader_id, member_ids, blackboard, mission_graph, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(team_id) DO UPDATE SET
               workspace_path=excluded.workspace_path,
               session_id=excluded.session_id,
               goal=excluded.goal,
               mode=excluded.mode,
               status=excluded.status,
               leader_id=excluded.leader_id,
               member_ids=excluded.member_ids,
               blackboard=excluded.blackboard,
               mission_graph=excluded.mission_graph,
               updated_at=excluded.updated_at`
        ).run(
            record.teamId,
            record.workspacePath,
            record.sessionId,
            record.goal,
            record.mode ?? null,
            record.status,
            record.leaderId ?? null,
            JSON.stringify(record.memberIds ?? []),
            record.blackboard ?? null,
            record.missionGraph ?? null,
            record.createdAt ?? now,
            record.updatedAt ?? now,
        );
    }

    getTeamSession(teamId: string): TeamSessionRecord | null {
        const row = this.stmt('SELECT * FROM team_sessions WHERE team_id = ?').get(teamId) as any;
        if (!row) return null;
        return {
            teamId: row.team_id,
            workspacePath: row.workspace_path,
            sessionId: row.session_id,
            goal: row.goal,
            mode: row.mode ?? null,
            status: row.status,
            leaderId: row.leader_id ?? null,
            memberIds: this.safeJsonParse(row.member_ids, []) as string[],
            blackboard: row.blackboard ?? null,
            missionGraph: row.mission_graph ?? null,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        };
    }

    deleteTeamSessionsBySession(sessionId: string): number {
        const r = this.stmt('DELETE FROM team_sessions WHERE session_id = ?').run(sessionId) as any;
        return Number(r?.changes ?? 0);
    }

    /** 一个会话的最新 Team (团队规划看板重建用 —— 内存 store 一刷新就空, 得能从库里捞回来) */
    getLatestTeamSessionBySession(sessionId: string): TeamSessionRecord | null {
        const row = this.stmt(
            'SELECT team_id FROM team_sessions WHERE session_id = ? ORDER BY updated_at DESC LIMIT 1',
        ).get(sessionId) as { team_id?: string } | undefined;
        return row?.team_id ? this.getTeamSession(row.team_id) : null;
    }

    // ==================== App State (KV Store) ====================

    getAppState<T = any>(key: string, defaultValue?: T): T | undefined {
        const row = this.stmt('SELECT value FROM app_state WHERE key = ?').get(key) as AppStateRow | undefined;
        if (!row) return defaultValue;
        return this.safeJsonParse(row.value, defaultValue) as T;
    }

    setAppState(key: string, value: any): void {
        this.stmt(
            'INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)'
        ).run(key, JSON.stringify(value));
    }

    deleteAppState(key: string): void {
        this.stmt('DELETE FROM app_state WHERE key = ?').run(key);
    }

    // ==================== 工具方法 ====================

    private safeJsonParse(str: string | null | undefined, fallback: any): any {
        if (!str) return fallback;
        try {
            return JSON.parse(str);
        } catch {
            return fallback;
        }
    }

    /**
     * 获取数据库文件大小（KB）
     */
    getDatabaseSize(): number {
        try {
            const dbPath = this.db.name;
            const stat = fs.statSync(dbPath);
            return Math.round(stat.size / 1024);
        } catch {
            return 0;
        }
    }

    /**
     * 执行 VACUUM 压缩数据库
     */
    vacuum(): void {
        this.db.exec('VACUUM');
    }

    /**
     * 关闭数据库连接
     */
    close(): void {
        if (this.walCheckpointTimer) {
            clearInterval(this.walCheckpointTimer);
            this.walCheckpointTimer = null;
        }
        if (this.integrityTimer) {
            /* 没拆它的话, 自检会在 db.close() 之后才醒来, 对着关掉的连接 prepare */
            clearTimeout(this.integrityTimer);
            this.integrityTimer = null;
        }
        this.stmtCache.clear();
        this.db.close();
    }

    /**
     * 获取底层 better-sqlite3 实例（仅用于迁移等特殊场景）
     */
    getRawDb(): Database.Database {
        return this.db;
    }
}

// ==================== 单例 ====================

let _instance: NeoxDatabase | null = null;

export function getDatabase(): NeoxDatabase {
    if (!_instance) {
        _instance = new NeoxDatabase();
        (globalThis as any).__NEOX_DB__ = _instance;
    }
    return _instance;
}

export function closeDatabase(): void {
    if (_instance) {
        _instance.close();
        _instance = null;
    }
}



export interface MigrateAnonymousResult {
  /** 是否真的迁移了 (false = 没匿名数据 / 失败) */
  migrated: boolean;
  /** session 数量 — toast 显示用 */
  sessionCount: number;
  /** 走的路径: 'rename' = fast / 'merge' = slow / 'noop' = 没数据 / 'failed' = 错 */
  mode: 'rename' | 'merge' | 'noop' | 'failed';
  /** failed 时的原因 */
  error?: string;
}

export function migrateAnonymousDbToUser(targetUserId: string): MigrateAnonymousResult {
  void targetUserId;
  return { migrated: false, sessionCount: 0, mode: 'noop' };
}
