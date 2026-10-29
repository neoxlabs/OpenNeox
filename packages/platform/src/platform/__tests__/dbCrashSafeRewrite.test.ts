import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { atomicReplaceDatabaseFile, encryptPlaintextDb, rewriteDbWithKey, sweepStaleEncryptingTemps } from '../databaseCipherRewrite.js';
import { listDatabaseBackups } from '../dbRecovery.js';

const _require = createRequire(import.meta.url);
const Klass = _require('better-sqlite3-multiple-ciphers');
const KEY = '11'.repeat(32);


let dir: string | null = null;

afterEach(() => {
  if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } dir = null; }
});

function makePlainDb(filePath: string, rows = 3): void {
  const db: any = new Klass(filePath);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE sessions (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
  const insert = db.prepare('INSERT INTO sessions (name) VALUES (?)');
  for (let i = 0; i < rows; i++) insert.run(`session-${i}`);
  /* 故意不 checkpoint: WAL 里留着 frame, 这正是旧实现会挂错 WAL 的场景 */
  db.close();
}

function countWithKey(filePath: string, keyHex: string | null, table = 'sessions'): number {
  const db: any = new Klass(filePath, { readonly: true });
  try {
    if (keyHex) db.pragma(`key = "x'${keyHex}'"`);
    return Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as any)?.n ?? 0);
  } finally {
    db.close();
  }
}

describe('rewriteDbWithKey (明文 → 加密)', () => {
  it('原子替换: 清掉旧 WAL/SHM, 原路径可读, 备份可读', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-dbswap-'));
    const dbPath = path.join(dir, 'neox.db');
    const tmpPath = path.join(dir, 'replacement.db');
    const backupPath = path.join(dir, 'neox.db.plaintext-backup.1700000000000');
    makePlainDb(dbPath, 3);
    makePlainDb(tmpPath, 7);

    fs.writeFileSync(`${dbPath}-wal`, Buffer.alloc(0));
    fs.writeFileSync(`${dbPath}-shm`, Buffer.alloc(32 * 1024));

    atomicReplaceDatabaseFile(dbPath, tmpPath, backupPath);

    expect(fs.existsSync(dbPath)).toBe(true);
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
    expect(fs.existsSync(`${dbPath}-shm`)).toBe(false);
    expect(countWithKey(dbPath, null)).toBe(7);
    expect(countWithKey(backupPath, null)).toBe(3);
  });

  it('整库加密后备份可读、数据完整', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-dbswap-'));
    const dbPath = path.join(dir, 'neox.db');
    makePlainDb(dbPath, 3);

    const result = encryptPlaintextDb(dbPath, KEY, { skipInUseCheck: true, now: 1700000000000 });

    expect(fs.existsSync(dbPath)).toBe(true);
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
    expect(fs.existsSync(`${dbPath}-shm`)).toBe(false);
    expect(countWithKey(dbPath, KEY)).toBe(3);
    /* 备份留着用户的原始数据, 且是明文可读的 */
    expect(result.backupPath).toBe(`${dbPath}.plaintext-backup.1700000000000`);
    expect(countWithKey(result.backupPath, null)).toBe(3);
  });

  it('替换前抛错 (模拟进程中途死) → 原库内容不变、仍可打开; 残留临时文件可被清扫', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-dbswap-'));
    const dbPath = path.join(dir, 'neox.db');
    makePlainDb(dbPath, 5);
    const before = fs.readFileSync(dbPath);

    expect(() => rewriteDbWithKey({
      srcPath: dbPath,
      srcKeyHex: null,
      dstKeyHex: KEY,
      now: 1700000000001,
      skipInUseCheck: true,
      beforeSwap: () => { throw new Error('killed before swap'); },
    })).toThrow('killed before swap');

    /* 原路径还在, 内容一模一样, 行数没少 */
    expect(fs.readFileSync(dbPath)).toEqual(before);
    expect(countWithKey(dbPath, null)).toBe(5);
    /* 模拟崩溃留下的半成品: 一小时后启动时被扫掉 */
    expect(sweepStaleEncryptingTemps(dbPath, 1700000000001 + 2 * 60 * 60_000)).toEqual([
      `neox.db.encrypting.1700000000001`,
    ]);
    expect(fs.existsSync(`${dbPath}.encrypting.1700000000001`)).toBe(false);
  });

  it('旧 .encrypting 残留不会挡住下一次迁移, 新备份能进备份清单', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-dbswap-'));
    const dbPath = path.join(dir, 'neox.db');
    makePlainDb(dbPath, 2);
    fs.writeFileSync(`${dbPath}.encrypting.${Date.now()}`, 'garbage');

    const result = encryptPlaintextDb(dbPath, KEY, { skipInUseCheck: true, now: Date.now() + 1 });
    expect(countWithKey(dbPath, KEY)).toBe(2);
    const backups = listDatabaseBackups(dbPath);
    expect(backups.some((b) => b.path === result.backupPath && b.kind === 'plaintext')).toBe(true);
  });
});
