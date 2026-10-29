/**
 * P3.5: SymbolStore schema migration hardening.
 *
 * 不开真的 SQLite, 用一个极简 stub 模拟 better-sqlite3 行为, 专注测试
 * `ensureSchema()` 的决策逻辑.
 */
import { describe, it, expect } from 'vitest';
import { SymbolStore, SchemaMismatchError } from '../symbolStore/SymbolStore.js';
import type { SqliteDatabase, SqliteStatement } from '../symbolStore/SymbolStore.js';
import { CURRENT_SCHEMA_VERSION } from '../symbolStore/schema.js';

/**
 * 内存 DB stub: 只支持 meta 表的 get/run, exec 都当 no-op (schema DDL 对
 * 测试逻辑不重要 —— 我们测的是版本号决策).
 */
function createStubDb(initialMetaRows: Map<string, string> = new Map()): SqliteDatabase {
  const meta = new Map<string, string>(initialMetaRows);
  const tables = {
    meta,
    files: [] as unknown[],
    symbols: [] as unknown[],
  };
  const execLog: string[] = [];

  const stmt = (sql: string): SqliteStatement => {
    return {
      run(...params: unknown[]) {
        // ensureSchema 的 INSERT 是 `INSERT INTO meta (key, value) VALUES ('schema_version', ?)`
        // 只带一个 parameter —— value.
        if (/INSERT INTO meta/i.test(sql)) {
          meta.set('schema_version', String(params[0]));
        } else if (/UPDATE meta SET value = \?/i.test(sql)) {
          meta.set('schema_version', String(params[0]));
        }
        return { changes: 1, lastInsertRowid: 0 };
      },
      get(..._params: unknown[]) {
        if (/FROM meta WHERE key = 'schema_version'/i.test(sql)) {
          const v = meta.get('schema_version');
          return v ? { value: v } : undefined;
        }
        // 其他查询 (files / symbols) 返回 undefined
        return undefined;
      },
      all(..._params: unknown[]) { return []; },
    };
  };

  return {
    exec(sql: string) { execLog.push(sql); },
    prepare(sql: string) { return stmt(sql); },
    transaction<T>(fn: (...args: any[]) => T) { return fn; },
    pragma() { return undefined; },
    close() { /* no-op */ },
  };
}

describe('SymbolStore · ensureSchema migration hardening', () => {
  it('initializes fresh DB with current schema version', () => {
    const db = createStubDb();
    new SymbolStore(db);
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string };
    expect(parseInt(row.value, 10)).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('reuses existing DB at the same version (no-op)', () => {
    const db = createStubDb(new Map([['schema_version', String(CURRENT_SCHEMA_VERSION)]]));
    expect(() => new SymbolStore(db)).not.toThrow();
  });

  it('upgrades v1 DB to current via migrations', () => {
    // Assumes CURRENT_SCHEMA_VERSION >= 2 and we have v1→v2 migration.
    // 如果将来 CURRENT_SCHEMA_VERSION 升到 v3+, 此测试依赖有连续 migration.
    const db = createStubDb(new Map([['schema_version', '1']]));
    expect(() => new SymbolStore(db)).not.toThrow();
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string };
    expect(parseInt(row.value, 10)).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('throws SchemaMismatchError when DB is newer than code', () => {
    const db = createStubDb(new Map([['schema_version', String(CURRENT_SCHEMA_VERSION + 5)]]));
    let thrown: unknown = null;
    try { new SymbolStore(db); } catch (err) { thrown = err; }
    expect(thrown).toBeInstanceOf(SchemaMismatchError);
    const e = thrown as SchemaMismatchError;
    expect(e.dbVersion).toBe(CURRENT_SCHEMA_VERSION + 5);
    expect(e.codeVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(e.kind).toBe('db-newer');
  });

  it('SchemaMismatchError carries diagnostic fields', () => {
    const err = new SchemaMismatchError(99, 2, 'db-newer');
    expect(err.name).toBe('SchemaMismatchError');
    expect(err.message).toMatch(/db=v99.*code=v2.*db-newer/);
    expect(err instanceof Error).toBe(true);
  });
});
