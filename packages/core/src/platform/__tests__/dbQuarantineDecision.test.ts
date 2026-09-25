import { describe, it, expect } from 'vitest';
import { decideDbInitFailureAction } from '@neoxlabs/platform/platform/database.js';

describe('decideDbInitFailureAction', () => {
  const CODE_V = 5;

  it('true corruption + no readable data → quarantine', () => {
    expect(decideDbInitFailureAction(
      'database disk image is malformed',
      { storedSchemaVersion: null, hasUserData: false, userDataUnknown: false },
      CODE_V,
    )).toBe('quarantine');
  });

  it('corruption pattern but user data still readable → throw, never quarantine', () => {
    expect(decideDbInitFailureAction(
      'database disk image is malformed',
      { storedSchemaVersion: 5, hasUserData: true, userDataUnknown: false },
      CODE_V,
    )).toBe('throw');
  });

  it('schema error + db NEWER than process → version-skew (老桌面开新库)', () => {
    expect(decideDbInitFailureAction(
      'no such column: sessions.new_field',
      { storedSchemaVersion: 9, hasUserData: true, userDataUnknown: false },
      CODE_V,
    )).toBe('version-skew');
  });

  it('schema error + user data present (同版本/旧版本) → throw, never quarantine', () => {
    expect(decideDbInitFailureAction(
      'no such column: sessions.foo',
      { storedSchemaVersion: 5, hasUserData: true, userDataUnknown: false },
      CODE_V,
    )).toBe('throw');
  });

  it('schema error + empty shell → quarantine (2026-06-23 半初始化场景保留)', () => {
    expect(decideDbInitFailureAction(
      'no such table: sessions',
      { storedSchemaVersion: 5, hasUserData: false, userDataUnknown: false },
      CODE_V,
    )).toBe('quarantine');
  });

  it('locked/readonly never reaches quarantine (handled upstream) — falls to throw here', () => {
    expect(decideDbInitFailureAction(
      'database is locked',
      { storedSchemaVersion: 5, hasUserData: true, userDataUnknown: false },
      CODE_V,
    )).toBe('throw');
    expect(decideDbInitFailureAction(
      'attempt to write a readonly database',
      { storedSchemaVersion: null, hasUserData: false, userDataUnknown: false },
      CODE_V,
    )).toBe('throw');
  });

  it('unknown errors → throw (default safe)', () => {
    expect(decideDbInitFailureAction(
      'some totally unexpected error',
      { storedSchemaVersion: 5, hasUserData: false, userDataUnknown: false },
      CODE_V,
    )).toBe('throw');
  });
});

describe('decideDbInitFailureAction — 探针读不出结论时绝不隔离', () => {
  const CODE_V = 5;

  it('加密库 key 没解开 (not a database + 探针没读成) → throw, 不是 quarantine', () => {
    expect(decideDbInitFailureAction(
      'file is not a database',
      { storedSchemaVersion: null, hasUserData: false, userDataUnknown: true },
      CODE_V,
    )).toBe('throw');
  });

  it('userDataUnknown 压过 schema 类错 — 版本号也是没读成的, 不能据此判偏差', () => {
    expect(decideDbInitFailureAction(
      'no such table: sessions',
      { storedSchemaVersion: null, hasUserData: false, userDataUnknown: true },
      CODE_V,
    )).toBe('throw');
  });

  it('确认过是空壳库 (userDataUnknown=false) 才允许隔离 — 原修复场景不能被这次改动堵死', () => {
    expect(decideDbInitFailureAction(
      'no such table: sessions',
      { storedSchemaVersion: null, hasUserData: false, userDataUnknown: false },
      CODE_V,
    )).toBe('quarantine');
  });
});

import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sweepStaleEncryptingTemps } from '@neoxlabs/platform/platform/database.js';

describe('sweepStaleEncryptingTemps', () => {
  it('只删够旧的 .encrypting.<ts>; 新的 / 备份 / 主库都不碰', () => {
    const dir = mkdtempSync(join(tmpdir(), 'neox-sweep-'));
    const db = join(dir, 'neox-cli.db');
    const now = 1_800_000_000_000;
    writeFileSync(db, 'main');
    writeFileSync(`${db}.encrypting.${now - 2 * 3600_000}`, 'old');
    writeFileSync(`${db}.encrypting.${now - 10_000}`, 'fresh');
    writeFileSync(`${db}.plaintext-backup.${now - 2 * 3600_000}`, 'backup');
    writeFileSync(join(dir, `other.db.encrypting.${now - 2 * 3600_000}`), 'other');
    const removed = sweepStaleEncryptingTemps(db, now);
    expect(removed).toEqual([`neox-cli.db.encrypting.${now - 2 * 3600_000}`]);
    expect(existsSync(`${db}.encrypting.${now - 10_000}`)).toBe(true);
    expect(existsSync(`${db}.plaintext-backup.${now - 2 * 3600_000}`)).toBe(true);
    expect(existsSync(db)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
