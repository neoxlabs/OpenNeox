import { describe, it, expect } from 'vitest';
import { VfsUri, uri } from '../uri.js';

describe('VfsUri.parse', () => {
  it('parses simple scheme:path', () => {
    const u = VfsUri.parse('memory:buffer-1');
    expect(u.scheme).toBe('memory');
    expect(u.authority).toBe('');
    expect(u.path).toBe('buffer-1');
  });

  it('parses scheme://authority/path', () => {
    const u = VfsUri.parse('git://host.example/repo/file.ts');
    expect(u.scheme).toBe('git');
    expect(u.authority).toBe('host.example');
    expect(u.path).toBe('/repo/file.ts');
  });

  it('parses file:/// with empty authority', () => {
    const u = VfsUri.parse('file:///Users/me/a.ts');
    expect(u.scheme).toBe('file');
    expect(u.authority).toBe('');
    expect(u.path).toBe('/Users/me/a.ts');
  });

  it('parses scheme:// with no path', () => {
    const u = VfsUri.parse('memory://');
    expect(u.scheme).toBe('memory');
    expect(u.authority).toBe('');
    expect(u.path).toBe('');
  });

  it('lowercases scheme', () => {
    const u = VfsUri.parse('FILE:///a');
    expect(u.scheme).toBe('file');
  });

  it('throws on missing scheme', () => {
    expect(() => VfsUri.parse(':path')).toThrow(/missing scheme/);
    expect(() => VfsUri.parse('no-scheme')).toThrow(/missing scheme/);
  });

  it('throws on empty input', () => {
    expect(() => VfsUri.parse('')).toThrow();
  });
});

describe('VfsUri.file', () => {
  it('wraps unix absolute path', () => {
    const u = VfsUri.file('/Users/me/a.ts');
    expect(u.scheme).toBe('file');
    expect(u.path).toBe('/Users/me/a.ts');
    expect(u.fsPath).toBe('/Users/me/a.ts');
  });

  it('wraps windows path with drive letter', () => {
    const u = VfsUri.file('C:\\Users\\me\\a.ts');
    expect(u.scheme).toBe('file');
    expect(u.path).toBe('/C:/Users/me/a.ts');
    expect(u.fsPath).toBe('C:/Users/me/a.ts');
  });

  it('throws on relative path', () => {
    expect(() => VfsUri.file('relative/path.ts')).toThrow(/absolute/);
  });

  it('fsPath throws for non-file scheme', () => {
    const u = VfsUri.parse('memory:x');
    expect(() => u.fsPath).toThrow(/not a file/);
  });
});

describe('VfsUri.toString', () => {
  it('round-trips simple scheme:path', () => {
    expect(VfsUri.parse('memory:x').toString()).toBe('memory:x');
  });

  it('round-trips scheme://authority/path', () => {
    expect(VfsUri.parse('git://host/repo/x.ts').toString()).toBe('git://host/repo/x.ts');
  });

  it('round-trips file:///abs', () => {
    expect(VfsUri.parse('file:///Users/me/a.ts').toString()).toBe('file:///Users/me/a.ts');
  });

  it('round-trips VfsUri.file result', () => {
    const u = VfsUri.file('/a/b/c.ts');
    expect(u.toString()).toBe('file:///a/b/c.ts');
  });
});

describe('VfsUri.from / equals / withPath', () => {
  it('from constructs with explicit parts', () => {
    const u = VfsUri.from({ scheme: 'memory', path: 'x' });
    expect(u.toString()).toBe('memory:x');
  });

  it('from lowercases scheme', () => {
    expect(VfsUri.from({ scheme: 'Git', path: '/x' }).scheme).toBe('git');
  });

  it('from throws without scheme', () => {
    expect(() => VfsUri.from({ scheme: '', path: 'x' })).toThrow();
  });

  it('equals compares structurally', () => {
    const a = VfsUri.parse('file:///a');
    const b = VfsUri.parse('file:///a');
    const c = VfsUri.parse('file:///b');
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
  });

  it('withPath creates new URI with same scheme/authority', () => {
    const a = VfsUri.parse('git://host/repo/a.ts');
    const b = a.withPath('/repo/b.ts');
    expect(b.scheme).toBe('git');
    expect(b.authority).toBe('host');
    expect(b.path).toBe('/repo/b.ts');
  });
});

describe('uri factory shortcut', () => {
  it('exposes parse/file/from', () => {
    expect(uri.parse('memory:x')).toBeInstanceOf(VfsUri);
    expect(uri.file('/a')).toBeInstanceOf(VfsUri);
    expect(uri.from({ scheme: 'm', path: 'x' })).toBeInstanceOf(VfsUri);
  });
});
