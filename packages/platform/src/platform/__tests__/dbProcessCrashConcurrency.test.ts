import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { NeoxDatabase } from '../database.js';
import { _resetMasterKeyCache } from '../dbCipher.js';
import { listDatabaseBackups } from '../dbRecovery.js';
import { DISTRIBUTION } from '@neoxlabs/kernel/platform/distribution.js';

const _require = createRequire(import.meta.url);
const Klass = _require('better-sqlite3-multiple-ciphers');


const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const distDb = path.join(repoRoot, 'packages/platform/dist/platform/database.js');
const hasDist = fs.existsSync(distDb);

let dir: string | null = null;
let prevEnv: Record<string, string | undefined> = {};

afterEach(() => {
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  prevEnv = {};
  _resetMasterKeyCache();
  if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } dir = null; }
});

function rememberEnv(...keys: string[]): void {
  for (const k of keys) prevEnv[k] = process.env[k];
}

function makeCaseDir(): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-dbproc-'));
  return dir;
}

function sessionCount(filePath: string, keyHex: string | null = null): number {
  const db: any = new Klass(filePath, { readonly: true });
  try {
    if (keyHex) db.pragma(`key = "x'${keyHex}'"`);
    return Number((db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as any)?.n ?? 0);
  } finally {
    db.close();
  }
}

function writeChildScript(dirPath: string, body: string): string {
  const script = path.join(dirPath, `child-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(script, body);
  return script;
}

function runNode(script: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 30_000): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stderr }); });
  });
}

describe.skipIf(!hasDist)('真进程: kill -9 / 并发启动', () => {
  it('写库进程被 kill -9 后, 再打开同一会话库可用', async () => {
    const d = makeCaseDir();
    const dbPath = path.join(d, 'neox.db');
    rememberEnv('NEOX_DB_ENCRYPT', 'NEOX_HOME', 'HOME');
    process.env.NEOX_DB_ENCRYPT = '0';
    process.env.NEOX_HOME = d;

    const seed = new NeoxDatabase(dbPath);
    seed.close();
    const before = sessionCount(dbPath);

    /* 子进程持续写 (WAL), 300ms 后 SIGKILL —— 模拟 worker abort 时正在写库 */
    const script = writeChildScript(d, `
      import Database from 'better-sqlite3-multiple-ciphers';
      const db = new Database(process.argv[2]);
      db.pragma('journal_mode = WAL');
      db.pragma('busy_timeout = 5000');
      const stmt = db.prepare('INSERT INTO sessions (id, name, model_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
      let i = 0;
      for (;;) {
        stmt.run('k-' + (i++), 'killed', 'm', Date.now(), Date.now());
      }
    `);
    await new Promise<void>((resolve) => {
      const child = spawn(process.execPath, [script, dbPath], { env: process.env, stdio: 'ignore' });
      setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 300);
      child.on('exit', () => resolve());
    });

    /* 再打开: 不能 malformed / not a database; 数据至少还有原来那一份 */
    const reopened = new NeoxDatabase(dbPath);
    try {
      expect(sessionCount(dbPath)).toBeGreaterThanOrEqual(before);
    } finally {
      reopened.close();
    }
    expect(fs.readdirSync(d).filter((f) => f.includes('.broken.'))).toEqual([]);
  }, 40_000);

  it('两个进程同时启动同一个明文库 (触发加密迁移) → 不坏库、不丢会话', async () => {
    const iface = process.platform === 'darwin'
      ? path.join('Library', 'Application Support', DISTRIBUTION.appName)
      : null;
    if (!iface) return; /* machine-id 路径按平台分叉, 只在 darwin 上构造 */

    const d = makeCaseDir();
    rememberEnv('NEOX_DB_ENCRYPT', 'NEOX_HOME', 'HOME');
    fs.mkdirSync(path.join(d, iface), { recursive: true });
    fs.writeFileSync(path.join(d, iface, 'machine-id'), 'machine-concurrent-test');
    _resetMasterKeyCache();

    const dbPath = path.join(d, 'neox-concurrent.db');
    process.env.NEOX_DB_ENCRYPT = '0';
    process.env.NEOX_HOME = d;
    const seed = new NeoxDatabase(dbPath);
    try {
      const raw: any = seed.getRawDb();
      raw.prepare('INSERT INTO sessions (id, name, model_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run('seed-1', 'seed', 'm', Date.now(), Date.now());
    } finally {
      seed.close();
    }
    expect(fs.readFileSync(dbPath).subarray(0, 15).toString('latin1')).toBe('SQLite format 3');

    const childScript = writeChildScript(d, `
      const { NeoxDatabase } = await import(${JSON.stringify(distDb)});
      const db = new NeoxDatabase(process.argv[2]);
      db.close();
    `);
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: d, NEOX_HOME: d };
    delete env.NEOX_DB_ENCRYPT;

    const [a, b] = await Promise.all([
      runNode(childScript, [dbPath], env),
      runNode(childScript, [dbPath], env),
    ]);
    expect([a.code, b.code]).toEqual([0, 0]);

    /* 迁移完成后必须是加密库, 会话还在, 没有半成品 / 隔离文件 */
    expect(fs.readFileSync(dbPath).subarray(0, 15).toString('latin1')).not.toBe('SQLite format 3');
    /* 必须真的发生过迁移: 盘上留了一份明文备份 (否则这条用例没测到改写路径) */
    expect(listDatabaseBackups(dbPath).some((b) => b.kind === 'plaintext')).toBe(true);
    expect(fs.readdirSync(d).filter((f) => f.includes('.encrypting.'))).toEqual([]);
    expect(fs.readdirSync(d).filter((f) => f.includes('.broken.'))).toEqual([]);

    /* 父进程用同一处 machine-id 再开一次, 断言数据没丢 */
    process.env.HOME = d;
    process.env.NEOX_HOME = d;
    delete process.env.NEOX_DB_ENCRYPT;
    _resetMasterKeyCache();
    const reopened = new NeoxDatabase(dbPath);
    try {
      const raw: any = reopened.getRawDb();
      const rows = raw.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n?: number };
      expect(Number(rows?.n ?? 0)).toBe(1);
    } finally {
      reopened.close();
    }
  }, 60_000);
});
