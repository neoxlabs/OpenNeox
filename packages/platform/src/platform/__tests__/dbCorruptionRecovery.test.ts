import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { NeoxDatabase } from '../database.js';
import { salvageIntoOpenDatabase } from '../dbRecovery.js';
import { clearDbInitFailure, getDbInitFailure } from '../dbInitFailure.js';

const _require = createRequire(import.meta.url);
const Klass = _require('better-sqlite3-multiple-ciphers');


let prevEncrypt: string | undefined;
let prevHome: string | undefined;
let prevNeoxHome: string | undefined;
let root: string | null = null;

beforeAll(() => {
  prevEncrypt = process.env.NEOX_DB_ENCRYPT;
  prevHome = process.env.HOME;
  prevNeoxHome = process.env.NEOX_HOME;
  process.env.NEOX_DB_ENCRYPT = '0';
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-dbrecover-'));
  process.env.NEOX_HOME = root;
});

afterAll(() => {
  if (prevEncrypt === undefined) delete process.env.NEOX_DB_ENCRYPT; else process.env.NEOX_DB_ENCRYPT = prevEncrypt;
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevNeoxHome === undefined) delete process.env.NEOX_HOME; else process.env.NEOX_HOME = prevNeoxHome;
  if (root) { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* noop */ } root = null; }
});

let caseDir: string | null = null;
afterEach(() => {
  if (caseDir) { try { fs.rmSync(caseDir, { recursive: true, force: true }); } catch { /* noop */ } caseDir = null; }
});

function newCaseDir(): string {
  caseDir = fs.mkdtempSync(path.join(root!, 'case-'));
  return caseDir;
}

function insertSession(dbPath: string, id: string): void {
  const db: any = new Klass(dbPath);
  try {
    db.prepare(
      'INSERT INTO sessions (id, name, model_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(id, id, 'm', Date.now(), Date.now());
  } finally {
    db.close();
  }
}

function sessionCount(dbPath: string): number {
  const db: any = new Klass(dbPath, { readonly: true });
  try {
    return Number((db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as any)?.n ?? 0);
  } finally {
    db.close();
  }
}

/** 破坏数据库第 1 页的正文 (保留 16 字节 "SQLite format 3" 头) —— 模拟真损坏。 */
function corruptSchemaPage(dbPath: string): void {
  const fd = fs.openSync(dbPath, 'r+');
  try {
    fs.writeSync(fd, Buffer.alloc(4000, 0xee), 0, 4000, 100);
  } finally {
    fs.closeSync(fd);
  }
}

function brokenFiles(dir: string): string[] {
  return fs.readdirSync(dir).filter((f) => f.includes('.broken.'));
}

describe('损坏库自动恢复', () => {
  it('有可用备份 → 坏库留档, 从备份恢复, 会话还在', () => {
    const dir = newCaseDir();
    const dbPath = path.join(dir, 'neox.db');
    const db = new NeoxDatabase(dbPath);
    db.close();
    insertSession(dbPath, 's-1');

    /* 备份一份, 再破坏原库 */
    fs.copyFileSync(dbPath, `${dbPath}.plaintext-backup.${Date.now()}`);
    corruptSchemaPage(dbPath);
    expect(() => sessionCount(dbPath)).toThrow();

    const opened = new NeoxDatabase(dbPath);
    try {
      expect(sessionCount(dbPath)).toBe(1);
    } finally {
      opened.close();
    }
    expect(brokenFiles(dir).length).toBe(1);
    /* 备份是复制恢复, 不是搬走: 原件还在 */
    expect(fs.readdirSync(dir).some((f) => f.includes('.plaintext-backup.'))).toBe(true);
  });

  it('没有备份 → 坏库留档, 重建空库, 进程继续可用', () => {
    const dir = newCaseDir();
    const dbPath = path.join(dir, 'neox.db');
    const db = new NeoxDatabase(dbPath);
    db.close();
    insertSession(dbPath, 's-1');
    corruptSchemaPage(dbPath);

    const opened = new NeoxDatabase(dbPath);
    try {
      /* 库是新建的, 至少能用 (不再抛 malformed) */
      expect(sessionCount(dbPath)).toBe(0);
    } finally {
      opened.close();
    }
    expect(brokenFiles(dir).length).toBe(1);
  });

  it('加密库/头部不可读且没有可用备份 → 保留原文件, 不隔离, 记录真实原因', () => {
    const dir = newCaseDir();
    const dbPath = path.join(dir, 'neox.db');
    const db = new NeoxDatabase(dbPath);
    db.close();
    /* 整个头部都毁掉: 既不像 SQLite, 也没有任何 key 能打开 → 无法区分 key 不匹配 */
    const fd = fs.openSync(dbPath, 'r+');
    try { fs.writeSync(fd, Buffer.alloc(4096, 0), 0, 4096, 0); } finally { fs.closeSync(fd); }

    clearDbInitFailure();
    expect(() => new NeoxDatabase(dbPath)).toThrow();
    expect(brokenFiles(dir)).toEqual([]);
    const failure = getDbInitFailure();
    expect(failure?.dbPath).toBe(dbPath);
    expect(failure?.message).toMatch(/not a database|malformed|corrupt/i);
  });

  it('逐表抢救: 部分页损坏时仍能把可读的行搬进新库', () => {
    const dir = newCaseDir();
    const srcPath = path.join(dir, 'source.db');
    const db = new NeoxDatabase(srcPath);
    db.close();

    const raw: any = new Klass(srcPath);
    try {
      const insert = raw.prepare(
        'INSERT INTO sessions (id, name, model_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      );
      const payload = 'x'.repeat(400);
      const tx = raw.transaction((start: number) => {
        for (let i = 0; i < 1200; i++) insert.run(`s-${start + i}`, payload, 'm', Date.now(), Date.now());
      });
      tx(0);
      raw.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      raw.close();
    }

    const damaged = path.join(dir, 'damaged.db');
    fs.copyFileSync(srcPath, damaged);
    /* 只毁中间一页, schema 页 (第 1 页) 保持完好 */
    const size = fs.statSync(damaged).size;
    const offset = Math.min(3 * 4096, Math.max(100, size - 8192));
    const fd = fs.openSync(damaged, 'r+');
    try { fs.writeSync(fd, Buffer.alloc(4096, 0xee), 0, 4096, offset); } finally { fs.closeSync(fd); }

    const targetPath = path.join(dir, 'target.db');
    const target = new NeoxDatabase(targetPath);
    try {
      const salvaged = salvageIntoOpenDatabase({
        dst: target.getRawDb(),
        sourcePath: damaged,
        keyCandidates: [null],
        chunkSize: 200,
      });
      expect(salvaged.totalRows).toBeGreaterThan(0);
      expect(sessionCount(targetPath)).toBeGreaterThan(0);
      expect(sessionCount(targetPath)).toBeLessThanOrEqual(1200);
    } finally {
      target.close();
    }
  });
});
