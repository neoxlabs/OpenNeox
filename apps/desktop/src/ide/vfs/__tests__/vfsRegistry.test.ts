import { describe, it, expect, vi } from 'vitest';
import { VfsRegistry, SchemeConflictError, UnknownSchemeError } from '../vfsRegistry.js';
import { MemoryFileSystemProvider } from '../providers/memoryProvider.js';
import { VfsUri } from '../uri.js';
import type { FileSystemProvider } from '../fileSystemProvider.js';

function makeFakeProvider(label: string): FileSystemProvider {
  return {
    label,
    async readFile() { return { success: true, content: '' }; },
    async writeFile() { return { success: true }; },
  };
}

describe('VfsRegistry · register / resolve', () => {
  it('registers and resolves provider by scheme', () => {
    const reg = new VfsRegistry();
    const p = makeFakeProvider('fake');
    reg.register('memory', p);
    const resolved = reg.resolve(VfsUri.parse('memory:x'));
    expect(resolved).toBe(p);
  });

  it('scheme is case-insensitive', () => {
    const reg = new VfsRegistry();
    reg.register('Memory', makeFakeProvider('fake'));
    expect(reg.has('MEMORY')).toBe(true);
    expect(reg.has('memory')).toBe(true);
  });

  it('throws SchemeConflictError on duplicate', () => {
    const reg = new VfsRegistry();
    reg.register('memory', makeFakeProvider('first'));
    expect(() => reg.register('memory', makeFakeProvider('second')))
      .toThrow(SchemeConflictError);
  });

  it('resolve throws UnknownSchemeError when unregistered', () => {
    const reg = new VfsRegistry();
    expect(() => reg.resolve(VfsUri.parse('memory:x')))
      .toThrow(UnknownSchemeError);
  });

  it('tryResolve returns null instead of throwing', () => {
    const reg = new VfsRegistry();
    expect(reg.tryResolve(VfsUri.parse('memory:x'))).toBeNull();
  });
});

describe('VfsRegistry · unregister lifecycle', () => {
  it('returned unregister removes provider', () => {
    const reg = new VfsRegistry();
    const unregister = reg.register('memory', makeFakeProvider('fake'));
    expect(reg.has('memory')).toBe(true);
    unregister();
    expect(reg.has('memory')).toBe(false);
  });

  it('unregister is idempotent', () => {
    const reg = new VfsRegistry();
    reg.register('memory', makeFakeProvider('fake'));
    expect(reg.unregister('memory')).toBe(true);
    expect(reg.unregister('memory')).toBe(false);
  });

  it('unregister disposes provider if supported', () => {
    const reg = new VfsRegistry();
    const dispose = vi.fn();
    reg.register('memory', { ...makeFakeProvider('fake'), dispose });
    reg.unregister('memory');
    expect(dispose).toHaveBeenCalled();
  });

  it('dispose() cleans up all providers', async () => {
    const reg = new VfsRegistry();
    const dispose1 = vi.fn();
    const dispose2 = vi.fn();
    reg.register('a', { ...makeFakeProvider('a'), dispose: dispose1 });
    reg.register('b', { ...makeFakeProvider('b'), dispose: dispose2 });
    await reg.dispose();
    expect(dispose1).toHaveBeenCalled();
    expect(dispose2).toHaveBeenCalled();
    expect(reg.has('a')).toBe(false);
    expect(reg.has('b')).toBe(false);
  });
});

describe('VfsRegistry · snapshot', () => {
  it('lists registered providers', () => {
    const reg = new VfsRegistry();
    reg.register('memory', new MemoryFileSystemProvider());
    reg.register('file', makeFakeProvider('local-fs'));
    const snap = reg.snapshot();
    const schemes = snap.map((s) => s.scheme).sort();
    expect(schemes).toEqual(['file', 'memory']);
  });
});

describe('Errors', () => {
  it('SchemeConflictError carries diagnostic fields', () => {
    const err = new SchemeConflictError('memory', 'first', 'second');
    expect(err.scheme).toBe('memory');
    expect(err.existingLabel).toBe('first');
    expect(err.incomingLabel).toBe('second');
    expect(err.name).toBe('SchemeConflictError');
  });

  it('UnknownSchemeError carries diagnostic fields', () => {
    const err = new UnknownSchemeError('git', 'git://host/x');
    expect(err.scheme).toBe('git');
    expect(err.uri).toBe('git://host/x');
    expect(err.name).toBe('UnknownSchemeError');
  });
});
