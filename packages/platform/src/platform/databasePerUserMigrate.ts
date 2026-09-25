import fs from 'node:fs';
import path from 'node:path';

/**
 * per-user → 全局库迁移。
 *
 * 迁移是幂等的：逐个附加遗留库并合并，成功后把源文件改名退役；失败的源文件保留
 * 为带状态后缀的文件，完成标记只在所有源文件处理成功后写入。进程中断后再次启动
 * 可以继续处理，不会重复合并或覆盖活动库。
 *
 * 活动库不复制。与活动库大小和明文/密文形态相同的文件视为冗余克隆并直接退役；
 * 其它 per-user 库才进入合并流程。启动时也会清理旧迁移克隆，避免无效快照长期保留。
 *
 * SQLCipher 将明文库附加到加密连接时必须显式使用 `KEY ''`；省略 KEY 会按主库密钥
 * 处理，无法读取明文附件。
 * https://www.zetetic.net/sqlcipher/sqlcipher-api/#attach
 */

export type AttachKey = string | null;

/** `null` = 省略 KEY (继承主库, 密文附件); `''` = 明文附件; 其它 = hex 主密钥. */
export function sqlcipherAttachKeyClause(key: AttachKey): string {
  if (key === null) return '';
  if (key === '') return " KEY ''";
  return ` KEY "x'${key}'"`;
}

export function looksLikePlaintextSqliteHeader(bytes: Uint8Array): boolean {
  if (bytes.length < 15) return false;
  let s = '';
  for (let i = 0; i < 15; i++) s += String.fromCharCode(bytes[i]!);
  return s === 'SQLite format 3';
}

export function peekLooksLikePlaintextSqliteFile(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(16);
      const n = fs.readSync(fd, buf, 0, 16, 0);
      return n >= 15 && looksLikePlaintextSqliteHeader(buf.subarray(0, n));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/**
 * 明文头优先试空密钥, 密文头优先试派生 key。两种都把另一种当兜底,
 * 避免「头看走眼」时少试一条路。
 */
export function orderAttachKeys(looksPlaintext: boolean, cipherHexKeys: string[]): AttachKey[] {
  const uniqueHex = [...new Set(cipherHexKeys.filter((k) => k.length > 0))];
  if (looksPlaintext) return ['', ...uniqueHex, null];
  return [...uniqueHex, '', null];
}

/** ATTACH / 读 sqlite_master 在 key 不对或附件是明文时的典型失败. */
export function isUnreadableAttachedDbError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /not a database|SQLITE_NOTADB|file is encrypted|unsupported file format|invalid file format|cipher/i.test(msg);
}

export const PER_USER_MIGRATE_MARKER = '.migrated_db_to_global_v2';
export const PRE_MIGRATE_CLONE_NAME = /^neox(-cli)?\.db\.pre-migrate-\d+(-wal|-shm)?$/;

export function isPreMigrateCloneName(name: string): boolean {
  return PRE_MIGRATE_CLONE_NAME.test(name);
}

export function listPerUserLeftoverDbPaths(configDir: string): string[] {
  const usersDir = path.join(configDir, 'users');
  try {
    if (!fs.existsSync(usersDir)) return [];
    return fs.readdirSync(usersDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((bucket) => path.join(usersDir, bucket.name, 'neox.db'))
      .filter((dbPath) => fs.existsSync(dbPath));
  } catch {
    return [];
  }
}

export function sweepRedundantPreMigrateClones(configDir: string): { removed: number } {
  let removed = 0;
  let names: string[] = [];
  try { names = fs.readdirSync(configDir); } catch { return { removed: 0 }; }
  for (const name of names) {
    if (!isPreMigrateCloneName(name)) continue;
    try {
      fs.unlinkSync(path.join(configDir, name));
      removed += 1;
    } catch { /* 活库锁 / 已删 */ }
  }
  return { removed };
}

export type LeftoverClass = 'merge' | 'redundant-live-clone';
export type LeftoverRetireKind = 'merged' | 'unreadable' | 'redundant';

/** 同体积且同明文/密文形态 = 活库克隆, 合进去等于自己 ATTACH 自己. 明文小库对密文大库必须 merge. */
export function classifyLeftoverAgainstLive(input: {
  leftoverSize: number;
  leftoverPlaintext: boolean;
  liveSize: number;
  livePlaintext: boolean;
}): LeftoverClass {
  if (
    input.leftoverSize > 0
    && input.liveSize > 0
    && input.leftoverSize === input.liveSize
    && input.leftoverPlaintext === input.livePlaintext
  ) {
    return 'redundant-live-clone';
  }
  return 'merge';
}

export function leftoverRetirePath(sourcePath: string, kind: LeftoverRetireKind, ts = Date.now()): string {
  return `${sourcePath}.${kind}-${ts}`;
}

export function retireLeftoverDbFile(sourcePath: string, kind: LeftoverRetireKind, ts = Date.now()): string {
  const dest = leftoverRetirePath(sourcePath, kind, ts);
  try {
    fs.renameSync(sourcePath, dest);
  } catch {
    try { fs.unlinkSync(sourcePath); } catch { /* 留着, 有 marker 后下次退役 */ }
  }
  for (const suffix of ['-wal', '-shm'] as const) {
    const side = sourcePath + suffix;
    try {
      if (!fs.existsSync(side)) continue;
      try { fs.renameSync(side, dest + suffix); } catch { fs.unlinkSync(side); }
    } catch { /* ignore */ }
  }
  return dest;
}

export type PerUserMigrateResult = {
  picked: string | null;
  sessions: number;
  dbFiles: number;
  failedDbFiles: number;
  swept: number;
};

export function runPerUserDbToGlobalMigrate(ctx: {
  configDir: string;
  globalDbPath: string;
  closeDatabase: () => void;
  openGlobal: () => { getRawDb: () => any; close: () => void };
  attachSource: (dst: any, sourcePath: string) => void;
  mergeAttached: (dst: any) => number;
}): PerUserMigrateResult {
  const markerFile = path.join(ctx.configDir, PER_USER_MIGRATE_MARKER);
  const result: PerUserMigrateResult = {
    picked: null,
    sessions: 0,
    dbFiles: 0,
    failedDbFiles: 0,
    swept: sweepRedundantPreMigrateClones(ctx.configDir).removed,
  };

  const writeMarker = (): void => {
    try {
      fs.mkdirSync(ctx.configDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(markerFile, new Date().toISOString(), { mode: 0o600 });
    } catch { /* 下次再写 */ }
  };

  let markerPresent = false;
  try { markerPresent = fs.existsSync(markerFile); } catch { /* ignore */ }

  /* marker 已在: 数据合过了. leftover 若还叫 neox.db, 只退役不重复合. */
  if (markerPresent) {
    for (const leftover of listPerUserLeftoverDbPaths(ctx.configDir)) {
      retireLeftoverDbFile(leftover, 'merged');
    }
    return result;
  }

  const sources = listPerUserLeftoverDbPaths(ctx.configDir);
  if (sources.length === 0) {
    writeMarker();
    return result;
  }

  ctx.closeDatabase();
  let liveSize = 0;
  try { liveSize = fs.statSync(ctx.globalDbPath).size; } catch { /* 没有活库也继续合 */ }
  const livePlain = peekLooksLikePlaintextSqliteFile(ctx.globalDbPath);

  const handle = ctx.openGlobal();
  const dst = handle.getRawDb();
  try {
    dst.pragma('foreign_keys = OFF');
    for (const sourcePath of sources) {
      let leftoverSize = 0;
      try { leftoverSize = fs.statSync(sourcePath).size; } catch { continue; }
      const leftoverPlain = peekLooksLikePlaintextSqliteFile(sourcePath);
      const kind = classifyLeftoverAgainstLive({
        leftoverSize,
        leftoverPlaintext: leftoverPlain,
        liveSize,
        livePlaintext: livePlain,
      });
      if (kind === 'redundant-live-clone') {
        retireLeftoverDbFile(sourcePath, 'redundant');
        continue;
      }
      let attached = false;
      try {
        ctx.attachSource(dst, sourcePath);
        attached = true;
        const inserted = ctx.mergeAttached(dst);
        if (inserted >= 0) {
          result.sessions += inserted;
          result.dbFiles += 1;
          result.picked = result.picked ?? sourcePath;
        }
        retireLeftoverDbFile(sourcePath, 'merged');
      } catch (err) {
        if (isUnreadableAttachedDbError(err)) {
          retireLeftoverDbFile(sourcePath, 'unreadable');
        } else {
          result.failedDbFiles += 1;
        }
      } finally {
        if (attached) {
          try { dst.exec('DETACH DATABASE src'); } catch { /* ignore */ }
        }
      }
    }
  } finally {
    try { dst.pragma('foreign_keys = ON'); } catch { /* ignore */ }
    handle.close();
  }

  if (result.failedDbFiles === 0) writeMarker();
  return result;
}
