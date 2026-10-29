import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RuntimeCheckpointService } from '../runtimeCheckpointService.js';
import { CheckpointManager } from '../CheckpointManager.js';

function fakeManager(overrides: Record<string, any> = {}) {
  return {
    startWatching: vi.fn(async () => 'before-id'),
    stopWatching: vi.fn(async () => {}),
    createCheckpoint: vi.fn(async () => ({ id: 'c1', label: 'x' })),
    rollbackTo: vi.fn(async () => ({ success: true, restored: ['a'], errors: [] })),
    rollbackSingleFile: vi.fn(async () => ({ success: true })),
    reapplySingleFile: vi.fn(async () => ({ success: true })),
    getCheckpoint: vi.fn(async () => ({
      isFileUnchangedSinceCommit: vi.fn(async () => ({ unchanged: true })),
      getCheckpoints: vi.fn(async () => []),
      getCommitFileChanges: vi.fn(async () => []),
    })),
    getCheckpoints: vi.fn(async () => [{ id: 'c1', label: 'Message completed', timestamp: 1 }]),
    getCurrentStats: vi.fn(async () => ({ created: 1, modified: 2, deleted: 0, directories: 0, total: 3 })),
    getStorageStats: vi.fn(async () => ({ repositorySize: 10, shadowDirSize: 5, checkpointCount: 2 })),
    getChangeBuffer: vi.fn(async () => [{ path: 'a.ts' }]),
    hasInstance: vi.fn(() => false),
    cleanup: vi.fn(async () => {}),
    ...overrides,
  } as any;
}

let gitSpy: any;

beforeEach(() => {
  gitSpy = vi.spyOn(CheckpointManager, 'isGitAvailable').mockResolvedValue(true);
});

afterEach(() => {
  gitSpy.mockRestore();
});

function service(manager = fakeManager()) {
  const svc = new RuntimeCheckpointService(manager);
  svc.setWorkspace('/tmp/ws');
  svc.isEnabled = () => true;
  return { svc, manager };
}

describe('RuntimeCheckpointService — no-op 分支', () => {
  it('disabled：start / create / finish 全部 no-op', async () => {
    const { svc, manager } = service();
    svc.isEnabled = () => false;
    expect(await svc.startMessage('s')).toBeNull();
    expect(await svc.createCheckpoint('s')).toBeNull();
    expect(await svc.finishMessage('s')).toBeNull();
    expect(manager.startWatching).not.toHaveBeenCalled();
    expect(manager.createCheckpoint).not.toHaveBeenCalled();
  });

  it('workspace 未设置：start / create / finish no-op', async () => {
    const { svc, manager } = service();
    svc.setWorkspace(null);
    expect(await svc.startMessage('s')).toBeNull();
    expect(await svc.createCheckpoint('s')).toBeNull();
    expect(await svc.finishMessage('s')).toBeNull();
    expect(manager.startWatching).not.toHaveBeenCalled();
  });

  it('git 不可用：start / create no-op，不抛错', async () => {
    gitSpy.mockResolvedValue(false);
    const { svc, manager } = service();
    expect(await svc.startMessage('s')).toBeNull();
    expect(await svc.createCheckpoint('s')).toBeNull();
    expect(manager.startWatching).not.toHaveBeenCalled();
  });

  it('无 workspace 时回滚 / 查询返回安全默认值', async () => {
    const { svc } = service();
    svc.setWorkspace(null);
    expect(await svc.rollbackToCheckpoint('c')).toEqual({ success: false, restored: [], errors: ['No workspace set'] });
    expect(await svc.rollbackSingleFile('a')).toEqual({ success: false, error: 'No workspace set' });
    expect(await svc.reapplySingleFile('a')).toEqual({ success: false, error: 'No workspace set' });
    expect(await svc.getCheckpoints()).toEqual([]);
    expect(await svc.getCurrentStats()).toBeNull();
    expect(await svc.getStorageStats()).toBeNull();
    expect(await svc.getChangeBuffer()).toEqual([]);
    expect(await svc.getSessionChanges('s')).toMatchObject({
      turns: [], files: [], changeSet: { files: [], totals: { files: 0 } },
    });
    expect(await svc.isFileUnchangedSinceCommit('c', 'a')).toMatchObject({ unchanged: false });
  });
});

describe('RuntimeCheckpointService — start / finish', () => {
  it('startMessage 传入会话自己的消息序号（初始 0）', async () => {
    const { svc, manager } = service();
    expect(await svc.startMessage('s1')).toBe('before-id');
    expect(manager.startWatching).toHaveBeenCalledWith('/tmp/ws', 's1', 0);
  });

  it('finishMessage 先建快照再停监控', async () => {
    const order: string[] = [];
    const { svc, manager } = service(fakeManager({
      createCheckpoint: vi.fn(async () => { order.push('create'); return { id: 'c1' }; }),
      stopWatching: vi.fn(async () => { order.push('stop'); }),
    }));
    await svc.finishMessage('s');
    expect(order).toEqual(['create', 'stop']);
    expect(manager.createCheckpoint).toHaveBeenCalledWith('/tmp/ws', 'Message #1');
  });

  it('每个会话独立计数，默认 label 递增', async () => {
    const { svc, manager } = service();
    await svc.createCheckpoint('a');
    await svc.createCheckpoint('a');
    await svc.createCheckpoint('b');
    expect(manager.createCheckpoint.mock.calls.map((c: any[]) => c[1])).toEqual(['Message #1', 'Message #2', 'Message #1']);
  });

  it('自定义 label 不计数递增但重置为下一次默认值的依据', async () => {
    const { svc, manager } = service();
    await svc.createCheckpoint('a', 'manual checkpoint');
    await svc.createCheckpoint('a');
    expect(manager.createCheckpoint.mock.calls.map((c: any[]) => c[1])).toEqual(['manual checkpoint', 'Message #2']);
  });

  it('下一轮 startMessage 等待收尾快照落完', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const { svc } = service(fakeManager({
      createCheckpoint: async () => { order.push('create:start'); await gate; order.push('create:done'); return { id: 'c1' }; },
      startWatching: async () => { order.push('start'); return 'b'; },
    }));
    svc.finishMessageInBackground('s');
    const next = svc.startMessage('s');
    await new Promise(r => setImmediate(r));
    expect(order).toEqual(['create:start']);
    release();
    await next;
    expect(order).toEqual(['create:start', 'create:done', 'start']);
  });

  it('后台收尾失败不会变成未处理 rejection，settled 正常 resolve', async () => {
    const { svc } = service(fakeManager({ createCheckpoint: async () => { throw new Error('git failed'); } }));
    svc.finishMessageInBackground('s');
    await expect(svc.settled()).resolves.toBeUndefined();
  });

  it('stopWatching 无 workspace 时 no-op', async () => {
    const { svc, manager } = service();
    svc.setWorkspace(null);
    await svc.stopWatching();
    expect(manager.stopWatching).not.toHaveBeenCalled();
  });

  it('stopWatching 有 workspace 时先等收尾再停', async () => {
    const { svc, manager } = service();
    await svc.stopWatching();
    expect(manager.stopWatching).toHaveBeenCalledWith('/tmp/ws');
  });
});

describe('RuntimeCheckpointService — 回滚与查询转发', () => {
  it('rollbackToCheckpoint 转发', async () => {
    const { svc, manager } = service();
    const r = await svc.rollbackToCheckpoint('c9');
    expect(r.success).toBe(true);
    expect(manager.rollbackTo).toHaveBeenCalledWith('/tmp/ws', 'c9');
  });

  it('rollbackSingleFile 转发 options', async () => {
    const { svc, manager } = service();
    await svc.rollbackSingleFile('src/a.ts', { force: true } as any);
    expect(manager.rollbackSingleFile).toHaveBeenCalledWith('/tmp/ws', 'src/a.ts', { force: true });
  });

  it('isFileUnchangedSinceCommit 缺参数时直接返回 unknown', async () => {
    const { svc, manager } = service();
    expect(await svc.isFileUnchangedSinceCommit('', 'a')).toMatchObject({ unchanged: false, reason: 'unknown' });
    expect(await svc.isFileUnchangedSinceCommit('c', '')).toMatchObject({ unchanged: false, reason: 'unknown' });
    expect(manager.getCheckpoint).not.toHaveBeenCalled();
  });

  it('isFileUnchangedSinceCommit 转发到 checkpoint', async () => {
    const { svc, manager } = service();
    expect(await svc.isFileUnchangedSinceCommit('c1', 'a.ts')).toEqual({ unchanged: true });
    expect(manager.getCheckpoint).toHaveBeenCalledWith('/tmp/ws');
  });

  it('reapplySingleFile / getCheckpoints / getChangeBuffer 转发', async () => {
    const { svc, manager } = service();
    expect(await svc.reapplySingleFile('a')).toEqual({ success: true });
    expect(await svc.getCheckpoints(10, 's')).toEqual([{ id: 'c1', label: 'Message completed', timestamp: 1 }]);
    expect(await svc.getChangeBuffer()).toEqual([{ path: 'a.ts' }]);
    expect(manager.getCheckpoints).toHaveBeenCalledWith('/tmp/ws', 10, 's');
  });

  it('getCurrentStats / getStorageStats 转发', async () => {
    const { svc } = service();
    expect(await svc.getCurrentStats()).toMatchObject({ total: 3 });
    expect(await svc.getStorageStats()).toMatchObject({ checkpointCount: 2 });
  });

  it('getStats：无实例时 current 全 0，只带存储统计', async () => {
    const { svc } = service();
    const stats = await svc.getStats();
    expect(stats).toMatchObject({ created: 0, modified: 0, total: 0, repositorySize: 10, storageTotalSize: 15, checkpointCount: 2 });
  });

  it('getStats：有实例时叠加当前变更统计', async () => {
    const { svc } = service(fakeManager({ hasInstance: () => true }));
    const stats = await svc.getStats();
    expect(stats).toMatchObject({ created: 1, modified: 2, total: 3, storageTotalSize: 15 });
  });

  it('getSessionChanges 无 session 时返回空', async () => {
    const { svc } = service();
    expect(await svc.getSessionChanges('')).toMatchObject({ turns: [], files: [], changeSet: { files: [] } });
  });

  it('getSessionChanges 等收尾后聚合', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const checkpoint = {
      getCheckpoints: async () => { order.push('read'); return []; },
      getCommitFileChanges: async () => [],
    };
    const { svc } = service(fakeManager({
      createCheckpoint: async () => { order.push('finish:start'); await gate; order.push('finish:done'); return { id: 'c1' }; },
      getCheckpoint: async () => checkpoint,
    }));
    svc.finishMessageInBackground('s');
    const p = svc.getSessionChanges('s');
    await new Promise(r => setImmediate(r));
    expect(order).toEqual(['finish:start']);
    release();
    expect(await p).toMatchObject({ turns: [], files: [], changeSet: { files: [], totals: { files: 0 } } });
    expect(order).toEqual(['finish:start', 'finish:done', 'read']);
  });

  it('cleanup 转发并等待收尾', async () => {
    const { svc, manager } = service();
    await svc.cleanup();
    expect(manager.cleanup).toHaveBeenCalledWith('/tmp/ws');
  });
});
