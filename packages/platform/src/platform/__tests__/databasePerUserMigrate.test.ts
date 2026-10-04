import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  classifyLeftoverAgainstLive,
  isPreMigrateCloneName,
  isUnreadableAttachedDbError,
  leftoverRetirePath,
  looksLikePlaintextSqliteHeader,
  orderAttachKeys,
  PER_USER_MIGRATE_MARKER,
  runPerUserDbToGlobalMigrate,
  sqlcipherAttachKeyClause,
} from '../databasePerUserMigrate.js';

describe('sqlcipherAttachKeyClause', () => {
  it('空字符串是明文附件, 不是省略 KEY (省略会继承主库密钥, 明文必炸)', () => {
    expect(sqlcipherAttachKeyClause('')).toBe(" KEY ''");
    expect(sqlcipherAttachKeyClause(null)).toBe('');
    expect(sqlcipherAttachKeyClause('ab')).toBe(` KEY "x'ab'"`);
  });
});

describe('looksLikePlaintextSqliteHeader', () => {
  it('认 SQLite format 3 头, 密文头不算', () => {
    const plain = new Uint8Array(16);
    const sig = 'SQLite format 3';
    for (let i = 0; i < sig.length; i++) plain[i] = sig.charCodeAt(i);
    expect(looksLikePlaintextSqliteHeader(plain)).toBe(true);
    expect(looksLikePlaintextSqliteHeader(new Uint8Array([0x72, 0x66, 0x70, 0x38]))).toBe(false);
    expect(looksLikePlaintextSqliteHeader(new Uint8Array(8))).toBe(false);
  });
});

describe('orderAttachKeys', () => {
  it('明文头先 KEY \'\' 再派生 key, 避免每次先用主库密钥 ATTACH 失败', () => {
    expect(orderAttachKeys(true, ['aa', 'bb'])).toEqual(['', 'aa', 'bb', null]);
  });

  it('密文头先派生 key 再明文空密钥', () => {
    expect(orderAttachKeys(false, ['aa'])).toEqual(['aa', '', null]);
  });
});

describe('isUnreadableAttachedDbError', () => {
  it('认 SQLCipher 解不开 / 明文被当密文读的那串', () => {
    expect(isUnreadableAttachedDbError(new Error('file is not a database'))).toBe(true);
    expect(isUnreadableAttachedDbError('SQLITE_NOTADB: file is not a database')).toBe(true);
    expect(isUnreadableAttachedDbError(new Error('UNIQUE constraint failed'))).toBe(false);
  });
});

describe('pre-migrate clones', () => {
  it('只认活库快照名, 不动 neox.db 本身', () => {
    expect(isPreMigrateCloneName('neox.db.pre-migrate-1782910093433')).toBe(true);
    expect(isPreMigrateCloneName('neox.db.pre-migrate-1-wal')).toBe(true);
    expect(isPreMigrateCloneName('neox.db')).toBe(false);
    expect(isPreMigrateCloneName('neox.db.broken.1')).toBe(false);
  });
});

describe('classifyLeftoverAgainstLive', () => {
  it('明文小库对密文大库必须 merge, 不是冗余克隆', () => {
    expect(classifyLeftoverAgainstLive({
      leftoverSize: 565248,
      leftoverPlaintext: true,
      liveSize: 315000000,
      livePlaintext: false,
    })).toBe('merge');
  });

  it('同体积同形态才当活库克隆', () => {
    expect(classifyLeftoverAgainstLive({
      leftoverSize: 100,
      leftoverPlaintext: false,
      liveSize: 100,
      livePlaintext: false,
    })).toBe('redundant-live-clone');
  });
});

describe('leftoverRetirePath', () => {
  it('退役后不再叫 neox.db, 下次扫描扫不到', () => {
    expect(leftoverRetirePath('/users/u/neox.db', 'merged', 9)).toBe('/users/u/neox.db.merged-9');
  });
});

function fakeSqlite() {
  return {
    pragma: () => undefined,
    exec: () => undefined,
  };
}

describe('runPerUserDbToGlobalMigrate 闭环', () => {
  it('不复制活库, 合完 leftover, 清掉 pre-migrate, 写 marker', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-migrate-'));
    const live = path.join(dir, 'neox.db');
    fs.writeFileSync(live, 'LIVE-CIPHER');
    fs.writeFileSync(path.join(dir, 'neox.db.pre-migrate-111'), 'CLONE-A');
    fs.writeFileSync(path.join(dir, 'neox.db.pre-migrate-222-wal'), 'CLONE-WAL');
    const leftoverDir = path.join(dir, 'users', 'u1');
    fs.mkdirSync(leftoverDir, { recursive: true });
    const leftover = path.join(leftoverDir, 'neox.db');
    fs.writeFileSync(leftover, 'OLD-PLAIN');
    const attached: string[] = [];

    const r = runPerUserDbToGlobalMigrate({
      configDir: dir,
      globalDbPath: live,
      closeDatabase: () => undefined,
      openGlobal: () => ({ getRawDb: fakeSqlite, close: () => undefined }),
      attachSource: (_dst, p) => { attached.push(p); },
      mergeAttached: () => 4,
    });

    expect(fs.readFileSync(live, 'utf8')).toBe('LIVE-CIPHER');
    expect(fs.existsSync(path.join(dir, 'neox.db.pre-migrate-111'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'neox.db.pre-migrate-222-wal'))).toBe(false);
    expect(fs.existsSync(leftover)).toBe(false);
    expect(fs.readdirSync(leftoverDir).some((n) => n.startsWith('neox.db.merged-'))).toBe(true);
    expect(fs.existsSync(path.join(dir, PER_USER_MIGRATE_MARKER))).toBe(true);
    expect(attached).toEqual([leftover]);
    expect(r.dbFiles).toBe(1);
    expect(r.sessions).toBe(4);
    expect(r.failedDbFiles).toBe(0);
    expect(r.swept).toBeGreaterThanOrEqual(2);

    const again = runPerUserDbToGlobalMigrate({
      configDir: dir,
      globalDbPath: live,
      closeDatabase: () => { throw new Error('marker 后不该再开库 merge'); },
      openGlobal: () => { throw new Error('marker 后不该再开库 merge'); },
      attachSource: () => { throw new Error('marker 后不该 ATTACH'); },
      mergeAttached: () => { throw new Error('marker 后不该 merge'); },
    });
    expect(again.dbFiles).toBe(0);
    expect(fs.readFileSync(live, 'utf8')).toBe('LIVE-CIPHER');
  });

  it('新用户没有 leftover 也写 marker, 以后永远跳过', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-migrate-new-'));
    const r = runPerUserDbToGlobalMigrate({
      configDir: dir,
      globalDbPath: path.join(dir, 'neox.db'),
      closeDatabase: () => { throw new Error('不该关库'); },
      openGlobal: () => { throw new Error('不该开库'); },
      attachSource: () => undefined,
      mergeAttached: () => 0,
    });
    expect(r.failedDbFiles).toBe(0);
    expect(fs.existsSync(path.join(dir, PER_USER_MIGRATE_MARKER))).toBe(true);
  });

  it('硬失败不写 marker, leftover 留下下次重试, 仍然不 copy 活库', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-migrate-fail-'));
    const live = path.join(dir, 'neox.db');
    fs.writeFileSync(live, 'LIVE');
    const leftoverDir = path.join(dir, 'users', 'u1');
    fs.mkdirSync(leftoverDir, { recursive: true });
    const leftover = path.join(leftoverDir, 'neox.db');
    fs.writeFileSync(leftover, 'OLD');

    const r = runPerUserDbToGlobalMigrate({
      configDir: dir,
      globalDbPath: live,
      closeDatabase: () => undefined,
      openGlobal: () => ({ getRawDb: fakeSqlite, close: () => undefined }),
      attachSource: () => { throw new Error('UNIQUE constraint failed'); },
      mergeAttached: () => 0,
    });
    expect(r.failedDbFiles).toBe(1);
    expect(fs.existsSync(path.join(dir, PER_USER_MIGRATE_MARKER))).toBe(false);
    expect(fs.existsSync(leftover)).toBe(true);
    expect(fs.readFileSync(live, 'utf8')).toBe('LIVE');
  });
});
