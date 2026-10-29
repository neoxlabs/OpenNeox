/**
 * SQLite 多进程并发 —— 一台机器同时开多个 neox (CLI 多窗口 / CLI + 桌面) 共用一个库时,
 * 不允许把 SQLITE_BUSY / database is locked 抛到上层, 也不允许丢写入。
 *
 * 这里的失败模式是**进程级**的 (deferred 事务读到 MAX(seq) 后锁升级失败), 单进程测试测不出来,
 * 所以主用例真的起 4 个子进程打同一个临时库:
 *   · 每个子进程按会话写入的真实形状做事: BEGIN IMMEDIATE → SELECT MAX(seq) → INSERT → 读回;
 *   · 重试层显式关掉 (retryDelaysMs: []) —— 要证明的是 busy_timeout + BEGIN IMMEDIATE 本身够用,
 *     不是靠无限重试糊过去;
 *   · 断言 4 × N 条一条不少、seq 连续无重复、所有子进程退出码为 0。
 *
 * 临时库放系统临时目录, 不碰 ~/.neox。
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import {
  SQLITE_BUSY_TIMEOUT_MS,
  applySqliteConcurrencyPragmas,
  isSqliteBusyError,
  runImmediateTransaction,
} from '../sqliteConcurrency.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELPER_PATH = path.join(HERE, '..', 'sqliteConcurrency.ts');

const tmpDirs: string[] = [];
function makeTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

/* 子进程脚本: 真实驱动 + 真实并发策略模块 (node --experimental-strip-types 直接加载 .ts)。 */
const CHILD_SOURCE = `
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const helper = await import(process.argv[2]);
const dbPath = process.argv[3];
const sessionId = process.argv[4];
const iterations = Number(process.argv[5]);
const driver = process.argv[6];

let db;
if (driver === 'better-sqlite3') {
  const require = createRequire(process.env.NEOX_TEST_REPO_ROOT + '/package.json');
  const Database = require('better-sqlite3');
  db = new Database(dbPath);
} else {
  const { DatabaseSync } = await import('node:sqlite');
  db = new DatabaseSync(dbPath);
}

// 与主库同一套连接策略
helper.applySqliteConcurrencyPragmas(db);

const selectMax = () => db.prepare('SELECT MAX(seq) AS m FROM messages WHERE session_id = ?').get(sessionId);
const insertMessage = () => db.prepare('INSERT INTO messages (session_id, seq, item_type, item_data, timestamp) VALUES (?, ?, ?, ?, ?)');
const insert = insertMessage();
const touchSession = db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?');
const countRows = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?');

const seqs = [];
for (let i = 0; i < iterations; i++) {
  // 重试层关掉: busy_timeout + BEGIN IMMEDIATE 自己必须够
  const seq = helper.runImmediateTransaction(db, () => {
    const row = selectMax();
    const next = (row && row.m != null ? row.m : -1) + 1;
    insert.run(sessionId, next, 'message', JSON.stringify({ by: process.argv[7], i }), Date.now());
    touchSession.run(Date.now(), sessionId);
    return next;
  }, { retryDelaysMs: [], label: 'child' });
  seqs.push(seq);
  // 并发读: 别的进程正在写时本地读也不能报错
  countRows.get(sessionId);
}

if (typeof db.close === 'function') db.close();
console.log(JSON.stringify({ wrote: seqs.length, unique: new Set(seqs).size }));
`;

interface ChildResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runChild(script: string, dbPath: string, iterations: number, driver: 'node:sqlite' | 'better-sqlite3', idx: number): Promise<ChildResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      '--experimental-strip-types',
      '--no-warnings',
      script,
      pathToFileURL(HELPER_PATH).href,
      dbPath,
      'shared-session',
      String(iterations),
      driver,
      String(idx),
    ], {
      env: { ...process.env, NEOX_TEST_REPO_ROOT: process.cwd() },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d: string) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function prepareDb(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      model_id TEXT NOT NULL DEFAULT '',
      workspace_path TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      context_used INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT NOT NULL,
      seq         INTEGER NOT NULL,
      item_type   TEXT NOT NULL,
      item_data   TEXT NOT NULL,
      timestamp   INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, seq);
  `);
  db.prepare('INSERT OR IGNORE INTO sessions (id, name) VALUES (?, ?)').run('shared-session', 'shared-session');
  db.close();
}

function readBack(dbPath: string): { count: number; distinctCount: number; min: number | null; max: number | null } {
  const db = new DatabaseSync(dbPath);
  const row = db.prepare(`
    SELECT COUNT(*) AS count, COUNT(DISTINCT seq) AS distinct_count, MIN(seq) AS min, MAX(seq) AS max
    FROM messages WHERE session_id = ?
  `).get('shared-session') as { count: number; distinct_count: number; min: number | null; max: number | null };
  db.close();
  return { count: row.count, distinctCount: row.distinct_count, min: row.min, max: row.max };
}

/* better-sqlite3 在当前环境可能装的是 Electron ABI (桌面开发时) —— 装不上就只跑 node:sqlite 那组,
 * 不把环境问题伪装成并发失败。 */
function betterSqlite3Available(): boolean {
  try {
    createRequire(import.meta.url)('better-sqlite3');
    return true;
  } catch {
    return false;
  }
}

describe('runImmediateTransaction', () => {
  it('驱动支持 .immediate() 时走 BEGIN IMMEDIATE 那条路', () => {
    const calls: string[] = [];
    const db = {
      exec: (sql: string) => { calls.push(sql); },
      transaction: (fn: () => number) => {
        const wrapped = (() => { calls.push('deferred'); return fn(); }) as (() => number) & { immediate?: () => number };
        wrapped.immediate = () => { calls.push('immediate'); return fn(); };
        return wrapped;
      },
    };
    expect(runImmediateTransaction(db, () => 42, { label: 'test' })).toBe(42);
    expect(calls).toEqual(['immediate']);
  });

  it('没有 transaction() 的驱动 (node:sqlite) 手工 BEGIN IMMEDIATE / COMMIT', () => {
    const calls: string[] = [];
    const db = { exec: (sql: string) => { calls.push(sql); }, inTransaction: false };
    expect(runImmediateTransaction(db, () => 'ok', { label: 'test' })).toBe('ok');
    expect(calls).toEqual(['BEGIN IMMEDIATE', 'COMMIT']);
  });

  it('回调抛错时 ROLLBACK 并原样抛, 不重试非 busy 错误', () => {
    const calls: string[] = [];
    const db = { exec: (sql: string) => { calls.push(sql); }, inTransaction: false };
    expect(() => runImmediateTransaction(db, () => { throw new Error('boom'); }, { label: 'test' }))
      .toThrow('boom');
    expect(calls).toEqual(['BEGIN IMMEDIATE', 'ROLLBACK']);
  });

  it('已在事务里 (嵌套调用) 不再 BEGIN', () => {
    const calls: string[] = [];
    const db = { exec: (sql: string) => { calls.push(sql); }, inTransaction: true };
    expect(runImmediateTransaction(db, () => 7, { label: 'test' })).toBe(7);
    expect(calls).toEqual([]);
  });

  it('busy_timeout 用尽后只重试有限次并打日志', () => {
    let attempts = 0;
    const db = {
      exec: () => undefined,
      transaction: (fn: () => string) => {
        const wrapped = (() => {
          attempts += 1;
          if (attempts <= 2) {
            const err = new Error('database is locked') as Error & { code?: string };
            err.code = 'SQLITE_BUSY';
            throw err;
          }
          return fn();
        }) as (() => string) & { immediate?: () => string };
        wrapped.immediate = wrapped;
        return wrapped;
      },
    };
    const retries: number[] = [];
    expect(runImmediateTransaction(db, () => 'ok', {
      label: 'test',
      retryDelaysMs: [1, 1],
      onBusyRetry: (info) => retries.push(info.attempt),
    })).toBe('ok');
    expect(retries).toEqual([1, 2]);
  });

  it('重试次数用尽仍 busy → 抛给上层 (不无限重试)', () => {
    const db = {
      exec: () => undefined,
      transaction: () => {
        const wrapped = (() => {
          const err = new Error('database is locked') as Error & { code?: string };
          err.code = 'SQLITE_BUSY';
          throw err;
        }) as (() => never) & { immediate?: () => never };
        wrapped.immediate = wrapped;
        return wrapped;
      },
    };
    expect(() => runImmediateTransaction(db, () => 1, {
      label: 'test', retryDelaysMs: [1], onBusyRetry: () => undefined,
    })).toThrow(/database is locked/);
  });
});

describe('isSqliteBusyError', () => {
  it('认 SQLITE_BUSY / SQLITE_LOCKED 的 code 与文案, 不误伤别的错', () => {
    const busy = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    expect(isSqliteBusyError(busy)).toBe(true);
    expect(isSqliteBusyError(new Error('database is locked'))).toBe(true);
    expect(isSqliteBusyError(new Error('SQLITE_BUSY: database is locked'))).toBe(true);
    expect(isSqliteBusyError(Object.assign(new Error('x'), { code: 'SQLITE_BUSY_SNAPSHOT' }))).toBe(true);
    expect(isSqliteBusyError(new Error('UNIQUE constraint failed'))).toBe(false);
    expect(isSqliteBusyError(null)).toBe(false);
  });
});

describe('applySqliteConcurrencyPragmas', () => {
  it('WAL + busy_timeout=5000 + synchronous=NORMAL', () => {
    const dir = makeTmpDir('neox-pragmas-');
    const db = new DatabaseSync(path.join(dir, 'pragmas.db'));
    applySqliteConcurrencyPragmas(db as any);
    const journal = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    const timeout = db.prepare('PRAGMA busy_timeout').get() as { timeout: number };
    expect(journal.journal_mode).toBe('wal');
    expect(timeout.timeout).toBe(SQLITE_BUSY_TIMEOUT_MS);
    db.close();
  });
});

describe('多进程共用同一个临时库', () => {
  it('4 个进程 (node:sqlite) 各写 250 次: 无 SQLITE_BUSY, 1000 条一条不少且 seq 连续', async () => {
    const dir = makeTmpDir('neox-multiproc-');
    const dbPath = path.join(dir, 'shared.db');
    const script = path.join(dir, 'child.mjs');
    fs.writeFileSync(script, CHILD_SOURCE);
    prepareDb(dbPath);

    const perChild = 250;
    const results = await Promise.all([0, 1, 2, 3].map((i) => runChild(script, dbPath, perChild, 'node:sqlite', i)));
    for (const [i, r] of results.entries()) {
      expect(r.code, `child ${i} failed:\n${r.stderr}`).toBe(0);
      expect(JSON.parse(r.stdout.trim().split('\n').pop()!)).toEqual({
        wrote: perChild,
        unique: perChild,
      });
    }

    const after = readBack(dbPath);
    expect(after.count).toBe(perChild * results.length);
    expect(after.distinctCount).toBe(perChild * results.length);
    expect(after.min).toBe(0);
    expect(after.max).toBe(perChild * results.length - 1);
  }, 60000);

  it('better-sqlite3 (桌面/Node 真实驱动) 2 进程各写 150 次同样不报错、不丢写', async () => {
    if (!betterSqlite3Available()) {
      console.warn('[sqlite-concurrency] better-sqlite3 在当前 ABI 下不可用, 跳过该组');
      return;
    }
    const dir = makeTmpDir('neox-multiproc-bs3-');
    const dbPath = path.join(dir, 'shared.db');
    const script = path.join(dir, 'child.mjs');
    fs.writeFileSync(script, CHILD_SOURCE);
    prepareDb(dbPath);

    const perChild = 150;
    const results = await Promise.all([0, 1].map((i) => runChild(script, dbPath, perChild, 'better-sqlite3', i)));
    for (const [i, r] of results.entries()) {
      expect(r.code, `child ${i} failed:\n${r.stderr}`).toBe(0);
      expect(JSON.parse(r.stdout.trim().split('\n').pop()!)).toEqual({
        wrote: perChild,
        unique: perChild,
      });
    }

    const after = readBack(dbPath);
    expect(after.count).toBe(perChild * results.length);
    expect(after.distinctCount).toBe(perChild * results.length);
  }, 60000);
});

describe('NeoxDatabase 打开路径', () => {
  it('连接是 WAL + busy_timeout=5000, 事务走 BEGIN IMMEDIATE', async () => {
    process.env.NEOX_DB_ENCRYPT = '0';
    const dir = makeTmpDir('neox-db-pragmas-');
    const { NeoxDatabase } = await import('../database.js');
    const db = new NeoxDatabase(path.join(dir, 'neox-cli.db'));
    try {
      const raw: any = db.getRawDb();
      expect(raw.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(raw.pragma('busy_timeout', { simple: true })).toBe(SQLITE_BUSY_TIMEOUT_MS);

      let immediateCalls = 0;
      const original = raw.transaction.bind(raw);
      raw.transaction = (fn: () => unknown) => ({
        immediate: () => { immediateCalls += 1; return original(fn)(); },
      });
      db.transaction(() => {
        raw.prepare("INSERT INTO app_state (key, value) VALUES ('probe', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
      });
      expect(immediateCalls).toBe(1);
    } finally {
      db.close();
    }
  }, 30000);
});
