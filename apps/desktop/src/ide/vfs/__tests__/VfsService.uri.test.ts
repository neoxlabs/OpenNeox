/**
 * VfsService URI API (P6) —— 测 readUri/writeUri 委托 Registry +
 * 事件广播. 旧 readFile/writeFile 路径的回归由 src/ide/__tests__/VfsService.test.ts
 * 负责, 这里不重复.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { VfsService } from '../VfsService.js';
import { VfsUri } from '../uri.js';
import { VfsRegistry, UnknownSchemeError } from '../vfsRegistry.js';
import { MemoryFileSystemProvider } from '../providers/memoryProvider.js';
import { FILES_TOPIC } from '../types.js';
import type { FileChangeEvent, FileSystemPort } from '../types.js';
import { MessageBus } from '../../bus/MessageBus.js';

class DummyPort implements FileSystemPort {
  async readFile() { return { success: true, content: '' }; }
  async writeFile() { return { success: true }; }
}

function makeService(withMemory = true) {
  const port = new DummyPort();
  const bus = new MessageBus();
  const registry = new VfsRegistry();
  if (withMemory) registry.register('memory', new MemoryFileSystemProvider());
  const vfs = new VfsService({ fs: port, bus, registry });
  const events: Array<{ kind: string; event: FileChangeEvent }> = [];
  bus.subscribe(FILES_TOPIC, {
    onChanged: (event) => events.push({ kind: 'changed', event }),
    onCreated: (event) => events.push({ kind: 'created', event }),
    onDeleted: (event) => events.push({ kind: 'deleted', event }),
  });
  return { vfs, registry, events };
}

describe('VfsService.readUri / writeUri · delegation', () => {
  it('writeUri → readUri round-trip via memory provider', async () => {
    const { vfs } = makeService();
    const u = VfsUri.parse('memory:draft-1');
    const w = await vfs.writeUri(u, 'hello', { source: 'agent' });
    expect(w.success).toBe(true);
    const r = await vfs.readUri(u);
    expect(r.content).toBe('hello');
  });

  it('writeUri publishes FILES_TOPIC onChanged with uri-string path', async () => {
    const { vfs, events } = makeService();
    const u = VfsUri.parse('memory:x');
    await vfs.writeUri(u, 'y', { source: 'editor' });
    expect(events).toEqual([
      { kind: 'changed', event: { path: 'memory:x', source: 'editor' } },
    ]);
  });

  it('readUri does NOT publish events', async () => {
    const { vfs, events } = makeService();
    const u = VfsUri.parse('memory:x');
    await vfs.writeUri(u, 'y');
    events.length = 0;
    await vfs.readUri(u);
    expect(events).toEqual([]);
  });

  it('unknown scheme throws UnknownSchemeError', async () => {
    const { vfs } = makeService(false /* no memory */);
    await expect(vfs.readUri(VfsUri.parse('memory:x')))
      .rejects.toThrow(UnknownSchemeError);
  });
});

describe('VfsService.statUri / deleteUri', () => {
  it('statUri returns provider stat', async () => {
    const { vfs } = makeService();
    const u = VfsUri.parse('memory:x');
    await vfs.writeUri(u, 'hi');
    const r = await vfs.statUri(u);
    expect(r.success).toBe(true);
    expect(r.stat!.size).toBe(2);
  });

  it('deleteUri removes and publishes onDeleted', async () => {
    const { vfs, events } = makeService();
    const u = VfsUri.parse('memory:x');
    await vfs.writeUri(u, 'v');
    events.length = 0;
    const r = await vfs.deleteUri(u);
    expect(r.success).toBe(true);
    expect(events).toEqual([
      { kind: 'deleted', event: { path: 'memory:x', source: 'unknown' } },
    ]);
  });

  it('provider without stat returns success:false', async () => {
    const { vfs, registry } = makeService(false);
    registry.register('git', {
      label: 'git-stub',
      async readFile() { return { success: true, content: '' }; },
      async writeFile() { return { success: true }; },
    });
    const r = await vfs.statUri(VfsUri.parse('git://host/x'));
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not supported/);
  });
});

describe('VfsService · auto-registration of file: provider', () => {
  let captured = '';
  beforeEach(() => { captured = ''; });

  it('when no registry passed, file:// goes through injected FileSystemPort', async () => {
    const port: FileSystemPort = {
      async readFile(p: string) {
        captured = p;
        return { success: true, content: 'from-port' };
      },
      async writeFile() { return { success: true }; },
    };
    const vfs = new VfsService({ fs: port, bus: new MessageBus() });
    const u = VfsUri.file('/tmp/a.ts');
    const r = await vfs.readUri(u);
    expect(captured).toBe('/tmp/a.ts');
    expect(r.content).toBe('from-port');
  });

  it('getRegistry exposes the registry for consumer provider registration', () => {
    const port = new DummyPort();
    const vfs = new VfsService({ fs: port, bus: new MessageBus() });
    const reg = vfs.getRegistry();
    expect(reg.has('file')).toBe(true);
    reg.register('memory', new MemoryFileSystemProvider());
    expect(reg.has('memory')).toBe(true);
  });
});
