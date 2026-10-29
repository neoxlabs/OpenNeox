import fs from 'node:fs';
import path from 'node:path';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { acquireDbOpenLock, DbOpenLockTimeoutError } from './dbOpenLock.js';
import {
  decryptDbToPlaintext,
  encryptPlaintextDb,
  sweepStaleEncryptingTemps,
} from './databaseCipherRewrite.js';
import { isDbFileInUseByOthers } from './dbFileInUse.js';


export type PrepareDatabaseDeps = {
  dbPath: string;
  encryptionEnabled: boolean;
  hasSqlcipher: boolean;
  masterKeyHex: string | null;
  /** better-sqlite3 / multi-ciphers 的构造器。 */
  dbClass: any;
  nativeBinding?: string;
  cipherNativeBinding?: string;
  /** 默认 dbFileInUse.isDbFileInUseByOthers; 单测可注入。 */
  isInUseByOthers?: (dbPath: string) => boolean;
  lockTimeoutMs?: number;
};

export type PrepareDatabaseResult = {
  /** true = 这一次不能套 key, 按明文打开。 */
  openAsPlaintext: boolean;
};

function probeIsPlaintext(deps: PrepareDatabaseDeps): boolean {
  try {
    const opts: any = { readonly: true };
    if (deps.nativeBinding) opts.nativeBinding = deps.nativeBinding;
    const probe = new deps.dbClass(deps.dbPath, opts);
    try {
      probe.prepare('SELECT name FROM sqlite_master LIMIT 1').get();
      return true;
    } finally {
      try { probe.close(); } catch { /* ignore */ }
    }
  } catch {
    /* 不能裸读 = 已加密 (或损坏, 交给 corruption 路径) */
    return false;
  }
}

export function prepareDatabaseFileForOpen(deps: PrepareDatabaseDeps): PrepareDatabaseResult {
  const out: PrepareDatabaseResult = { openAsPlaintext: false };
  if (!deps.encryptionEnabled || !deps.hasSqlcipher) return out;

  try {
    const swept = sweepStaleEncryptingTemps(deps.dbPath);
    if (swept.length) cliLogger.info('DATABASE', `swept ${swept.length} stale .encrypting temp file(s)`);
  } catch { /* 扫不动不影响启动 */ }

  const hex = deps.masterKeyHex;
  if (!hex || !fs.existsSync(deps.dbPath)) return out;

  const inUse = (): boolean => (deps.isInUseByOthers ?? isDbFileInUseByOthers)(deps.dbPath);

  const sharedWithBunCli = path.basename(deps.dbPath).startsWith('neox-cli');
  let dbIsPlaintext = probeIsPlaintext(deps);

  if (dbIsPlaintext && (sharedWithBunCli || inUse())) {
    out.openAsPlaintext = true;
    cliLogger.info(
      'DATABASE',
      `plaintext db kept as plaintext (${sharedWithBunCli ? 'shared with bun CLI' : 'in use by another process'}): ${deps.dbPath}`,
    );
    return out;
  }
  if (!dbIsPlaintext && !sharedWithBunCli) {
    /* 加密库 + 非 CLI 库: 本来就应该加密, 无需改写 */
    return out;
  }

  const needDecrypt = !dbIsPlaintext && sharedWithBunCli;
  const needEncrypt = dbIsPlaintext && !sharedWithBunCli;
  if (!needDecrypt && !needEncrypt) return out;

  /* 只有真要改文件才取锁。没拿锁时探测结果可能已经过时 —— 下面在锁内重探。 */
  let release: (() => void) | null = null;
  try {
    release = acquireDbOpenLock(deps.dbPath, {
      timeoutMs: deps.lockTimeoutMs ?? 30_000,
      note: needDecrypt ? 'decrypt-cli-db' : 'encrypt-db',
    });
    dbIsPlaintext = probeIsPlaintext(deps);

    if (needDecrypt) {
      if (dbIsPlaintext) {
        cliLogger.info('DATABASE', 'another process already decrypted the CLI db, nothing to do');
        return out;
      }
      if (inUse()) {
        cliLogger.info('DATABASE', `encrypted CLI db in use by another process, leaving it encrypted this time: ${deps.dbPath}`);
        return out;
      }
      decryptDbToPlaintext(deps.dbPath, hex, { cipherNativeBinding: deps.cipherNativeBinding });
      out.openAsPlaintext = true;
      cliLogger.info('DATABASE', `encrypted CLI db decrypted to plaintext (shared with bun CLI): ${deps.dbPath}`);
      return out;
    }

    /* needEncrypt */
    if (!dbIsPlaintext) {
      cliLogger.info('DATABASE', 'another process already encrypted the db, nothing to do');
      return out;
    }
    if (inUse()) {
      out.openAsPlaintext = true;
      cliLogger.info('DATABASE', `plaintext db in use by another process, keeping plaintext this time: ${deps.dbPath}`);
      return out;
    }
    cliLogger.info('DATABASE', `plaintext db detected, encrypting in-place at ${deps.dbPath}`);
    encryptPlaintextDb(deps.dbPath, hex, { cipherNativeBinding: deps.cipherNativeBinding });
    cliLogger.info('DATABASE', 'encryption migration succeeded');
    return out;
  } catch (err: any) {
    if (err instanceof DbOpenLockTimeoutError) throw err;
    if (needEncrypt) {
      out.openAsPlaintext = true;
      cliLogger.error('DATABASE', `encryption migration FAILED, opening as plaintext this time: ${err?.message ?? err}`);
    } else {
      cliLogger.warn('DATABASE', `decrypting CLI db failed, opening it encrypted: ${err?.message ?? err}`);
    }
    return out;
  } finally {
    try { release?.(); } catch { /* ignore */ }
  }
}
