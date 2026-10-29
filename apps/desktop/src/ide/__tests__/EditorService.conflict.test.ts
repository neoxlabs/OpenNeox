import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EditorService } from '../editor/EditorService.js';
import type { FileSystemPort, FileChangeEvent } from '../vfs/types.js';
import { VfsService } from '../vfs/VfsService.js';
import { FILES_TOPIC } from '../vfs/types.js';
import { MessageBus } from '../bus/MessageBus.js';
import { EDITOR_TOPIC } from '../editor/types.js';

class InMemoryFs implements FileSystemPort {
  private files = new Map<string, string>();
  put(path: string, content: string): void {
    this.files.set(path, content);
  }
  async readFile(path: string) {
    const content = this.files.get(path);
    if (content === undefined) return { success: false, error: 'not found' };
    return { success: true, content };
  }
  async writeFile(path: string, content: string) {
    this.files.set(path, content);
    return { success: true };
  }
}

let nextId = 0;
const createId = () => `tab-${++nextId}`;

const buildService = () => {
  nextId = 0;
  const fs = new InMemoryFs();
  const bus = new MessageBus();
  const vfs = new VfsService({ fs, bus });
  const service = new EditorService({ vfs, bus, idGenerator: createId });
  return { service, fs, vfs, bus };
};

// 模拟"另一个进程"修改文件: 直接改 fs, 然后手动发 external 事件
function simulateExternalChange(
  fs: InMemoryFs,
  bus: MessageBus,
  path: string,
  newContent: string,
): void {
  fs.put(path, newContent);
  bus.publisher(FILES_TOPIC).onChanged({ path, source: 'external' } as FileChangeEvent);
}

describe('EditorService · external conflict detection', () => {
  it('dirty tab + external change → sets conflict state', async () => {
    const { service, fs, bus } = buildService();
    fs.put('/a.ts', 'original');
    await service.openFile('/a.ts');
    const tab = service.getTabByPath('/a.ts')!;
    service.updateContent(tab.id, 'local edit');
    expect(service.getTab(tab.id)!.isDirty).toBe(true);

    let conflictEvent: any = null;
    bus.subscribe(EDITOR_TOPIC, {
      onExternalConflict: (t) => { conflictEvent = t; },
    });

    simulateExternalChange(fs, bus, '/a.ts', 'external edit');
    // onVfsChanged → detectConflict 是 async, 等一下
    await new Promise((r) => setTimeout(r, 10));

    const after = service.getTab(tab.id)!;
    expect(after.conflict).toBeDefined();
    expect(after.conflict!.diskContent).toBe('external edit');
    expect(conflictEvent).toBeTruthy();
  });

  it('clean tab + external change → reloads, no conflict', async () => {
    const { service, fs, bus } = buildService();
    fs.put('/a.ts', 'v1');
    await service.openFile('/a.ts');
    const tab = service.getTabByPath('/a.ts')!;
    expect(tab.isDirty).toBe(false);

    simulateExternalChange(fs, bus, '/a.ts', 'v2');
    await new Promise((r) => setTimeout(r, 10));

    const after = service.getTab(tab.id)!;
    expect(after.conflict).toBeUndefined();
    expect(after.content).toBe('v2');
    expect(after.isDirty).toBe(false);
  });

  it('resolveConflictKeepMine keeps content, updates originalContent', async () => {
    const { service, fs, bus } = buildService();
    fs.put('/a.ts', 'v1');
    await service.openFile('/a.ts');
    const tab = service.getTabByPath('/a.ts')!;
    service.updateContent(tab.id, 'my edit');
    simulateExternalChange(fs, bus, '/a.ts', 'their edit');
    await new Promise((r) => setTimeout(r, 10));

    service.resolveConflictKeepMine(tab.id);
    const after = service.getTab(tab.id)!;
    expect(after.conflict).toBeUndefined();
    expect(after.content).toBe('my edit');
    expect(after.originalContent).toBe('their edit'); // 下次 save 会覆盖 disk
    expect(after.isDirty).toBe(true);
  });

  it('resolveConflictUseTheirs adopts disk content', async () => {
    const { service, fs, bus } = buildService();
    fs.put('/a.ts', 'v1');
    await service.openFile('/a.ts');
    const tab = service.getTabByPath('/a.ts')!;
    service.updateContent(tab.id, 'my edit');
    simulateExternalChange(fs, bus, '/a.ts', 'their edit');
    await new Promise((r) => setTimeout(r, 10));

    service.resolveConflictUseTheirs(tab.id);
    const after = service.getTab(tab.id)!;
    expect(after.conflict).toBeUndefined();
    expect(after.content).toBe('their edit');
    expect(after.originalContent).toBe('their edit');
    expect(after.isDirty).toBe(false);
  });

  it('resolveConflictShowDiff opens a diff tab with both versions', async () => {
    const { service, fs, bus } = buildService();
    fs.put('/a.ts', 'v1');
    await service.openFile('/a.ts');
    const tab = service.getTabByPath('/a.ts')!;
    service.updateContent(tab.id, 'mine');
    simulateExternalChange(fs, bus, '/a.ts', 'theirs');
    await new Promise((r) => setTimeout(r, 10));

    const diffTab = service.resolveConflictShowDiff(tab.id);
    expect(diffTab).toBeTruthy();
    expect(diffTab!.diffMode).toBeDefined();
    expect(diffTab!.diffMode!.originalContent).toBe('theirs');
    expect(diffTab!.diffMode!.modifiedContent).toBe('mine');
    // 原 tab 仍保留 conflict (用户还没真正解决)
    expect(service.getTab(tab.id)!.conflict).toBeDefined();
  });

  it('identical external content does not raise conflict', async () => {
    const { service, fs, bus } = buildService();
    fs.put('/a.ts', 'v1');
    await service.openFile('/a.ts');
    const tab = service.getTabByPath('/a.ts')!;
    service.updateContent(tab.id, 'same');
    simulateExternalChange(fs, bus, '/a.ts', 'same');
    await new Promise((r) => setTimeout(r, 10));

    const after = service.getTab(tab.id)!;
    expect(after.conflict).toBeUndefined();
    expect(after.isDirty).toBe(false); // content == disk → 等价 clean
  });
});

describe('EditorService · auto-save', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('schedules save after updateContent debounce', async () => {
    const { service, fs } = buildService();
    fs.put('/a.ts', 'v1');
    await service.openFile('/a.ts');
    const tab = service.getTabByPath('/a.ts')!;
    service.setAutoSave({ delayMs: 500 });

    service.updateContent(tab.id, 'v2');
    expect(fs['files'].get('/a.ts')).toBe('v1'); // 还没存
    await vi.advanceTimersByTimeAsync(600);
    expect(fs['files'].get('/a.ts')).toBe('v2');
    expect(service.getTab(tab.id)!.isDirty).toBe(false);
  });

  it('successive edits reset the debounce (only last save fires)', async () => {
    const { service, fs } = buildService();
    fs.put('/a.ts', 'v1');
    await service.openFile('/a.ts');
    const tab = service.getTabByPath('/a.ts')!;
    service.setAutoSave({ delayMs: 500 });

    service.updateContent(tab.id, 'v2');
    await vi.advanceTimersByTimeAsync(300);
    service.updateContent(tab.id, 'v3');
    await vi.advanceTimersByTimeAsync(300);
    expect(fs['files'].get('/a.ts')).toBe('v1'); // 仍未触发
    await vi.advanceTimersByTimeAsync(250);
    expect(fs['files'].get('/a.ts')).toBe('v3');
  });

  it('disable auto-save skips saving', async () => {
    const { service, fs } = buildService();
    fs.put('/a.ts', 'v1');
    await service.openFile('/a.ts');
    const tab = service.getTabByPath('/a.ts')!;
    service.setAutoSave({ enabled: false });

    service.updateContent(tab.id, 'v2');
    await vi.advanceTimersByTimeAsync(5000);
    expect(fs['files'].get('/a.ts')).toBe('v1');
    expect(service.getTab(tab.id)!.isDirty).toBe(true);
  });

  it('skips streaming tab', async () => {
    const { service, fs } = buildService();
    service.setAutoSave({ delayMs: 100 });
    service.openOrUpdateStreamingFile('/stream.ts', 'partial', false);
    await vi.advanceTimersByTimeAsync(300);
    // 流式期间 fs 原本就没这个 path, 不应该新建/覆盖
    expect(fs['files'].get('/stream.ts')).toBeUndefined();
    // 完成后 isComplete=true, 此时 isDirty=false 不触发 auto-save
    service.openOrUpdateStreamingFile('/stream.ts', 'final', true);
    await vi.advanceTimersByTimeAsync(300);
    expect(fs['files'].get('/stream.ts')).toBeUndefined();
  });

  it('skips tab with active conflict', async () => {
    const { service, fs, bus } = buildService();
    service.setAutoSave({ delayMs: 100 });
    fs.put('/a.ts', 'v1');
    await service.openFile('/a.ts');
    const tab = service.getTabByPath('/a.ts')!;
    service.updateContent(tab.id, 'mine');
    simulateExternalChange(fs, bus, '/a.ts', 'theirs');
    // detectConflict 是 async, 先用真实 timer 等一下
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 10));
    vi.useFakeTimers();
    const after = service.getTab(tab.id)!;
    expect(after.conflict).toBeDefined();
    // 在 conflict 状态再触发一次 updateContent, auto-save 不应落盘覆盖 disk
    service.updateContent(tab.id, 'mine-v2');
    await vi.advanceTimersByTimeAsync(500);
    expect(fs['files'].get('/a.ts')).toBe('theirs'); // 还是 disk 的版本, 没被覆盖
  });
});
