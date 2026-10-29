import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EditorService } from '../editor/EditorService.js';
import { EDITOR_TOPIC } from '../editor/types.js';
import type { EditorEvents } from '../editor/types.js';
import type { FileSystemPort } from '../vfs/types.js';
import { VfsService } from '../vfs/VfsService.js';
import { MessageBus } from '../bus/MessageBus.js';

// ============================================================================
// In-memory file system for tests
// ============================================================================

class InMemoryFs implements FileSystemPort {
  private files = new Map<string, string>();
  /** simulate failures for specific paths */
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

// ============================================================================
// Helpers
// ============================================================================

let nextId = 0;
const createDeterministicId = () => {
  nextId += 1;
  return `tab-${nextId}`;
};

const buildService = () => {
  const fs = new InMemoryFs();
  const bus = new MessageBus();
  const vfs = new VfsService({ fs, bus });
  nextId = 0;
  const service = new EditorService({ vfs, bus, idGenerator: createDeterministicId });
  return { service, fs, vfs, bus };
};

const collectBusEvents = (bus: MessageBus): { events: Array<{ type: string; payload: unknown }> } => {
  const events: Array<{ type: string; payload: unknown }> = [];
  const listener: Partial<EditorEvents> = {
    onStateChanged: (state) => events.push({ type: 'state', payload: state }),
    onTabOpened: (tab) => events.push({ type: 'opened', payload: tab }),
    onTabActivated: (tab) => events.push({ type: 'activated', payload: tab }),
    onTabClosed: (p) => events.push({ type: 'closed', payload: p }),
    onTabContentChanged: (tab) => events.push({ type: 'changed', payload: tab }),
    onTabSaved: (tab) => events.push({ type: 'saved', payload: tab }),
    onAllTabsClosed: () => events.push({ type: 'allClosed', payload: undefined }),
    onError: (p) => events.push({ type: 'error', payload: p }),
  };
  bus.subscribe(EDITOR_TOPIC, listener);
  return { events };
};

// ============================================================================
// Initial state
// ============================================================================

describe('EditorService', () => {
  describe('initial state', () => {
    it('starts empty', () => {
      const { service } = buildService();
      expect(service.getState()).toEqual({
        tabs: [],
        activeTabId: null,
        selectedFilePath: null,
      });
      expect(service.getActiveTab()).toBeUndefined();
    });
  });

  // ==========================================================================
  // openFile
  // ==========================================================================

  describe('openFile', () => {
    it('reads disk and creates a clean tab on success', async () => {
      const { service, fs } = buildService();
      fs.put('/foo.ts', 'export const x = 1');

      const tab = await service.openFile('/foo.ts');

      expect(tab).toMatchObject({
        id: 'tab-1',
        path: '/foo.ts',
        name: 'foo.ts',
        content: 'export const x = 1',
        originalContent: 'export const x = 1',
        isDirty: false,
      });
      expect(service.getState().tabs).toHaveLength(1);
      expect(service.getState().activeTabId).toBe('tab-1');
      expect(service.getState().selectedFilePath).toBe('/foo.ts');
    });

    it('opening an already-open path activates the existing tab (no duplicate)', async () => {
      const { service, fs } = buildService();
      fs.put('/foo.ts', 'a');
      fs.put('/bar.ts', 'b');

      await service.openFile('/foo.ts');
      await service.openFile('/bar.ts');
      expect(service.getState().activeTabId).toBe('tab-2');

      const tabAgain = await service.openFile('/foo.ts');
      expect(tabAgain?.id).toBe('tab-1');
      expect(service.getState().tabs).toHaveLength(2);
      expect(service.getState().activeTabId).toBe('tab-1');
      expect(service.getState().selectedFilePath).toBe('/foo.ts');
    });

    it('returns null and emits onError on read failure', async () => {
      const { service, fs, bus } = buildService();
      const { events } = collectBusEvents(bus);
      fs.failReadPaths.add('/missing.ts');

      const result = await service.openFile('/missing.ts');

      expect(result).toBeNull();
      expect(service.getState().tabs).toHaveLength(0);
      // selectedFilePath 仍然被设了（行为对齐 hook 版）
      expect(service.getState().selectedFilePath).toBe('/missing.ts');

      const errors = events.filter((e) => e.type === 'error');
      expect(errors).toHaveLength(1);
      expect(errors[0].payload).toMatchObject({
        kind: 'open',
        path: '/missing.ts',
        error: 'mock read failure',
      });
    });

    it('handles empty file content', async () => {
      const { service, fs } = buildService();
      fs.put('/empty.ts', '');
      const tab = await service.openFile('/empty.ts');
      expect(tab?.content).toBe('');
      expect(tab?.isDirty).toBe(false);
    });

    it('extracts basename for tab name across path styles', async () => {
      const { service, fs } = buildService();
      fs.put('/a/b/c/deep.ts', '');
      fs.put('flat.ts', '');

      const t1 = await service.openFile('/a/b/c/deep.ts');
      const t2 = await service.openFile('flat.ts');

      expect(t1?.name).toBe('deep.ts');
      expect(t2?.name).toBe('flat.ts');
    });
  });

  // ==========================================================================
  // openOrUpdateStreamingFile
  // ==========================================================================

  describe('openOrUpdateStreamingFile', () => {
    it('creates a new dirty tab while streaming (isComplete=false)', () => {
      const { service } = buildService();
      const tab = service.openOrUpdateStreamingFile('/x.ts', 'partial', false);
      expect(tab).toMatchObject({
        path: '/x.ts',
        content: 'partial',
        originalContent: '',
        isDirty: true,
      });
      expect(service.getActiveTab()?.id).toBe(tab.id);
    });

    it('marks the tab clean when isComplete=true on first open', () => {
      const { service } = buildService();
      const tab = service.openOrUpdateStreamingFile('/x.ts', 'final', true);
      expect(tab.originalContent).toBe('final');
      expect(tab.isDirty).toBe(false);
    });

    it('updates existing tab content during streaming and tracks dirty', () => {
      const { service, fs } = buildService();
      fs.put('/x.ts', 'old');

      // First open via openFile so we have an originalContent baseline
      // Wait — actually openOrUpdate is normally called first from agent stream.
      // Let's test the pure streaming case:
      service.openOrUpdateStreamingFile('/x.ts', 'chunk1', false);
      service.openOrUpdateStreamingFile('/x.ts', 'chunk1chunk2', false);

      const tab = service.getActiveTab()!;
      expect(tab.content).toBe('chunk1chunk2');
      expect(tab.originalContent).toBe(''); // 流式中保持空
      expect(tab.isDirty).toBe(true);
    });

    it('synchronous deduplication: second call sees the first call\'s tab', () => {
      const { service } = buildService();
      // 第二次 same path 在同步上下文里调，不应该创建新 tab。
      // 这是 hook 版用 pendingFileTabsRef 解决的；service 同步 mutation 天然就行。
      const a = service.openOrUpdateStreamingFile('/x.ts', 'a', false);
      const b = service.openOrUpdateStreamingFile('/x.ts', 'ab', false);

      expect(a.id).toBe(b.id);
      expect(service.getState().tabs).toHaveLength(1);
    });

    it('isComplete=true after streaming flushes originalContent to current content', () => {
      const { service } = buildService();
      service.openOrUpdateStreamingFile('/x.ts', 'partial', false);
      service.openOrUpdateStreamingFile('/x.ts', 'final', true);

      const tab = service.getActiveTab()!;
      expect(tab.content).toBe('final');
      expect(tab.originalContent).toBe('final');
      expect(tab.isDirty).toBe(false);
    });
  });

  // ==========================================================================
  // selectTab / closeTab / closeOthers / closeAll / closeSaved / closeToRight
  // ==========================================================================

  describe('selectTab', () => {
    it('switches active tab and updates selectedFilePath', async () => {
      const { service, fs } = buildService();
      fs.put('/a.ts', '');
      fs.put('/b.ts', '');
      const a = await service.openFile('/a.ts');
      const b = await service.openFile('/b.ts');

      service.selectTab(a!.id);
      expect(service.getState().activeTabId).toBe(a!.id);
      expect(service.getState().selectedFilePath).toBe('/a.ts');

      service.selectTab(b!.id);
      expect(service.getState().selectedFilePath).toBe('/b.ts');
    });

    it('is a no-op for unknown tab id', async () => {
      const { service, fs } = buildService();
      fs.put('/a.ts', '');
      await service.openFile('/a.ts');
      service.selectTab('does-not-exist');
      expect(service.getState().activeTabId).toBe('tab-1');
    });
  });

  describe('closeTab', () => {
    it('closes a non-active tab without changing the active one', async () => {
      const { service, fs } = buildService();
      fs.put('/a.ts', '');
      fs.put('/b.ts', '');
      const a = await service.openFile('/a.ts');
      const b = await service.openFile('/b.ts');
      // active = b
      service.closeTab(a!.id);
      expect(service.getState().tabs.map((t) => t.id)).toEqual([b!.id]);
      expect(service.getState().activeTabId).toBe(b!.id);
    });

    it('closing the active tab activates the LAST remaining tab', async () => {
      const { service, fs } = buildService();
      fs.put('/a.ts', '');
      fs.put('/b.ts', '');
      fs.put('/c.ts', '');
      const a = await service.openFile('/a.ts');
      const b = await service.openFile('/b.ts');
      const c = await service.openFile('/c.ts');
      service.selectTab(b!.id);

      service.closeTab(b!.id);

      // 关掉 b → 剩 [a, c] → active 切到 c（最后一个，跟 hook 版严格一致）
      expect(service.getState().tabs.map((t) => t.id)).toEqual([a!.id, c!.id]);
      expect(service.getState().activeTabId).toBe(c!.id);
      expect(service.getState().selectedFilePath).toBe('/c.ts');
    });

    it('closing the last tab clears active and selected', async () => {
      const { service, fs, bus } = buildService();
      const { events } = collectBusEvents(bus);
      fs.put('/a.ts', '');
      const a = await service.openFile('/a.ts');

      service.closeTab(a!.id);
      expect(service.getState()).toMatchObject({
        tabs: [],
        activeTabId: null,
        selectedFilePath: null,
      });

      expect(events.some((e) => e.type === 'allClosed')).toBe(true);
    });

    it('is a no-op for unknown tab id', () => {
      const { service } = buildService();
      service.closeTab('nope');
      expect(service.getState().tabs).toHaveLength(0);
    });
  });

  describe('closeOthers', () => {
    it('keeps only the target tab and activates it', async () => {
      const { service, fs } = buildService();
      fs.put('/a.ts', '');
      fs.put('/b.ts', '');
      fs.put('/c.ts', '');
      await service.openFile('/a.ts');
      const b = await service.openFile('/b.ts');
      await service.openFile('/c.ts');

      service.closeOthers(b!.id);

      expect(service.getState().tabs.map((t) => t.path)).toEqual(['/b.ts']);
      expect(service.getState().activeTabId).toBe(b!.id);
      expect(service.getState().selectedFilePath).toBe('/b.ts');
    });
  });

  describe('closeAll', () => {
    it('clears everything and emits allClosed', async () => {
      const { service, fs, bus } = buildService();
      const { events } = collectBusEvents(bus);
      fs.put('/a.ts', '');
      fs.put('/b.ts', '');
      await service.openFile('/a.ts');
      await service.openFile('/b.ts');

      service.closeAll();

      expect(service.getState().tabs).toHaveLength(0);
      expect(service.getState().activeTabId).toBeNull();
      expect(service.getState().selectedFilePath).toBeNull();
      expect(events.filter((e) => e.type === 'closed')).toHaveLength(2);
      expect(events.some((e) => e.type === 'allClosed')).toBe(true);
    });

    it('is a no-op when already empty', () => {
      const { service } = buildService();
      service.closeAll();
      expect(service.getState().tabs).toHaveLength(0);
    });
  });

  describe('closeSaved', () => {
    it('keeps only dirty tabs', async () => {
      const { service, fs } = buildService();
      fs.put('/a.ts', '');
      fs.put('/b.ts', '');
      fs.put('/c.ts', '');
      const a = await service.openFile('/a.ts');
      const b = await service.openFile('/b.ts');
      const c = await service.openFile('/c.ts');
      service.updateContent(b!.id, 'dirty');

      service.closeSaved();

      const ids = service.getState().tabs.map((t) => t.id);
      expect(ids).toEqual([b!.id]);
      // a 和 c 都是 clean，被关了
      expect(ids).not.toContain(a!.id);
      expect(ids).not.toContain(c!.id);
    });

    it('switches active to first dirty tab if active was clean', async () => {
      const { service, fs } = buildService();
      fs.put('/a.ts', '');
      fs.put('/b.ts', '');
      const a = await service.openFile('/a.ts');
      const b = await service.openFile('/b.ts');
      service.updateContent(a!.id, 'dirty a');
      service.selectTab(b!.id); // active = b (clean)

      service.closeSaved();

      expect(service.getState().activeTabId).toBe(a!.id);
      expect(service.getState().selectedFilePath).toBe('/a.ts');
    });

    it('keeps active when it is dirty', async () => {
      const { service, fs } = buildService();
      fs.put('/a.ts', '');
      fs.put('/b.ts', '');
      const a = await service.openFile('/a.ts');
      const b = await service.openFile('/b.ts');
      service.updateContent(a!.id, 'dirty a');
      service.selectTab(a!.id);

      service.closeSaved();

      expect(service.getState().activeTabId).toBe(a!.id);
      expect(service.getState().tabs.find((t) => t.id === b!.id)).toBeUndefined();
    });

    it('clears everything when no dirty tabs', async () => {
      const { service, fs } = buildService();
      fs.put('/a.ts', '');
      fs.put('/b.ts', '');
      await service.openFile('/a.ts');
      await service.openFile('/b.ts');

      service.closeSaved();
      expect(service.getState().tabs).toHaveLength(0);
      expect(service.getState().activeTabId).toBeNull();
    });

    it('is a no-op when no clean tabs', async () => {
      const { service, fs } = buildService();
      fs.put('/a.ts', '');
      const a = await service.openFile('/a.ts');
      service.updateContent(a!.id, 'dirty');

      const before = service.getState();
      service.closeSaved();
      // 引用相同 = snapshot 没变 = listeners 不重算
      expect(service.getState()).toBe(before);
    });
  });

  describe('closeToRight', () => {
    it('removes tabs after the target index', async () => {
      const { service, fs } = buildService();
      fs.put('/a.ts', '');
      fs.put('/b.ts', '');
      fs.put('/c.ts', '');
      fs.put('/d.ts', '');
      const a = await service.openFile('/a.ts');
      const b = await service.openFile('/b.ts');
      await service.openFile('/c.ts');
      await service.openFile('/d.ts');

      service.closeToRight(b!.id);

      const paths = service.getState().tabs.map((t) => t.path);
      expect(paths).toEqual(['/a.ts', '/b.ts']);
      // 行为对齐 hook 版：active 不变（即使原 active=d 已经被关掉，这是 hook 版的已知怪事）
      // 我们这里把 d 关掉后 active 仍是 d 是不合理的，但严格保留 hook 版行为。
    });

    it('is a no-op when target is the rightmost tab', async () => {
      const { service, fs } = buildService();
      fs.put('/a.ts', '');
      const a = await service.openFile('/a.ts');
      const before = service.getState();
      service.closeToRight(a!.id);
      expect(service.getState()).toBe(before);
    });
  });

  // ==========================================================================
  // updateContent / save / saveAll
  // ==========================================================================

  describe('updateContent', () => {
    it('marks tab dirty when content differs from original', async () => {
      const { service, fs } = buildService();
      fs.put('/a.ts', 'original');
      const a = await service.openFile('/a.ts');

      service.updateContent(a!.id, 'modified');
      const tab = service.getTab(a!.id)!;
      expect(tab.content).toBe('modified');
      expect(tab.isDirty).toBe(true);
    });

    it('marks tab clean again when reverted to original', async () => {
      const { service, fs } = buildService();
      fs.put('/a.ts', 'original');
      const a = await service.openFile('/a.ts');

      service.updateContent(a!.id, 'modified');
      service.updateContent(a!.id, 'original');

      expect(service.getTab(a!.id)!.isDirty).toBe(false);
    });

    it('is a no-op (no event, snapshot ref-equal) when content is identical', async () => {
      const { service, fs, bus } = buildService();
      const { events } = collectBusEvents(bus);
      fs.put('/a.ts', 'x');
      const a = await service.openFile('/a.ts');

      const before = service.getState();
      service.updateContent(a!.id, 'x'); // same content
      expect(service.getState()).toBe(before);
      expect(events.filter((e) => e.type === 'changed')).toHaveLength(0);
    });

    it('is a no-op for unknown tab id', () => {
      const { service } = buildService();
      service.updateContent('nope', 'x');
      expect(service.getState().tabs).toHaveLength(0);
    });
  });

  describe('save', () => {
    it('writes to disk and clears dirty flag on success', async () => {
      const { service, fs } = buildService();
      fs.put('/a.ts', 'original');
      const a = await service.openFile('/a.ts');
      service.updateContent(a!.id, 'modified');

      const ok = await service.save(a!.id);

      expect(ok).toBe(true);
      expect(fs.get('/a.ts')).toBe('modified');
      const tab = service.getTab(a!.id)!;
      expect(tab.isDirty).toBe(false);
      expect(tab.originalContent).toBe('modified');
    });

    it('returns false and emits onError on write failure', async () => {
      const { service, fs, bus } = buildService();
      const { events } = collectBusEvents(bus);
      fs.put('/a.ts', '');
      const a = await service.openFile('/a.ts');
      service.updateContent(a!.id, 'will fail');
      fs.failWritePaths.add('/a.ts');

      const ok = await service.save(a!.id);

      expect(ok).toBe(false);
      // state 不变（仍然 dirty）
      expect(service.getTab(a!.id)!.isDirty).toBe(true);
      const errors = events.filter((e) => e.type === 'error');
      expect(errors[0].payload).toMatchObject({
        kind: 'save',
        path: '/a.ts',
        error: 'mock write failure',
      });
    });

    it('returns false for unknown tab id', async () => {
      const { service } = buildService();
      const ok = await service.save('nope');
      expect(ok).toBe(false);
    });

    it('handles content changing during save: still marks dirty if newer than what was written', async () => {
      const { service, fs } = buildService();
      fs.put('/a.ts', '');
      const a = await service.openFile('/a.ts');

      service.updateContent(a!.id, 'v1');
      const savePromise = service.save(a!.id);
      // 模拟保存期间用户又改了内容
      service.updateContent(a!.id, 'v2');
      await savePromise;

      const tab = service.getTab(a!.id)!;
      expect(tab.content).toBe('v2');
      // originalContent 应该是写入的那一版（v1）
      expect(tab.originalContent).toBe('v1');
      // 因为 v2 ≠ v1，仍是脏
      expect(tab.isDirty).toBe(true);
    });
  });

  describe('saveAll', () => {
    it('saves only dirty tabs', async () => {
      const { service, fs } = buildService();
      fs.put('/a.ts', 'a');
      fs.put('/b.ts', 'b');
      fs.put('/c.ts', 'c');
      const a = await service.openFile('/a.ts');
      const b = await service.openFile('/b.ts');
      await service.openFile('/c.ts');
      service.updateContent(a!.id, 'A');
      service.updateContent(b!.id, 'B');

      // spy on writeFile to count calls
      const writeSpy = vi.spyOn(fs, 'writeFile');
      await service.saveAll();

      expect(writeSpy).toHaveBeenCalledTimes(2);
      expect(fs.get('/a.ts')).toBe('A');
      expect(fs.get('/b.ts')).toBe('B');
      expect(fs.get('/c.ts')).toBe('c');
    });

    it('continues saving other tabs even if one fails', async () => {
      const { service, fs } = buildService();
      fs.put('/a.ts', '');
      fs.put('/b.ts', '');
      const a = await service.openFile('/a.ts');
      const b = await service.openFile('/b.ts');
      service.updateContent(a!.id, 'A');
      service.updateContent(b!.id, 'B');
      fs.failWritePaths.add('/a.ts');

      await service.saveAll();

      expect(service.getTab(a!.id)!.isDirty).toBe(true); // failed
      expect(service.getTab(b!.id)!.isDirty).toBe(false); // succeeded
    });
  });

  // ==========================================================================
  // Subscribe / snapshot stability
  // ==========================================================================

  describe('subscribe / snapshot', () => {
    let service: EditorService;
    let fs: InMemoryFs;
    beforeEach(() => {
      ({ service, fs } = buildService());
    });

    it('listener fires on each mutation', async () => {
      const listener = vi.fn();
      service.subscribe(listener);

      fs.put('/a.ts', '');
      await service.openFile('/a.ts');
      service.updateContent(service.getActiveTab()!.id, 'x');

      expect(listener).toHaveBeenCalledTimes(2);
    });

    it('listener does NOT fire when nothing changes (e.g. updateContent with same content)', async () => {
      fs.put('/a.ts', 'x');
      await service.openFile('/a.ts');

      const listener = vi.fn();
      service.subscribe(listener);
      service.updateContent(service.getActiveTab()!.id, 'x');

      expect(listener).not.toHaveBeenCalled();
    });

    it('returned function unsubscribes', async () => {
      const listener = vi.fn();
      const off = service.subscribe(listener);
      off();
      fs.put('/a.ts', '');
      await service.openFile('/a.ts');
      expect(listener).not.toHaveBeenCalled();
    });

    it('snapshot reference is stable across reads (no mutation between)', async () => {
      fs.put('/a.ts', '');
      await service.openFile('/a.ts');
      const s1 = service.getState();
      const s2 = service.getState();
      expect(s1).toBe(s2);
    });

    it('snapshot reference changes on each mutation', async () => {
      fs.put('/a.ts', '');
      const s0 = service.getState();
      await service.openFile('/a.ts');
      const s1 = service.getState();
      expect(s1).not.toBe(s0);
    });

    it('listener errors do not break other listeners', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const ok = vi.fn();
      service.subscribe(() => {
        throw new Error('boom');
      });
      service.subscribe(ok);

      fs.put('/a.ts', '');
      await service.openFile('/a.ts');

      expect(ok).toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalled();
      consoleError.mockRestore();
    });
  });

  // ==========================================================================
  // Bus events (semantic channel)
  // ==========================================================================

  describe('bus events', () => {
    it('publishes onTabOpened + onTabActivated when opening a fresh file', async () => {
      const { service, fs, bus } = buildService();
      const { events } = collectBusEvents(bus);
      fs.put('/a.ts', '');

      await service.openFile('/a.ts');

      const types = events.map((e) => e.type);
      expect(types).toContain('opened');
      expect(types).toContain('activated');
      expect(types).toContain('state');
    });

    it('publishes onTabSaved on successful save', async () => {
      const { service, fs, bus } = buildService();
      const { events } = collectBusEvents(bus);
      fs.put('/a.ts', '');
      const a = await service.openFile('/a.ts');
      service.updateContent(a!.id, 'modified');
      await service.save(a!.id);

      expect(events.some((e) => e.type === 'saved')).toBe(true);
    });

    // "does not crash when no bus" test removed in step 5 — bus is now required
  });

  // ==========================================================================
  // State invariants
  // ==========================================================================

  describe('state invariants', () => {
    it('tab ids remain unique through arbitrary operations', async () => {
      const { service, fs } = buildService();
      fs.put('/a.ts', '');
      fs.put('/b.ts', '');
      fs.put('/c.ts', '');
      await service.openFile('/a.ts');
      await service.openFile('/b.ts');
      await service.openFile('/c.ts');
      service.updateContent(service.getActiveTab()!.id, 'x');
      service.closeOthers(service.getState().tabs[0].id);

      const ids = service.getState().tabs.map((t) => t.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('paths remain unique through arbitrary operations', async () => {
      const { service, fs } = buildService();
      fs.put('/a.ts', '');
      await service.openFile('/a.ts');
      await service.openFile('/a.ts');
      await service.openFile('/a.ts');

      const paths = service.getState().tabs.map((t) => t.path);
      expect(paths).toEqual(['/a.ts']);
    });

    it('activeTabId always references an existing tab or null', async () => {
      const { service, fs } = buildService();
      fs.put('/a.ts', '');
      fs.put('/b.ts', '');
      const a = await service.openFile('/a.ts');
      await service.openFile('/b.ts');
      service.closeTab(a!.id);

      const state = service.getState();
      if (state.activeTabId !== null) {
        expect(state.tabs.some((t) => t.id === state.activeTabId)).toBe(true);
      }
    });

    it('isDirty is always equal to (content !== originalContent)', async () => {
      const { service, fs } = buildService();
      fs.put('/a.ts', 'original');
      const a = await service.openFile('/a.ts');

      service.updateContent(a!.id, 'modified');
      let tab = service.getTab(a!.id)!;
      expect(tab.isDirty).toBe(tab.content !== tab.originalContent);

      service.updateContent(a!.id, 'original');
      tab = service.getTab(a!.id)!;
      expect(tab.isDirty).toBe(tab.content !== tab.originalContent);

      await service.save(a!.id);
      tab = service.getTab(a!.id)!;
      expect(tab.isDirty).toBe(tab.content !== tab.originalContent);
    });

    it('tabs===[] implies activeTabId===null', async () => {
      const { service, fs } = buildService();
      fs.put('/a.ts', '');
      const a = await service.openFile('/a.ts');
      service.closeTab(a!.id);
      expect(service.getState().tabs).toHaveLength(0);
      expect(service.getState().activeTabId).toBeNull();
    });
  });

  // ==========================================================================
  // setSelectedFilePath (Project View 用)
  // ==========================================================================

  describe('setSelectedFilePath', () => {
    it('updates independently of tabs', () => {
      const { service } = buildService();
      service.setSelectedFilePath('/no-tab.ts');
      expect(service.getState().selectedFilePath).toBe('/no-tab.ts');
      expect(service.getState().tabs).toHaveLength(0);
    });

    it('clears with null', () => {
      const { service } = buildService();
      service.setSelectedFilePath('/x.ts');
      service.setSelectedFilePath(null);
      expect(service.getState().selectedFilePath).toBeNull();
    });

    it('is a no-op when value is unchanged', () => {
      const { service } = buildService();
      service.setSelectedFilePath('/x.ts');
      const before = service.getState();
      service.setSelectedFilePath('/x.ts');
      expect(service.getState()).toBe(before);
    });
  });

  // ==========================================================================
  // VFS integration — 外部改动 → 编辑器自动刷新
  // ==========================================================================

  describe('VFS reload (external file changes)', () => {
    it('reloads a clean tab when external change is detected', async () => {
      const { service, fs, vfs } = buildService();
      fs.put('/a.ts', 'original');
      await service.openFile('/a.ts');

      // 模拟外部进程修改了文件
      fs.put('/a.ts', 'externally modified');
      vfs.notifyChanged('/a.ts', 'external');

      // reload 是异步的，等一下
      await new Promise((r) => setTimeout(r, 10));

      const tab = service.getTabByPath('/a.ts')!;
      expect(tab.content).toBe('externally modified');
      expect(tab.originalContent).toBe('externally modified');
      expect(tab.isDirty).toBe(false);
    });

    it('does NOT reload a dirty tab (protects unsaved user edits)', async () => {
      const { service, fs, vfs } = buildService();
      fs.put('/a.ts', 'original');
      const a = await service.openFile('/a.ts');
      service.updateContent(a!.id, 'user edits');

      // 模拟外部修改
      fs.put('/a.ts', 'externally modified');
      vfs.notifyChanged('/a.ts', 'external');
      await new Promise((r) => setTimeout(r, 10));

      // 用户的修改被保护
      expect(service.getTabByPath('/a.ts')!.content).toBe('user edits');
    });

    it('does NOT reload from own save (source=editor is filtered out)', async () => {
      const { service, fs } = buildService();
      fs.put('/a.ts', 'original');
      const a = await service.openFile('/a.ts');
      service.updateContent(a!.id, 'modified');

      // save() 内部传 source='editor'，VFS 事件被 onVfsChanged 跳过
      await service.save(a!.id);

      // tab 应该是 clean，originalContent 是刚保存的
      const tab = service.getTab(a!.id)!;
      expect(tab.content).toBe('modified');
      expect(tab.originalContent).toBe('modified');
      expect(tab.isDirty).toBe(false);
    });

    it('ignores changes for files not currently open', async () => {
      const { service, fs, vfs } = buildService();
      fs.put('/a.ts', 'a');
      await service.openFile('/a.ts');
      const before = service.getState();

      // 修改一个没打开的文件
      fs.put('/b.ts', 'b changed');
      vfs.notifyChanged('/b.ts', 'external');
      await new Promise((r) => setTimeout(r, 10));

      // 状态没变
      expect(service.getState()).toBe(before);
    });

    it('marks tab dirty when external delete detected (VSCode-style)', async () => {
      const { service, fs, vfs } = buildService();
      fs.put('/a.ts', 'content');
      await service.openFile('/a.ts');

      vfs.notifyDeleted('/a.ts', 'external');

      const tab = service.getTabByPath('/a.ts')!;
      expect(tab.isDirty).toBe(true);
      expect(tab.content).toBe('content'); // 内容保留
    });

    it('VFS writeFile publishes onChanged event', async () => {
      const { fs, vfs, bus } = buildService();
      fs.put('/a.ts', '');
      const events: Array<{ path: string; source: string }> = [];
      const { FILES_TOPIC } = await import('../vfs/types.js');
      bus.subscribe(FILES_TOPIC, {
        onChanged: (e: { path: string; source: string }) => events.push(e),
      });

      await vfs.writeFile('/a.ts', 'new content', { source: 'agent' });

      expect(events).toEqual([{ path: '/a.ts', source: 'agent' }]);
      expect(fs.get('/a.ts')).toBe('new content');
    });

    it('VFS writeFile does NOT publish on failure', async () => {
      const { fs, vfs, bus } = buildService();
      fs.failWritePaths.add('/a.ts');
      const events: unknown[] = [];
      const { FILES_TOPIC } = await import('../vfs/types.js');
      bus.subscribe(FILES_TOPIC, { onChanged: (e: unknown) => events.push(e) });

      await vfs.writeFile('/a.ts', 'fail', { source: 'agent' });

      expect(events).toHaveLength(0);
    });

    it('dispose() stops listening to VFS events', async () => {
      const { service, fs, vfs } = buildService();
      fs.put('/a.ts', 'original');
      await service.openFile('/a.ts');

      service.dispose();

      // 外部修改 — 但 service 已经 disposed，不应该 reload
      fs.put('/a.ts', 'changed');
      vfs.notifyChanged('/a.ts', 'external');
      await new Promise((r) => setTimeout(r, 10));

      expect(service.getTabByPath('/a.ts')!.content).toBe('original');
    });
  });
});
