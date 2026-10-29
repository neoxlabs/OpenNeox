import { describe, it, expect, vi } from 'vitest';
import { MemoryFileSystemProvider } from '../providers/memoryProvider.js';
import { VfsUri } from '../uri.js';

describe('MemoryFileSystemProvider · read / write', () => {
  it('read on unknown uri fails with error', async () => {
    const p = new MemoryFileSystemProvider();
    const r = await p.readFile(VfsUri.parse('memory:missing'));
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/no buffer/);
  });

  it('write then read returns content', async () => {
    const p = new MemoryFileSystemProvider();
    const u = VfsUri.parse('memory:x');
    await p.writeFile(u, 'hello');
    const r = await p.readFile(u);
    expect(r.success).toBe(true);
    expect(r.content).toBe('hello');
  });

  it('write overwrites existing buffer', async () => {
    const p = new MemoryFileSystemProvider();
    const u = VfsUri.parse('memory:x');
    await p.writeFile(u, 'v1');
    await p.writeFile(u, 'v2');
    const r = await p.readFile(u);
    expect(r.content).toBe('v2');
  });

  it('treats memory:x and memory:///x as same buffer (normalization)', async () => {
    const p = new MemoryFileSystemProvider();
    await p.writeFile(VfsUri.parse('memory:shared'), 'hi');
    const r = await p.readFile(VfsUri.parse('memory:///shared'));
    expect(r.success).toBe(true);
    expect(r.content).toBe('hi');
  });
});

describe('MemoryFileSystemProvider · stat / delete', () => {
  it('stat returns size + recent mtime', async () => {
    const p = new MemoryFileSystemProvider();
    const u = VfsUri.parse('memory:x');
    const before = Date.now();
    await p.writeFile(u, 'hello');
    const r = await p.stat!(u);
    expect(r.success).toBe(true);
    expect(r.stat!.type).toBe('file');
    expect(r.stat!.size).toBe(5);
    expect(r.stat!.mtime).toBeGreaterThanOrEqual(before);
  });

  it('stat on missing uri fails', async () => {
    const p = new MemoryFileSystemProvider();
    const r = await p.stat!(VfsUri.parse('memory:nope'));
    expect(r.success).toBe(false);
  });

  it('delete removes the buffer', async () => {
    const p = new MemoryFileSystemProvider();
    const u = VfsUri.parse('memory:x');
    await p.writeFile(u, 'x');
    expect(p.has(u)).toBe(true);
    const r = await p.delete!(u);
    expect(r.success).toBe(true);
    expect(p.has(u)).toBe(false);
  });

  it('delete on missing uri fails', async () => {
    const p = new MemoryFileSystemProvider();
    const r = await p.delete!(VfsUri.parse('memory:nope'));
    expect(r.success).toBe(false);
  });
});

describe('MemoryFileSystemProvider · list', () => {
  it('returns all files when prefix is empty', async () => {
    const p = new MemoryFileSystemProvider();
    await p.writeFile(VfsUri.parse('memory:a'), 'x');
    await p.writeFile(VfsUri.parse('memory:b'), 'y');
    const r = await p.list!(VfsUri.parse('memory:'));
    expect(r.success).toBe(true);
    const names = r.entries!.map((e) => e.name).sort();
    expect(names).toEqual(['a', 'b']);
  });

  it('filters by path prefix', async () => {
    const p = new MemoryFileSystemProvider();
    await p.writeFile(VfsUri.parse('memory:embedded/x.js'), '');
    await p.writeFile(VfsUri.parse('memory:embedded/y.js'), '');
    await p.writeFile(VfsUri.parse('memory:draft-1'), '');
    const r = await p.list!(VfsUri.parse('memory:embedded/'));
    expect(r.entries!.map((e) => e.name).sort()).toEqual(['embedded/x.js', 'embedded/y.js']);
  });
});

describe('MemoryFileSystemProvider · watch events', () => {
  it('fires created on first write', async () => {
    const p = new MemoryFileSystemProvider();
    const events: string[] = [];
    const u = VfsUri.parse('memory:x');
    p.watch!(u, (e) => events.push(e.type));
    await p.writeFile(u, 'hi');
    expect(events).toEqual(['created']);
  });

  it('fires changed on overwrite', async () => {
    const p = new MemoryFileSystemProvider();
    const events: string[] = [];
    const u = VfsUri.parse('memory:x');
    await p.writeFile(u, 'v1');
    p.watch!(u, (e) => events.push(e.type));
    await p.writeFile(u, 'v2');
    expect(events).toEqual(['changed']);
  });

  it('fires deleted when buffer removed', async () => {
    const p = new MemoryFileSystemProvider();
    const events: string[] = [];
    const u = VfsUri.parse('memory:x');
    await p.writeFile(u, 'v');
    p.watch!(u, (e) => events.push(e.type));
    await p.delete!(u);
    expect(events).toEqual(['deleted']);
  });

  it('unsubscribe stops further events', async () => {
    const p = new MemoryFileSystemProvider();
    const fn = vi.fn();
    const u = VfsUri.parse('memory:x');
    const unsub = p.watch!(u, fn);
    await p.writeFile(u, 'v1');
    unsub();
    await p.writeFile(u, 'v2');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('MemoryFileSystemProvider · dispose', () => {
  it('clears all buffers and watchers', async () => {
    const p = new MemoryFileSystemProvider();
    await p.writeFile(VfsUri.parse('memory:x'), 'v');
    expect(p.size()).toBe(1);
    p.dispose();
    expect(p.size()).toBe(0);
  });
});
