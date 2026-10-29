import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  orderAttachKeys,
  peekLooksLikePlaintextSqliteFile,
  sqlcipherAttachKeyClause,
} from './databasePerUserMigrate.js';


const _require = createRequire(import.meta.url);

export type DbBackupKind = 'encrypted' | 'plaintext';

export type DbBackupInfo = {
  path: string;
  kind: DbBackupKind;
  ts: number;
};

export type CandidateProbe = {
  /** 有候选 key 能完整读出 quick_check=ok。 */
  ok: boolean;
  /** 实际打开用的 key; null = 明文。 */
  keyHex: string | null;
  plaintext: boolean;
  sessions: number;
  integrity: 'ok' | 'damaged' | 'unreadable';
  error: string;
};

export type SalvageResult = {
  totalRows: number;
  tables: Record<string, number>;
  failedTables: string[];
};

const BACKUP_RE = /^(.*)\.(encrypted|plaintext)-backup\.(\d+)$/;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? '');
}

/** 真损坏 (页级 / 结构级) 的错误串。 */
export function isCorruptionError(message: string): boolean {
  return /corrupt|malformed|not a database|unsupported file format|invalid file format|database schema has changed|file is encrypted/i.test(message);
}

/**
 * 只表示"文件头 / key 认不出"的错误 —— 加密库拿错 key 时报的就是这句。
 * 这类错误不能单独当作"文件损坏"的依据。
 */
export function isHeaderLevelDbError(message: string): boolean {
  return /not a database|unsupported file format|invalid file format|file is encrypted/i.test(message)
    && !/malformed|corrupt/i.test(message);
}

function loadSqliteClass(): any {
  try {
    return _require('better-sqlite3-multiple-ciphers');
  } catch {
    try { return _require('better-sqlite3'); } catch { /* 没装 */ }
  }
  throw new Error('no sqlite driver available (better-sqlite3 / multiple-ciphers)');
}

/** 列出 `neox-cli.db.encrypted-backup.<ts>` / `.plaintext-backup.<ts>`，新的在前。 */
export function listDatabaseBackups(dbPath: string): DbBackupInfo[] {
  const dir = path.dirname(dbPath);
  const base = path.basename(dbPath);
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out: DbBackupInfo[] = [];
  for (const name of names) {
    const m = BACKUP_RE.exec(name);
    if (!m || m[1] !== base) continue;
    const ts = Number(m[3]);
    if (!Number.isFinite(ts)) continue;
    out.push({ path: path.join(dir, name), kind: m[2] as DbBackupKind, ts });
  }
  out.sort((a, b) => b.ts - a.ts);
  return out;
}

/**
 * 用候选 key 们（含明文）打开并做一次 quick_check。
 * ok=true 表示这份文件是**可读且结构完整**的 —— 调用方可以据此决定"不动"或"可以恢复"。
 */
export function probeDatabaseWithCandidates(
  filePath: string,
  keyCandidates: Array<string | null>,
): CandidateProbe {
  const result: CandidateProbe = {
    ok: false,
    keyHex: null,
    plaintext: false,
    sessions: 0,
    integrity: 'unreadable',
    error: '',
  };
  if (!fs.existsSync(filePath)) {
    result.error = 'file not found';
    return result;
  }
  let Klass: any;
  try { Klass = loadSqliteClass(); } catch (err) { result.error = errorMessage(err); return result; }

  const unique: Array<string | null> = [];
  for (const key of keyCandidates) {
    if (!unique.includes(key)) unique.push(key);
  }
  if (unique.length === 0) unique.push(null);

  for (const key of unique) {
    let db: any = null;
    try {
      db = new Klass(filePath, { readonly: true, fileMustExist: true });
      if (key) db.pragma(`key = "x'${key}'"`);
      let damaged = false;
      try {
        const rows = db.pragma('quick_check(1)') as Array<Record<string, unknown>>;
        const values = rows.map((row) => String(Object.values(row)[0] ?? '').toLowerCase());
        damaged = values.some((value) => value !== 'ok');
      } catch (err) {
        result.integrity = 'damaged';
        result.error = errorMessage(err);
        continue;
      }
      if (damaged) {
        result.integrity = 'damaged';
        continue;
      }
      let sessions = 0;
      try {
        sessions = Number((db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as any)?.n ?? 0);
      } catch { /* 表不存在 (空壳库) 也算可读 */ }
      result.ok = true;
      result.keyHex = key;
      result.plaintext = key === null;
      result.sessions = sessions;
      result.integrity = 'ok';
      result.error = '';
      return result;
    } catch (err) {
      result.error = errorMessage(err);
    } finally {
      try { db?.close(); } catch { /* ignore */ }
    }
  }
  return result;
}

/**
 * 把坏库改名留档 (含 -wal/-shm)，返回留档路径。
 * 只在调用方已经确认"必须动文件"之后调用。
 */
export function quarantineDatabaseFile(dbPath: string, tag = 'broken', now = Date.now()): string {
  const dest = `${dbPath}.${tag}.${now}`;
  fs.renameSync(dbPath, dest);
  for (const suffix of ['-wal', '-shm'] as const) {
    const src = `${dbPath}${suffix}`;
    if (!fs.existsSync(src)) continue;
    try { fs.renameSync(src, `${dest}${suffix}`); } catch {
      try { fs.unlinkSync(src); } catch { /* ignore */ }
    }
  }
  return dest;
}

/**
 * 把一份已验证可读的备份复制回原路径（复制而不是改名: 备份留在原地, 下次还能用）。
 * 先写临时文件再原子 rename, 中途失败不会留下半个主库。
 */
export function restoreBackupAtomic(backupPath: string, dbPath: string): void {
  const tmp = `${dbPath}.restoring.${Date.now()}`;
  fs.copyFileSync(backupPath, tmp);
  try {
    const fd = fs.openSync(tmp, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch { /* ignore */ }
  for (const suffix of ['-wal', '-shm'] as const) {
    try { fs.unlinkSync(`${dbPath}${suffix}`); } catch { /* 不存在 */ }
  }
  fs.renameSync(tmp, dbPath);
}

function quoteIdent(value: string): string {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * 把 `sourcePath` 里**还能读出来的行**逐表搬进已经打开、schema 已就绪的 `dst`。
 *
 * 这是 sqlite `.recover` 的实用近似:
 *   · 先按 rowid 分段读 (坏页只毁掉一段, 其它段还能取)；
 *   · 每段失败就跳过继续, 不因一处坏页放弃整张表；
 *   · 列按名字取交集 (源库 schema 可能比当前版本旧/新)；
 *   · 外键先关, 缺父行也不阻塞。
 */
export function salvageIntoOpenDatabase(input: {
  dst: any;
  sourcePath: string;
  keyCandidates: Array<string | null>;
  chunkSize?: number;
  log?: (message: string) => void;
}): SalvageResult {
  const { dst, sourcePath } = input;
  const chunkSize = Math.max(1, input.chunkSize ?? 500);
  const log = input.log ?? (() => { /* silent */ });
  const result: SalvageResult = { totalRows: 0, tables: {}, failedTables: [] };

  const looksPlain = peekLooksLikePlaintextSqliteFile(sourcePath);
  const hexKeys = input.keyCandidates.filter((k): k is string => typeof k === 'string' && k.length > 0);
  const attachKeys = orderAttachKeys(looksPlain, hexKeys);

  let attached = false;
  let lastError = '';
  for (const key of attachKeys) {
    try {
      dst.exec(`ATTACH DATABASE ${sqlString(sourcePath)} AS bad${sqlcipherAttachKeyClause(key)}`);
      dst.prepare("SELECT name FROM bad.sqlite_master WHERE type='table' LIMIT 1").get();
      attached = true;
      break;
    } catch (err) {
      lastError = errorMessage(err);
      try { dst.exec('DETACH DATABASE bad'); } catch { /* ignore */ }
    }
  }
  if (!attached) {
    log(`无法读取损坏库 (${lastError || 'attach failed'}), 仅保留留档文件`);
    result.failedTables.push('<attach>');
    return result;
  }

  let tables: Array<{ name: string }> = [];
  try {
    tables = dst.prepare(
      "SELECT name FROM bad.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid",
    ).all() as Array<{ name: string }>;
  } catch (err) {
    log(`读取损坏库的表清单失败: ${errorMessage(err)}`);
    result.failedTables.push('<sqlite_master>');
    try { dst.exec('DETACH DATABASE bad'); } catch { /* ignore */ }
    return result;
  }

  /* `_schema_version` 没有主键, 直接把旧行插进新库会变成两行, 下一次启动读到哪个版本
   * 全看查询顺序 —— 抢救的是用户数据, 版本号必须由当前进程重建。 */
  tables = tables.filter((t) => t.name !== '_schema_version');

  try { dst.pragma('foreign_keys = OFF'); } catch { /* ignore */ }
  try {
    for (const { name } of tables) {
      const target = quoteIdent(name);
      let mainCols: string[] = [];
      try {
        mainCols = (dst.prepare(`PRAGMA main.table_info(${target})`).all() as Array<{ name: string }>)
          .map((r) => r.name);
      } catch { /* 目标里没这张表 → 跳过 */ }
      if (mainCols.length === 0) {
        result.failedTables.push(name);
        continue;
      }
      let srcCols: string[] = [];
      try {
        srcCols = (dst.prepare(`PRAGMA bad.table_info(${target})`).all() as Array<{ name: string }>)
          .map((r) => r.name);
      } catch (err) {
        log(`表 ${name} 的列信息读不出: ${errorMessage(err)}`);
        result.failedTables.push(name);
        continue;
      }
      const cols = srcCols.filter((c) => mainCols.includes(c));
      if (cols.length === 0) {
        result.failedTables.push(name);
        continue;
      }
      const colList = cols.map(quoteIdent).join(', ');
      let inserted = 0;
      let ranged = false;
      try {
        const range = dst.prepare(`SELECT min(rowid) AS lo, max(rowid) AS hi FROM bad.${target}`).get() as
          { lo?: number; hi?: number } | undefined;
        const lo = Number(range?.lo);
        const hi = Number(range?.hi);
        if (Number.isFinite(lo) && Number.isFinite(hi) && hi >= lo) {
          ranged = true;
          for (let start = lo; start <= hi; start += chunkSize) {
            try {
              const info = dst.prepare(
                `INSERT OR IGNORE INTO main.${target} (${colList}) ` +
                `SELECT ${colList} FROM bad.${target} WHERE rowid BETWEEN ? AND ?`,
              ).run(start, start + chunkSize - 1);
              inserted += Number((info as any)?.changes ?? 0);
            } catch { /* 这一段撞上坏页 → 跳过, 继续下一段 */ }
          }
        }
      } catch { /* 没有 rowid (WITHOUT ROWID 表) / 范围读不出 */ }

      if (!ranged) {
        try {
          const info = dst.prepare(
            `INSERT OR IGNORE INTO main.${target} (${colList}) SELECT ${colList} FROM bad.${target}`,
          ).run();
          inserted += Number((info as any)?.changes ?? 0);
        } catch (err) {
          log(`表 ${name} 整表抢救失败: ${errorMessage(err)}`);
          result.failedTables.push(name);
          continue;
        }
      }

      result.tables[name] = inserted;
      result.totalRows += inserted;
      if (inserted > 0) log(`表 ${name} 抢救出 ${inserted} 行`);
    }
  } finally {
    try { dst.pragma('foreign_keys = ON'); } catch { /* ignore */ }
    try { dst.exec('DETACH DATABASE bad'); } catch { /* ignore */ }
  }

  return result;
}
