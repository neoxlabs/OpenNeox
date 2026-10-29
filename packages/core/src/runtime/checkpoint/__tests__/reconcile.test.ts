import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { reconcileSessionChanges, type SnapshotSource } from '../reconcile.js';
import type { SessionChanges } from '../sessionChanges.js';

const sha = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf-8')).digest('hex');

const noSnapshots: SnapshotSource = {
  listFileSnapshots: async () => [],
  readFileSnapshot: async () => null,
};

const CHANGES: SessionChanges = {
  turns: [{
    commit: 'c1',
    timestamp: 1000,
    label: 'Message completed',
    files: [
      { path: 'a.ts', status: 'M', additions: 1, deletions: 0 },
      { path: 'b.ts', status: 'M', additions: 2, deletions: 1 },
      { path: 'c.ts', status: 'A', additions: 3, deletions: 0 },
    ],
  }],
  files: [
    { path: 'a.ts', status: 'M', additions: 1, deletions: 0 },
    { path: 'b.ts', status: 'M', additions: 2, deletions: 1 },
    { path: 'c.ts', status: 'A', additions: 3, deletions: 0 },
  ],
  changeSet: {
    version: 1,
    scope: 'session',
    files: [
      { path: 'a.ts', status: 'M', additions: 1, deletions: 0 },
      { path: 'b.ts', status: 'M', additions: 2, deletions: 1 },
      { path: 'c.ts', status: 'A', additions: 3, deletions: 0 },
    ],
    totals: { files: 3, additions: 6, deletions: 1 },
    turns: [],
  },
};

function fakeSource(unchanged: Record<string, { unchanged: boolean } | Error>) {
  return {
    getCheckpoints: vi.fn(async () => []),
    getCommitFileChanges: vi.fn(async () => []),
    isFileUnchangedSinceCommit: vi.fn(async (_commit: string, filePath: string) => {
      const v = unchanged[filePath];
      if (v instanceof Error) throw v;
      return v ?? { unchanged: false, reason: 'unknown' };
    }),
  } as any;
}

let ws = '';

beforeAll(async () => {
  ws = await fs.mkdtemp(path.join(os.tmpdir(), 'neox-reconcile-'));
  await fs.writeFile(path.join(ws, 'a.ts'), 'a2\n');
  await fs.writeFile(path.join(ws, 'b.ts'), 'b-user\n');
  await fs.writeFile(path.join(ws, 'c.ts'), 'c1\n');
});

afterAll(async () => {
  await fs.rm(ws, { recursive: true, force: true });
});

describe('reconcileSessionChanges —— 三种判定', () => {
  it('可撤 / 用户改过 / 比不了 各自归类, 并给出磁盘哈希', async () => {
    const result = await reconcileSessionChanges({
      source: fakeSource({
        'a.ts': { unchanged: true },
        'b.ts': { unchanged: false },
        'c.ts': new Error('git failed'),
      }),
      snapshots: noSnapshots,
      sessionId: 's1',
      workspacePath: ws,
      changes: CHANGES,
      turns: 1,
    });

    expect(result.turnCommit).toBe('c1');
    const byPath = new Map(result.files.map(f => [f.path, f]));
    expect(byPath.get('a.ts')).toMatchObject({ unchanged: true, undoVia: 'checkpoint' });
    expect(byPath.get('b.ts')).toMatchObject({ unchanged: false, undoVia: 'none' });
    expect(byPath.get('c.ts')).toMatchObject({ unchanged: null, undoVia: 'none' });

    /* 哈希对账: 磁盘内容自己的 sha256, 文件不存在为 null */
    expect(byPath.get('a.ts')!.diskHash).toBe(sha('a2\n'));
    expect(result.summary).toEqual({ total: 3, verified: 1, userModified: 1, unknown: 1, snapshotOnly: 0 });
  });

  it('checkpoint 比不了时, 那一轮之前的原内容快照能兜底', async () => {
    /* 快照保存时间必须不晚于那一轮提交 (1000); 更晚的那份不是「改之前」 */
    const snapshots: SnapshotSource = {
      listFileSnapshots: async () => [
        { id: 'old', filePath: path.join(ws, 'c.ts'), savedAt: 900 },
        { id: 'new', filePath: path.join(ws, 'c.ts'), savedAt: 2000 },
      ],
      readFileSnapshot: async (id) => (id === 'old' ? 'c-before\n' : 'c-after\n'),
    };

    const result = await reconcileSessionChanges({
      source: fakeSource({ 'c.ts': new Error('git unavailable') }),
      snapshots,
      sessionId: 's1',
      workspacePath: ws,
      changes: {
        ...CHANGES,
        turns: [{
          commit: 'c1', timestamp: 1000, label: 'Message completed',
          files: [{ path: 'c.ts', status: 'A', additions: 3, deletions: 0 }],
        }],
        files: [{ path: 'c.ts', status: 'A', additions: 3, deletions: 0 }],
      },
      turns: 1,
    });

    const c = result.files[0]!;
    expect(c.snapshotId).toBe('old');
    expect(c.snapshotHash).toBe(sha('c-before\n'));
    expect(c.undoVia).toBe('snapshot');
    expect(result.summary.snapshotOnly).toBe(1);
  });

  it('用户改过 (unchanged=false) 时即便有快照也不自动选快照 —— 覆盖同样会冲掉他的改动', async () => {
    const snapshots: SnapshotSource = {
      listFileSnapshots: async () => [{ id: 'old', filePath: path.join(ws, 'b.ts'), savedAt: 900 }],
      readFileSnapshot: async () => 'b-before\n',
    };
    const result = await reconcileSessionChanges({
      source: fakeSource({ 'b.ts': { unchanged: false } }),
      snapshots,
      sessionId: 's1',
      workspacePath: ws,
      changes: {
        ...CHANGES,
        turns: [{
          commit: 'c1', timestamp: 1000, label: 'Message completed',
          files: [{ path: 'b.ts', status: 'M', additions: 1, deletions: 0 }],
        }],
        files: [{ path: 'b.ts', status: 'M', additions: 1, deletions: 0 }],
      },
      turns: 1,
    });
    expect(result.files[0]).toMatchObject({ undoVia: 'none', snapshotId: 'old' });
  });

  it('只对账指定轮次: 更早轮次的文件不在这里下结论 (调用方回退到逐文件查)', async () => {
    const changes: SessionChanges = {
      turns: [
        { commit: 'c2', timestamp: 2000, label: 'Message completed', files: [{ path: 'a.ts', status: 'M', additions: 1, deletions: 0 }] },
        { commit: 'c1', timestamp: 1000, label: 'Message completed', files: [{ path: 'old.ts', status: 'M', additions: 1, deletions: 0 }] },
      ],
      files: [
        { path: 'a.ts', status: 'M', additions: 1, deletions: 0 },
        { path: 'old.ts', status: 'M', additions: 1, deletions: 0 },
      ],
      changeSet: { version: 1, scope: 'session', files: [], totals: { files: 0, additions: 0, deletions: 0 } },
    };
    const result = await reconcileSessionChanges({
      source: fakeSource({ 'a.ts': { unchanged: true } }),
      snapshots: noSnapshots,
      sessionId: 's1',
      workspacePath: ws,
      changes,
      turns: 1,
    });
    expect(result.turnCommit).toBe('c2');
    expect(result.files.map(f => f.path)).toEqual(['a.ts']);
    expect(result.summary).toEqual({ total: 1, verified: 1, userModified: 0, unknown: 0, snapshotOnly: 0 });
  });

  it('没有会话 / 没有改动 → 空结果, 不抛', async () => {
    await expect(reconcileSessionChanges({
      source: fakeSource({}), snapshots: noSnapshots, sessionId: '', workspacePath: ws,
    })).resolves.toMatchObject({ files: [], summary: { total: 0 } });

    await expect(reconcileSessionChanges({
      source: fakeSource({}), snapshots: noSnapshots, sessionId: 's1', workspacePath: ws,
      changes: { ...CHANGES, turns: [], files: [], changeSet: { ...CHANGES.changeSet!, files: [], totals: { files: 0, additions: 0, deletions: 0 } } },
    })).resolves.toMatchObject({ files: [], summary: { total: 0 } });
  });
});

describe.skipIf(process.platform === 'win32')('重启后仍能撤上一轮 (真 shadow git)', () => {
  const realHome = process.env.HOME;
  let home = '';
  let project = '';

  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'neox-reconcile-home-'));
    project = await fs.mkdtemp(path.join(os.tmpdir(), 'neox-reconcile-ws-'));
    process.env.HOME = home;
  });

  afterAll(async () => {
    process.env.HOME = realHome;
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(project, { recursive: true, force: true });
  });

  it('新实例 (模拟重启) 对账通过, revertTurn 把文件哈希还原', async () => {
    const { ShadowGitCheckpoint } = await import('../ShadowGitCheckpoint.js');
    const { RollbackService } = await import('../rollbackService.js');

    await fs.writeFile(path.join(project, 'keep.txt'), 'keep\n');
    await fs.writeFile(path.join(project, 'edit.txt'), 'before\n');

    const before = createHash('sha1').update(await fs.readFile(path.join(project, 'edit.txt'))).digest('hex');
    const keepBefore = createHash('sha1').update(await fs.readFile(path.join(project, 'keep.txt'))).digest('hex');

    const cp1 = new ShadowGitCheckpoint() as any;
    await cp1.init(project);
    await cp1.startWatching('s-restart', 0);
    await fs.writeFile(path.join(project, 'edit.txt'), 'after\n');
    await fs.writeFile(path.join(project, 'added.txt'), 'new\n');
    cp1.handleChange('modify', path.join(project, 'edit.txt'));
    cp1.handleChange('create', path.join(project, 'added.txt'));
    const turn = await cp1.createCheckpoint('Message completed');
    await cp1.stopWatching();
    await cp1.destroy();

    /* —— 进程重启: 内存里什么都没了, 只剩影子仓库 —— */
    const cp2 = new ShadowGitCheckpoint() as any;
    await cp2.init(project);

    const service = new RollbackService({ source: cp2, getWorkspace: () => project });
    const changes = await service.listSession('s-restart');
    expect(changes.turns[0]!.commit).toBe(turn.id);

    const reconciled = await reconcileSessionChanges({
      source: cp2,
      snapshots: noSnapshots,
      sessionId: 's-restart',
      workspacePath: project,
      changes,
      turns: 1,
    });
    expect(reconciled.turnCommit).toBe(turn.id);
    expect(reconciled.summary).toMatchObject({ total: 2, verified: 2 });
    expect(reconciled.files.map(f => f.undoVia)).toEqual(['checkpoint', 'checkpoint']);
    /* 哈希比对: 磁盘内容 hash 与对账时读到的完全一致 (同一份字节) */
    for (const file of reconciled.files) {
      const disk = await fs.readFile(path.join(project, file.path));
      expect(createHash('sha256').update(disk).digest('hex')).toBe(file.diskHash);
    }

    const result = await service.revertTurn(turn.id);
    expect(result.restored.sort()).toEqual(['added.txt', 'edit.txt']);
    expect(result.failed).toEqual([]);

    /* 改的回去了, 新建的没了, 本轮没碰的不动 —— 用哈希核 */
    const editAfter = createHash('sha1').update(await fs.readFile(path.join(project, 'edit.txt'))).digest('hex');
    expect(editAfter).toBe(before);
    await expect(fs.stat(path.join(project, 'added.txt'))).rejects.toThrow();
    const keepAfter = createHash('sha1').update(await fs.readFile(path.join(project, 'keep.txt'))).digest('hex');
    expect(keepAfter).toBe(keepBefore);

    await cp2.destroy();
  }, 30_000);
});
