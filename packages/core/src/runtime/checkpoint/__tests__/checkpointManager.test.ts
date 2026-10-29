import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { CheckpointManager } from '../CheckpointManager.js';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

let tmp = '';
let ws = '';

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'neox-ckpt-mgr-'));
  ws = path.join(tmp, 'My Project!!');
  await fs.mkdir(ws, { recursive: true });
  await fs.writeFile(path.join(ws, 'a.txt'), 'hello');
});

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function fakeCheckpoint(overrides: Record<string, any> = {}) {
  return {
    startWatching: vi.fn(async () => 'before-id'),
    getBeforeCheckpointId: vi.fn(() => 'before-id'),
    stopWatching: vi.fn(async () => {}),
    createCheckpoint: vi.fn(async () => ({ id: 'c1', label: 'x' })),
    rollbackTo: vi.fn(async () => ({ success: true, restored: [], errors: [] })),
    rollbackSingleFile: vi.fn(async () => ({ success: true })),
    reapplySingleFile: vi.fn(async () => ({ success: true })),
    getCheckpoints: vi.fn(async () => []),
    getDiff: vi.fn(async () => ({ files: [] })),
    getChangeBuffer: vi.fn(async () => []),
    getCurrentStats: vi.fn(async () => ({ created: 0, modified: 0, deleted: 0, directories: 0, total: 0 })),
    getStorageStats: vi.fn(async () => ({ repositorySize: 1, shadowDirSize: 2, checkpointCount: 3 })),
    onFileChange: vi.fn(() => () => {}),
    isActive: vi.fn(() => true),
    getRepositoryDir: vi.fn(() => path.join(tmp, 'repo.git')),
    destroy: vi.fn(async () => {}),
    ...overrides,
  } as any;
}

function withInstance(checkpoint: any) {
  const m = new CheckpointManager();
  (m as any).instances.set(path.normalize(ws), checkpoint);
  return m;
}

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('CheckpointManager — 单例与路径', () => {
  it('getInstance 返回同一实例', () => {
    expect(CheckpointManager.getInstance()).toBe(CheckpointManager.getInstance());
  });

  it('私有仓库路径：规范化、可重现、同路径同结果', () => {
    const m = new CheckpointManager();
    const a = (m as any).getPrivateRepoPath(ws) as string;
    const b = (m as any).getPrivateRepoPath(ws) as string;
    const c = (m as any).getPrivateRepoPath(path.join(tmp, 'other')) as string;
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toContain(path.join(NEOX_HOME_DIRNAME, 'checkpoints'));
    expect(a.endsWith('.git')).toBe(true);
  });

  it('目录名里的特殊字符被压成短横线，空名字回退 workspace', () => {
    const m = new CheckpointManager();
    const a = (m as any).getPrivateRepoPath(ws) as string;
    const base = path.basename(a);
    expect(base).toMatch(/^my-project-[0-9a-f]+\.git$/);
    const empty = (m as any).getPrivateRepoPath(path.sep + '') as string;
    expect(path.basename(empty)).toMatch(/^workspace-[0-9a-f]+\.git$/);
  });

  it('目录名截断到 32 字符', () => {
    const m = new CheckpointManager();
    const long = (m as any).getPrivateRepoPath(path.join(tmp, 'a'.repeat(80))) as string;
    const name = path.basename(long).replace(/-[0-9a-f]+\.git$/, '');
    expect(name.length).toBeLessThanOrEqual(32);
  });
});

describe('CheckpointManager — 实例转发', () => {
  it('startWatching / stopWatching / createCheckpoint', async () => {
    const cp = fakeCheckpoint();
    const m = withInstance(cp);
    expect(await m.startWatching(ws, 's1', 3)).toBe('before-id');
    expect(cp.startWatching).toHaveBeenCalledWith('s1', 3);
    await m.stopWatching(ws);
    expect(cp.stopWatching).toHaveBeenCalled();
    expect(await m.createCheckpoint(ws, 'label')).toEqual({ id: 'c1', label: 'x' });
    expect(cp.createCheckpoint).toHaveBeenCalledWith('label');
  });

  it('rollbackTo / rollbackSingleFile / reapplySingleFile', async () => {
    const cp = fakeCheckpoint();
    const m = withInstance(cp);
    await m.rollbackTo(ws, 'c9');
    expect(cp.rollbackTo).toHaveBeenCalledWith('c9');
    await m.rollbackSingleFile(ws, 'a.ts', { force: true } as any);
    expect(cp.rollbackSingleFile).toHaveBeenCalledWith('a.ts', { force: true });
    await m.reapplySingleFile(ws, 'a.ts');
    expect(cp.reapplySingleFile).toHaveBeenCalledWith('a.ts');
  });

  it('getCheckpoints / getDiff / getChangeBuffer / getCurrentStats', async () => {
    const cp = fakeCheckpoint();
    const m = withInstance(cp);
    await m.getCheckpoints(ws, 5, 's1');
    expect(cp.getCheckpoints).toHaveBeenCalledWith(5, 's1');
    await m.getDiff(ws, 'a', 'b');
    expect(cp.getDiff).toHaveBeenCalledWith('a', 'b');
    await m.getChangeBuffer(ws);
    expect(cp.getChangeBuffer).toHaveBeenCalled();
    await m.getCurrentStats(ws);
    expect(cp.getCurrentStats).toHaveBeenCalled();
  });

  it('getStorageStats 有实例时直接委派', async () => {
    const cp = fakeCheckpoint();
    const m = withInstance(cp);
    expect(await m.getStorageStats(ws)).toMatchObject({ checkpointCount: 3 });
    expect(cp.getStorageStats).toHaveBeenCalled();
  });

  it('onFileChange 返回退订函数', async () => {
    const cp = fakeCheckpoint();
    const m = withInstance(cp);
    const off = await m.onFileChange(ws, () => {});
    expect(typeof off).toBe('function');
  });

  it('getBeforeCheckpointId 有实例返回值，无实例返回 null', () => {
    expect(withInstance(fakeCheckpoint()).getBeforeCheckpointId(ws)).toBe('before-id');
    expect(new CheckpointManager().getBeforeCheckpointId(ws)).toBeNull();
  });

  it('stopWatching 无实例时 no-op', async () => {
    await expect(new CheckpointManager().stopWatching(ws)).resolves.toBeUndefined();
  });

  it('isWatching / hasInstance 读实例状态', () => {
    const cp = fakeCheckpoint();
    const m = withInstance(cp);
    expect(m.isWatching(ws)).toBe(true);
    expect(m.hasInstance(ws)).toBe(true);
    cp.isActive.mockReturnValue(false);
    expect(m.isWatching(ws)).toBe(false);
    expect(new CheckpointManager().hasInstance(ws)).toBe(false);
  });
});

describe('CheckpointManager — 无实例时的存储统计', () => {
  it('仓库与 .cdundo 都不存在时返回 0', async () => {
    const m = new CheckpointManager();
    const stats = await m.getStorageStats(ws);
    expect(stats).toMatchObject({ repositorySize: 0, shadowDirSize: 0, checkpointCount: 0 });
  });

  it('.cdundo 目录存在时计入 shadowDirSize', async () => {
    const m = new CheckpointManager();
    const shadow = path.join(ws, '.cdundo');
    await fs.mkdir(shadow, { recursive: true });
    await fs.writeFile(path.join(shadow, 'x'), '12345');
    const stats = await m.getStorageStats(ws);
    expect(stats.shadowDirSize).toBeGreaterThanOrEqual(5);
    await fs.rm(shadow, { recursive: true, force: true });
  });
});

describe('CheckpointManager — 清理与统计', () => {
  it('cleanup 销毁实例并删掉仓库 / .cdundo', async () => {
    const repo = path.join(tmp, 'repo.git');
    await fs.mkdir(repo, { recursive: true });
    await fs.writeFile(path.join(repo, 'HEAD'), 'x');
    const shadow = path.join(ws, '.cdundo');
    await fs.mkdir(shadow, { recursive: true });
    await fs.writeFile(path.join(shadow, 'y'), 'x');
    const cp = fakeCheckpoint({ getRepositoryDir: () => repo });
    const m = withInstance(cp);
    await m.cleanup(ws);
    expect(cp.destroy).toHaveBeenCalled();
    expect(m.hasInstance(ws)).toBe(false);
    await expect(fs.stat(repo)).rejects.toThrow();
    await expect(fs.stat(shadow)).rejects.toThrow();
  });

  it('cleanup 无实例时也不抛错', async () => {
    await expect(new CheckpointManager().cleanup(ws)).resolves.toBeUndefined();
  });

  it('destroyAll 清空所有实例', async () => {
    const a = fakeCheckpoint();
    const b = fakeCheckpoint();
    const m = new CheckpointManager();
    (m as any).instances.set('/w1', a);
    (m as any).instances.set('/w2', b);
    await m.destroyAll();
    expect(a.destroy).toHaveBeenCalled();
    expect(b.destroy).toHaveBeenCalled();
    expect(m.getStats().totalInstances).toBe(0);
  });

  it('getActiveWorkspaces / getStats', () => {
    const m = new CheckpointManager();
    (m as any).instances.set('/active', fakeCheckpoint({ isActive: () => true }));
    (m as any).instances.set('/idle', fakeCheckpoint({ isActive: () => false }));
    expect(m.getActiveWorkspaces()).toEqual(['/active']);
    expect(m.getStats()).toMatchObject({ totalInstances: 2, activeInstances: 1 });
    expect(m.getStats().workspaces.sort()).toEqual(['/active', '/idle']);
  });
});
