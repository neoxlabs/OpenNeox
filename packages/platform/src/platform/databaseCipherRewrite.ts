import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { isDbFileInUseByOthers } from './dbFileInUse.js';


const _require = createRequire(import.meta.url);

export type RewriteDbOptions = {
  srcPath: string;
  /** null = 明文。 */
  srcKeyHex: string | null;
  /** null = 目标为明文。 */
  dstKeyHex: string | null;
  /** 与主库同源的 cipher 原生绑定 (dist/native/better_sqlite3_cipher.node)。 */
  cipherNativeBinding?: string;
  /** 时间戳 (可注入, 单测用)。 */
  now?: number;
  /** 单测注入: 替换文件之前调用, 抛错可模拟"迁移中途进程死掉"。 */
  beforeSwap?: (ctx: { srcPath: string; tmpPath: string; backupPath: string }) => void;
  /** 单测注入: 跳过"别的进程在用"检查。 */
  skipInUseCheck?: boolean;
  /** 覆盖日志 (默认 cliLogger)。 */
  log?: { info: (scope: string, msg: string) => void; warn?: (scope: string, msg: string) => void; error?: (scope: string, msg: string) => void };
};

export type RewriteDbResult = { backupPath: string; tmpPath: string };

const SUFFIXES = ['-wal', '-shm'] as const;

/** best-effort fsync: 掉电后 rename 出来的文件内容仍是完整的。 */
export function fsyncPath(filePath: string): void {
  try {
    const fd = fs.openSync(filePath, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch { /* 某些文件系统 / Windows 不支持, 忽略 */ }
}

function fsyncDirectory(dirPath: string): void {
  try {
    const fd = fs.openSync(dirPath, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch { /* Windows 打不开目录, 忽略 */ }
}

/** 删掉某条路径对应的 WAL/SHM。 */
export function removeDbSidecars(dbPath: string): void {
  for (const suffix of SUFFIXES) {
    try { fs.unlinkSync(`${dbPath}${suffix}`); } catch { /* 不存在就跳过 */ }
  }
}

/** 把 WAL/SHM 跟着主文件改名 —— 不改的话新主库会读到旧 WAL。 */
export function moveDbSidecars(fromPath: string, toPath: string): void {
  for (const suffix of SUFFIXES) {
    const src = `${fromPath}${suffix}`;
    if (!fs.existsSync(src)) continue;
    try { fs.renameSync(src, `${toPath}${suffix}`); } catch {
      try { fs.unlinkSync(src); } catch { /* ignore */ }
    }
  }
}

/**
 * 给原库留一份备份, 优先 hardlink (同 inode, 不额外占盘、瞬间完成)。
 * hardlink 不可用 (跨设备 / 某些文件系统) 时退回复制。
 */
function backupOriginal(srcPath: string, backupPath: string): void {
  try { fs.unlinkSync(backupPath); } catch { /* 没有最好 */ }
  try {
    fs.linkSync(srcPath, backupPath);
    return;
  } catch { /* 退化到复制 */ }
  fs.copyFileSync(srcPath, backupPath);
  fsyncPath(backupPath);
}

/**
 * 原子替换: 先备份原文件, 清掉旧 sidecar, 再**一次** rename 覆盖。
 * 任何中途失败都不会让原路径消失。
 */
export function atomicReplaceDatabaseFile(srcPath: string, tmpPath: string, backupPath: string): void {
  if (!fs.existsSync(tmpPath)) throw new Error(`replacement file missing: ${tmpPath}`);
  fsyncPath(tmpPath);
  backupOriginal(srcPath, backupPath);
  /* 旧库的 WAL/SHM 必须先离开这个路径。checkpoint 成功时它们是空的; 没清掉也不影响
   * 备份的完整性 (备份是主库文件的 inode), 但不能让新库继承它们。 */
  removeDbSidecars(srcPath);
  fs.renameSync(tmpPath, srcPath);
  removeDbSidecars(tmpPath);
  fsyncDirectory(path.dirname(srcPath));
}

/**
 * 原样搬运整库到新文件再原子替换: srcKey/dstKey 为 null 表示明文。
 *
 * 失败语义: 抛错 = 原文件一个字节都没动 (只有 .encrypting 临时文件可能残留, 启动时会清扫)。
 */
export function rewriteDbWithKey(opts: RewriteDbOptions): RewriteDbResult {
  const { srcPath, srcKeyHex, dstKeyHex } = opts;
  const log = opts.log ?? cliLogger;
  const now = opts.now ?? Date.now();
  const tmpPath = `${srcPath}.encrypting.${now}`;
  const backupPath = `${srcPath}.${srcKeyHex ? 'encrypted-backup' : 'plaintext-backup'}.${now}`;
  try { fs.unlinkSync(tmpPath); } catch { /* 不存在最好 */ }

  const Klass = _require('better-sqlite3-multiple-ciphers');
  const nb = opts.cipherNativeBinding;
  let plain: any;
  try {
    plain = nb ? new Klass(srcPath, { nativeBinding: nb }) : new Klass(srcPath);
    if (srcKeyHex) {
      plain.pragma(`key = "x'${srcKeyHex}'"`);
      plain.prepare('SELECT name FROM sqlite_master LIMIT 1').get();  /* key 不对在这里就抛, 不会往下拷空库 */
    }
    /* checkpoint 必须真的清空 WAL。别的连接还开着时它是 busy 而不是报错 ——
     * 这时候把主库文件换掉, 旧 WAL 会挂到新库上, 之后就是 malformed / not a database。 */
    try {
      const ck = plain.pragma('wal_checkpoint(TRUNCATE)');
      const busy = Array.isArray(ck) && ck.some((row: any) => Number(row?.busy) > 0);
      if (busy) throw new Error('WAL checkpoint is busy (another connection holds the database)');
    } catch (err: any) {
      if (/checkpoint is busy/.test(String(err?.message ?? err))) throw err;
      /* WAL 没开 / 老绑定不支持 —— 磁盘上本来就没有 WAL, 继续 */
    }
    try { plain.pragma('foreign_keys = OFF'); } catch { /* 老绑定不支持就算了 */ }

    plain.exec(`ATTACH DATABASE '${tmpPath.replace(/'/g, "''")}' AS enc KEY ${dstKeyHex ? `"x'${dstKeyHex}'"` : "''"}`);

    /* 复制 schema — 必须按 master 表 rowid 顺序 (表→索引→触发器→视图依赖关系正确) */
    const objs = plain.prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY rowid",
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
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as Array<{ name: string }>;
    for (const t of tables) {
      plain.exec(`INSERT INTO enc.${t.name} SELECT * FROM ${t.name}`);
    }
    plain.exec('DETACH DATABASE enc');
  } catch (err) {
    /* 失败就把半成品删掉 —— 不然每次启动留一份 (上面那 150 个就是这么来的) */
    try { plain?.close(); } catch { /* ignore */ }
    plain = null;
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    removeDbSidecars(tmpPath);
    throw err;
  } finally {
    try { plain?.close(); } catch { /* ignore */ }
  }

  /* 替换前再确认一次目标路径真能打开 (key 用错的话 ATTACH 出来的库是空的, 换上去等于丢数据) */
  try {
    const check: any = nb ? new Klass(tmpPath, { nativeBinding: nb }) : new Klass(tmpPath);
    try {
      if (dstKeyHex) {
        check.pragma(`key = "x'${dstKeyHex}'"`);
        check.prepare('SELECT name FROM sqlite_master LIMIT 1').get();
      }
    } finally {
      try { check.close(); } catch { /* ignore */ }
    }
  } catch (err: any) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    removeDbSidecars(tmpPath);
    throw new Error(`replacement database is not readable: ${err?.message ?? err}`);
  }

  if (!opts.skipInUseCheck && isDbFileInUseByOthers(srcPath)) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    removeDbSidecars(tmpPath);
    throw new Error(`database file is in use by another process, refusing to replace it: ${srcPath}`);
  }

  opts.beforeSwap?.({ srcPath, tmpPath, backupPath });
  atomicReplaceDatabaseFile(srcPath, tmpPath, backupPath);
  log.info('DATABASE', `db file replaced atomically; previous copy kept at ${backupPath} (人工确认无误后可删)`);
  return { backupPath, tmpPath };
}

/** 把指定路径上的明文 SQLite 文件迁成加密版本。 */
export function encryptPlaintextDb(
  plaintextPath: string,
  keyHex: string,
  extra: Omit<RewriteDbOptions, 'srcPath' | 'srcKeyHex' | 'dstKeyHex'> = {},
): RewriteDbResult {
  return rewriteDbWithKey({ ...extra, srcPath: plaintextPath, srcKeyHex: null, dstKeyHex: keyHex });
}

export function decryptDbToPlaintext(
  encryptedPath: string,
  keyHex: string,
  extra: Omit<RewriteDbOptions, 'srcPath' | 'srcKeyHex' | 'dstKeyHex'> = {},
): RewriteDbResult {
  return rewriteDbWithKey({ ...extra, srcPath: encryptedPath, srcKeyHex: keyHex, dstKeyHex: null });
}

/**
 * 清掉迁移留下的半成品 `<db>.encrypting.<ts>` (纯函数, 有单测)。
 * 退出时清理是优化, 启动时清扫才是保证 —— 迁移进程被杀 / 抛错都会留下这种文件, 只有启动时扫一遍
 * 才能把历史欠账收干净。只删够旧的 (默认 1 小时), 免得删到另一个正在迁移的进程的临时文件。
 * `.plaintext-backup.*` / `.encrypted-backup.*` 是用户数据的备份, **不碰**。
 */
export function sweepStaleEncryptingTemps(dbPath: string, now = Date.now(), olderThanMs = 60 * 60_000): string[] {
  const dir = path.dirname(dbPath);
  const base = path.basename(dbPath);
  const removed: string[] = [];
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return removed; }
  for (const name of names) {
    const m = name.startsWith(`${base}.encrypting.`) ? /\.encrypting\.(\d+)(?:-(?:wal|shm))?$/.exec(name) : null;
    if (!m) continue;
    const ts = Number(m[1]);
    if (!Number.isFinite(ts) || now - ts < olderThanMs) continue;
    try { fs.unlinkSync(path.join(dir, name)); removed.push(name); } catch { /* 删不掉下次再来 */ }
  }
  return removed;
}
