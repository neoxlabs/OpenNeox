/**
 * FileIndex 单测 —— 索引的 CRUD + basename 反向索引。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FileIndex, basenameOf } from '../fileIndex/FileIndex.js';

describe('basenameOf', () => {
  it('extracts basename from unix path', () => {
    expect(basenameOf('/a/b/c.ts')).toBe('c.ts');
  });
  it('extracts basename from windows path', () => {
    expect(basenameOf('C:\\Users\\foo\\bar.ts')).toBe('bar.ts');
  });
  it('handles path with no slash', () => {
    expect(basenameOf('hello.ts')).toBe('hello.ts');
  });
});

describe('FileIndex', () => {
  let idx: FileIndex;

  beforeEach(() => {
    idx = new FileIndex();
  });

  it('starts empty', () => {
    expect(idx.size()).toBe(0);
    expect(idx.all()).toEqual([]);
  });

  it('upsert adds new entries', () => {
    idx.upsert({
      path: '/a/b/foo.ts',
      basename: 'foo.ts',
      language: 'typescript',
    });
    expect(idx.size()).toBe(1);
    expect(idx.has('/a/b/foo.ts')).toBe(true);
    expect(idx.get('/a/b/foo.ts')?.basename).toBe('foo.ts');
  });

  it('upsert updates existing entry (same path)', () => {
    idx.upsert({
      path: '/a/foo.ts',
      basename: 'foo.ts',
      language: 'typescript',
      mtime: 1000,
    });
    idx.upsert({
      path: '/a/foo.ts',
      basename: 'foo.ts',
      language: 'typescript',
      mtime: 2000,
    });
    expect(idx.size()).toBe(1);
    expect(idx.get('/a/foo.ts')?.mtime).toBe(2000);
  });

  it('remove drops an entry', () => {
    idx.upsert({ path: '/a/foo.ts', basename: 'foo.ts', language: 'typescript' });
    expect(idx.remove('/a/foo.ts')).toBe(true);
    expect(idx.size()).toBe(0);
    expect(idx.has('/a/foo.ts')).toBe(false);
    // 二次删除返回 false
    expect(idx.remove('/a/foo.ts')).toBe(false);
  });

  it('findByBasename returns all entries with that basename', () => {
    idx.upsert({ path: '/a/foo.ts', basename: 'foo.ts', language: 'typescript' });
    idx.upsert({ path: '/b/foo.ts', basename: 'foo.ts', language: 'typescript' });
    idx.upsert({ path: '/a/bar.ts', basename: 'bar.ts', language: 'typescript' });

    const foos = idx.findByBasename('foo.ts');
    expect(foos).toHaveLength(2);
    expect(new Set(foos.map((f) => f.path))).toEqual(
      new Set(['/a/foo.ts', '/b/foo.ts']),
    );
  });

  it('findByBasename returns [] for unknown basename', () => {
    idx.upsert({ path: '/a/foo.ts', basename: 'foo.ts', language: 'typescript' });
    expect(idx.findByBasename('bar.ts')).toEqual([]);
  });

  it('removes from basename index when removing entries', () => {
    idx.upsert({ path: '/a/foo.ts', basename: 'foo.ts', language: 'typescript' });
    idx.upsert({ path: '/b/foo.ts', basename: 'foo.ts', language: 'typescript' });
    idx.remove('/a/foo.ts');
    const remaining = idx.findByBasename('foo.ts');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].path).toBe('/b/foo.ts');
  });

  it('clear wipes everything', () => {
    idx.upsert({ path: '/a/foo.ts', basename: 'foo.ts', language: 'typescript' });
    idx.upsert({ path: '/b/bar.ts', basename: 'bar.ts', language: 'typescript' });
    idx.clear();
    expect(idx.size()).toBe(0);
    expect(idx.findByBasename('foo.ts')).toEqual([]);
  });
});
