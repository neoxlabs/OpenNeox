/**
 * VfsService 单元测试 —— 隔离测试 VFS 自身行为，不依赖 EditorService。
 * 这些测试是回归保护：未来给 VFS 加缓存 / 多 backend / watch，单测能立刻
 * 抓出语义破坏。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { VfsService } from '../vfs/VfsService.js';
import { FILES_TOPIC } from '../vfs/types.js';
import type { FileChangeEvent, FileSystemPort } from '../vfs/types.js';
import { MessageBus } from '../bus/MessageBus.js';

class InMemoryFs implements FileSystemPort {
  private files = new Map<string, string>();
  failReadPaths = new Set<string>();
  failWritePaths = new Set<string>();

  put(path: string, content: string): void {
    this.files.set(path, content);
  }
  get(path: string): string | undefined {
    return this.files.get(path);
  }

  async readFile(path: string) {
    if (this.failReadPaths.has(path)) {
      return { success: false, error: 'mock read failure' };
    }
    const content = this.files.get(path);
    if (content === undefined) {
      return { success: false, error: 'not found' };
    }
    return { success: true, content };
  }

  async writeFile(path: string, content: string) {
    if (this.failWritePaths.has(path)) {
      return { success: false, error: 'mock write failure' };
    }
    this.files.set(path, content);
    return { success: true };
  }
}

describe('VfsService', () => {
  let fs: InMemoryFs;
  let bus: MessageBus;
  let vfs: VfsService;
  let events: Array<{ kind: string; event: FileChangeEvent }>;

  beforeEach(() => {
    fs = new InMemoryFs();
    bus = new MessageBus();
    vfs = new VfsService({ fs, bus });
    events = [];
    bus.subscribe(FILES_TOPIC, {
      onCreated: (e) => events.push({ kind: 'created', event: e }),
      onChanged: (e) => events.push({ kind: 'changed', event: e }),
      onDeleted: (e) => events.push({ kind: 'deleted', event: e }),
    });
  });

  describe('readFile', () => {
    it('forwards to underlying fs and does NOT publish events', async () => {
      fs.put('/a.ts', 'content');
      const result = await vfs.readFile('/a.ts');

      expect(result).toEqual({ success: true, content: 'content' });
      expect(events).toHaveLength(0);
    });

    it('passes through fs errors', async () => {
      fs.failReadPaths.add('/missing');
      const result = await vfs.readFile('/missing');
      expect(result.success).toBe(false);
      expect(result.error).toBe('mock read failure');
      expect(events).toHaveLength(0);
    });
  });

  describe('writeFile', () => {
    it('writes to fs and publishes onChanged on success', async () => {
      const result = await vfs.writeFile('/a.ts', 'hello', { source: 'agent' });

      expect(result.success).toBe(true);
      expect(fs.get('/a.ts')).toBe('hello');
      expect(events).toEqual([
        { kind: 'changed', event: { path: '/a.ts', source: 'agent' } },
      ]);
    });

    it('does NOT publish on failure', async () => {
      fs.failWritePaths.add('/a.ts');
      const result = await vfs.writeFile('/a.ts', 'hello');

      expect(result.success).toBe(false);
      expect(events).toHaveLength(0);
    });

    it('defaults source to "unknown" when not specified', async () => {
      await vfs.writeFile('/a.ts', 'hello');
      expect(events[0].event.source).toBe('unknown');
    });

    it('preserves source label across all 4 supported values', async () => {
      await vfs.writeFile('/e.ts', 'x', { source: 'editor' });
      await vfs.writeFile('/a.ts', 'x', { source: 'agent' });
      await vfs.writeFile('/x.ts', 'x', { source: 'external' });
      await vfs.writeFile('/u.ts', 'x', { source: 'unknown' });

      const sources = events.map((e) => e.event.source);
      expect(sources).toEqual(['editor', 'agent', 'external', 'unknown']);
    });

    it('publishes after the underlying fs.writeFile resolves (ordering)', async () => {
      // 用一个慢 fs 验证：publish 必须在 await 之后
      const slowFs: FileSystemPort = {
        readFile: async () => ({ success: true, content: '' }),
        writeFile: async (path, content) => {
          await new Promise((r) => setTimeout(r, 5));
          fs.put(path, content);
          return { success: true };
        },
      };
      const slowVfs = new VfsService({ fs: slowFs, bus });

      const before = events.length;
      const promise = slowVfs.writeFile('/slow.ts', 'data');
      // 同步立刻 — publish 还没发生（await 没 resolve）
      expect(events.length).toBe(before);
      await promise;
      // await 之后 — publish 已发生
      expect(events.length).toBe(before + 1);
    });
  });

  describe('notify* (manual event injection)', () => {
    it('notifyChanged publishes onChanged with given source', () => {
      vfs.notifyChanged('/a.ts', 'external');
      expect(events).toEqual([
        { kind: 'changed', event: { path: '/a.ts', source: 'external' } },
      ]);
    });

    it('notifyCreated publishes onCreated', () => {
      vfs.notifyCreated('/new.ts', 'agent');
      expect(events).toEqual([
        { kind: 'created', event: { path: '/new.ts', source: 'agent' } },
      ]);
    });

    it('notifyDeleted publishes onDeleted', () => {
      vfs.notifyDeleted('/gone.ts', 'external');
      expect(events).toEqual([
        { kind: 'deleted', event: { path: '/gone.ts', source: 'external' } },
      ]);
    });

    it('notify* defaults source to "unknown"', () => {
      vfs.notifyChanged('/a');
      vfs.notifyCreated('/b');
      vfs.notifyDeleted('/c');
      expect(events.map((e) => e.event.source)).toEqual(['unknown', 'unknown', 'unknown']);
    });

    it('notify* does NOT touch the underlying fs', () => {
      vfs.notifyChanged('/never-existed');
      expect(fs.get('/never-existed')).toBeUndefined();
    });
  });

  describe('topic isolation', () => {
    it('does not deliver to subscribers of other topics', () => {
      const otherEvents: unknown[] = [];
      const otherBus = new MessageBus();
      otherBus.subscribe(FILES_TOPIC, { onChanged: (e) => otherEvents.push(e) });

      // vfs 用的是原 bus，不是 otherBus
      vfs.notifyChanged('/a');

      expect(events).toHaveLength(1);
      expect(otherEvents).toHaveLength(0);
    });
  });
});
