import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { collectSessionChanges, type SessionChangeSource } from '../sessionChanges.js';

let tmpHome = '';
let ws = '';
const realHome = process.env.HOME;

beforeAll(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'neox-undo-home-'));
  ws = await fs.mkdtemp(path.join(os.tmpdir(), 'neox-undo-ws-'));
  process.env.HOME = tmpHome;
  await fs.writeFile(path.join(ws, 'a.txt'), 'alpha\n');
  await fs.writeFile(path.join(ws, 'b.txt'), 'bravo\n');
  await fs.writeFile(path.join(ws, 'c.txt'), 'charlie\n');
});

afterAll(async () => {
  process.env.HOME = realHome;
  await fs.rm(tmpHome, { recursive: true, force: true });
  await fs.rm(ws, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('collectSessionChanges + 单文件撤销', () => {
  it('只列 agent 那一轮改的文件, 撤销后逐个恢复', async () => {
    const { ShadowGitCheckpoint } = await import('../ShadowGitCheckpoint.js');
    const cp = new ShadowGitCheckpoint() as any;
    await cp.init(ws);
    /* 基线: 把当前 a/b/c 落成 'User changes before message' */
    await cp.startWatching('s1', 0);

    /* —— 模拟一轮 agent 改动: 改 a (只追加, 所以状态必须是 M) / 新建 d / 删 c —— */
    await fs.writeFile(path.join(ws, 'a.txt'), 'alpha\nalpha2\n');
    await fs.writeFile(path.join(ws, 'd.txt'), 'delta\n');
    await fs.unlink(path.join(ws, 'c.txt'));
    cp.handleChange('modify', path.join(ws, 'a.txt'));
    cp.handleChange('create', path.join(ws, 'd.txt'));
    cp.handleChange('delete', path.join(ws, 'c.txt'));

    const turn = await cp.createCheckpoint('Message completed');
    await cp.stopWatching();

    const changes = await collectSessionChanges(cp, 's1');
    expect(changes.turns).toHaveLength(1);
    expect(changes.turns[0]!.commit).toBe(turn.id);

    const byPath = new Map(changes.files.map((f: any) => [f.path, f]));
    expect([...byPath.keys()].sort()).toEqual(['a.txt', 'c.txt', 'd.txt']);
    /* 关键: 只追加行数的修改不许被当成新建 */
    expect(byPath.get('a.txt')).toMatchObject({ status: 'M', additions: 1, deletions: 0 });
    expect(byPath.get('d.txt')).toMatchObject({ status: 'A', additions: 1 });
    expect(byPath.get('c.txt')).toMatchObject({ status: 'D', deletions: 1 });
    /* 本轮没碰的文件不该出现在清单里 */
    expect(byPath.has('b.txt')).toBe(false);

    /* —— 先只撤一个文件: 其余两个必须原样保留 (验收口径「改 3 个撤 1 个, 其余哈希不变」) —— */
    const hash = async (name: string) =>
      createHash('sha1').update(await fs.readFile(path.join(ws, name))).digest('hex');
    const bBefore = await hash('b.txt');

    const one = await cp.rollbackSingleFile('a.txt');
    expect(one.success, one.error).toBe(true);
    expect(await fs.readFile(path.join(ws, 'a.txt'), 'utf8')).toBe('alpha\n');
    /* 没点撤销的文件保持这一轮的改动 */
    expect(await fs.readFile(path.join(ws, 'd.txt'), 'utf8')).toBe('delta\n');
    await expect(fs.stat(path.join(ws, 'c.txt'))).rejects.toThrow();
    expect(await hash('b.txt')).toBe(bBefore);

    /* —— 再把这一轮剩下的文件撤完 —— */
    for (const file of changes.turns[0]!.files) {
      if (file.path === 'a.txt') continue;
      const result = await cp.rollbackSingleFile(file.path);
      expect(result.success, `${file.path}: ${result.error}`).toBe(true);
    }

    expect(await fs.readFile(path.join(ws, 'a.txt'), 'utf8')).toBe('alpha\n');
    await expect(fs.stat(path.join(ws, 'd.txt'))).rejects.toThrow();
    expect(await fs.readFile(path.join(ws, 'c.txt'), 'utf8')).toBe('charlie\n');
    /* 没被本轮碰过的文件原样不动 */
    expect(await fs.readFile(path.join(ws, 'b.txt'), 'utf8')).toBe('bravo\n');
    expect(await hash('b.txt')).toBe(bBefore);

    await cp.destroy();
  }, 30_000);

  it('用户在两轮之间手改过的文件不覆盖; --force 才覆盖', async () => {
    const { ShadowGitCheckpoint } = await import('../ShadowGitCheckpoint.js');
    const guardWs = await fs.mkdtemp(path.join(os.tmpdir(), 'neox-undo-guard-'));
    try {
      await fs.writeFile(path.join(guardWs, 'a.txt'), 'alpha\n');
      await fs.writeFile(path.join(guardWs, 'b.txt'), 'bravo\n');
      await fs.writeFile(path.join(guardWs, 'c.txt'), 'charlie\n');

      const cp = new ShadowGitCheckpoint() as any;
      await cp.init(guardWs);
      await cp.startWatching('s3', 0);

      /* 一轮 agent 改动: 改 a / 改 b / 删 c */
      await fs.writeFile(path.join(guardWs, 'a.txt'), 'alpha\nagent\n');
      await fs.writeFile(path.join(guardWs, 'b.txt'), 'bravo\nagent\n');
      await fs.unlink(path.join(guardWs, 'c.txt'));
      cp.handleChange('modify', path.join(guardWs, 'a.txt'));
      cp.handleChange('modify', path.join(guardWs, 'b.txt'));
      cp.handleChange('delete', path.join(guardWs, 'c.txt'));
      const turn = await cp.createCheckpoint('Message completed');
      await cp.stopWatching();

      /* 用户在两轮之间手改 a; 下一轮开头 startWatching 会把这份手改写进基线提交
       * ('User changes before message') —— 护栏必须对着 agent 那一轮 (turn.id) 比,
       * 被那条基线带偏就会把用户的手改也撤了。 */
      await fs.writeFile(path.join(guardWs, 'a.txt'), 'alpha\nagent\nuser\n');
      await cp.startWatching('s3', 1);
      await cp.stopWatching();
      /* 另一个坑: agent 删掉的 c 被用户重新建了 —— git diff 看不到未跟踪文件,
       * 只靠 diff 会当成没改过, 反手把用户的新文件盖成旧内容 */
      await fs.writeFile(path.join(guardWs, 'c.txt'), 'charlie\nuser\n');

      await expect(cp.isFileUnchangedSinceCommit(turn.id, 'a.txt')).resolves.toMatchObject({
        unchanged: false,
        reason: 'user-modified',
      });
      await expect(cp.isFileUnchangedSinceCommit(turn.id, 'c.txt')).resolves.toMatchObject({
        unchanged: false,
        reason: 'user-modified',
      });
      await expect(cp.isFileUnchangedSinceCommit(turn.id, 'b.txt')).resolves.toEqual({ unchanged: true });

      /* 手改过的: 跳过, 一个字节都不动 */
      const skippedA = await cp.rollbackSingleFile('a.txt', { guardCommit: turn.id });
      expect(skippedA).toMatchObject({ success: false, skipped: true, reason: 'user-modified' });
      expect(await fs.readFile(path.join(guardWs, 'a.txt'), 'utf8')).toBe('alpha\nagent\nuser\n');
      const skippedC = await cp.rollbackSingleFile('c.txt', { guardCommit: turn.id });
      expect(skippedC).toMatchObject({ success: false, skipped: true });
      expect(await fs.readFile(path.join(guardWs, 'c.txt'), 'utf8')).toBe('charlie\nuser\n');

      /* 没被手改过的照常恢复到那一轮之前 */
      const okB = await cp.rollbackSingleFile('b.txt', { guardCommit: turn.id });
      expect(okB.success, okB.error).toBe(true);
      expect(await fs.readFile(path.join(guardWs, 'b.txt'), 'utf8')).toBe('bravo\n');

      /* --force 强制覆盖用户的手改 */
      const forcedA = await cp.rollbackSingleFile('a.txt', { guardCommit: turn.id, force: true });
      expect(forcedA.success, forcedA.error).toBe(true);
      expect(await fs.readFile(path.join(guardWs, 'a.txt'), 'utf8')).toBe('alpha\n');

      await cp.destroy();
    } finally {
      await fs.rm(guardWs, { recursive: true, force: true });
    }
  }, 30_000);

  it('没改文件的回合不留提交, 不进清单 (也不会把 HEAD 的 diff 算成它改的)', async () => {
    const { ShadowGitCheckpoint } = await import('../ShadowGitCheckpoint.js');
    const cp = new ShadowGitCheckpoint() as any;
    await cp.init(ws);
    await cp.startWatching('s2', 0);
    /* 一个什么都没改的回合: createCheckpoint 走 noChangeCheckpoint, 一条 commit 都不建 ——
     * git log 里没有 'Message completed', 如果强行拿返回的 HEAD id 去 diff,
     * 会把用户基线的改动记成"这一轮改的"。 */
    await cp.createCheckpoint('Message completed');
    await cp.stopWatching();

    const changes = await collectSessionChanges(cp, 's2');
    expect(changes.turns).toEqual([]);
    expect(changes.files).toEqual([]);

    await cp.destroy();
  }, 30_000);
});

describe('collectSessionChanges 汇总口径', () => {
  const turn = (commit: string, timestamp: number, files: any[]) => ({
    id: commit,
    label: 'Message completed',
    timestamp,
    sessionId: 's1',
    messageIndex: 0,
    /* 真实提交里 stats.total 就是这一轮的变更条数; 空回合靠它判定 (见 sessionChanges.ts) */
    stats: { created: 0, modified: 0, deleted: 0, directories: 0, total: files.length },
    files,
  });

  function fakeSource(items: any[]): SessionChangeSource {
    return {
      getCheckpoints: async () => items.map(({ files, ...rest }) => rest),
      getCommitFileChanges: async (id: string) => items.find(i => i.id === id)?.files ?? [],
    } as unknown as SessionChangeSource;
  }

  it('忽略 session_start / 手动检查点 / 用户基线提交', async () => {
    const source = fakeSource([
      turn('t2', 3, [{ path: 'x.ts', status: 'M', additions: 1, deletions: 1 }]),
      { id: 'manual', label: 'before refactor', timestamp: 2, files: [{ path: 'y.ts', status: 'M', additions: 9, deletions: 9 }] },
      { id: 'base', label: 'User changes before message', timestamp: 1, files: [{ path: 'z.ts', status: 'M', additions: 5, deletions: 5 }] },
      { id: 'start', label: 'session_start', timestamp: 0, files: [] },
    ]);
    const changes = await collectSessionChanges(source, 's1');
    expect(changes.turns.map(t => t.commit)).toEqual(['t2']);
    expect(changes.files.map(f => f.path)).toEqual(['x.ts']);
  });

  it('同一文件多轮: 行数累加, 会话内新建的文件后来被改仍是 A', async () => {
    const source = fakeSource([
      /* 新 → 旧 */
      turn('t2', 2, [
        { path: 'new.ts', status: 'M', additions: 2, deletions: 0 },
        { path: 'old.ts', status: 'D', additions: 0, deletions: 4 },
      ]),
      turn('t1', 1, [
        { path: 'new.ts', status: 'A', additions: 10, deletions: 0 },
        { path: 'old.ts', status: 'M', additions: 1, deletions: 0 },
      ]),
    ]);
    const changes = await collectSessionChanges(source, 's1');
    /* ChangeSet 从同一份聚合结果落成, 不再多跑一轮 git (EDIT-02) */
    expect(changes.changeSet.files).toEqual(changes.files);
    expect(changes.changeSet.totals).toEqual({ files: 2, additions: 13, deletions: 4 });
    const byPath = new Map(changes.files.map(f => [f.path, f]));
    expect(byPath.get('new.ts')).toMatchObject({ status: 'A', additions: 12, deletions: 0 });
    /* 最新一轮删掉了 → 以删除为准 */
    expect(byPath.get('old.ts')).toMatchObject({ status: 'D', additions: 1, deletions: 4 });
    /* 新 → 旧: turns[0] 就是 /undo 的「上一轮」 */
    expect(changes.turns[0]!.commit).toBe('t2');
  });

  it('没有 sessionId 时返回空, 不抛', async () => {
    const changes = await collectSessionChanges(fakeSource([]), '');
    expect(changes).toMatchObject({ turns: [], files: [] });
    /* ChangeSet 是同一份数据的另一个出口 (EDIT-02) */
    expect(changes.changeSet).toMatchObject({ scope: 'session', files: [], totals: { files: 0, additions: 0, deletions: 0 } });
  });
});

describe('桥接: getSessionChanges', () => {
  it('CLI 走 /checkpoint/session-changes, bridge 原样委托给 checkpoint service', async () => {
    const { createCheckpointBridgeHandlers } = await import(
      '../../../server/services/checkpointBridgeHandlers.js'
    );
    const seen: string[] = [];
    const handlers = createCheckpointBridgeHandlers({
      checkpointService: {
        getSessionChanges: async (sessionId: string) => {
          seen.push(sessionId);
          return { turns: [], files: [] };
        },
      } as any,
    });
    await expect(handlers.getSessionChanges('sess-1')).resolves.toEqual({ turns: [], files: [] });
    expect(seen).toEqual(['sess-1']);
  });

  it('RollbackService 入口原样委托到 checkpoint service (EDIT-01)', async () => {
    const { createCheckpointBridgeHandlers } = await import(
      '../../../server/services/checkpointBridgeHandlers.js'
    );
    const calls: any[] = [];
    const handlers = createCheckpointBridgeHandlers({
      checkpointService: {
        rollbackSingleFile: async (filePath: string, options: any) => {
          calls.push(['revertFile', filePath, options]);
          return { success: true };
        },
        reapplySingleFile: async (filePath: string) => {
          calls.push(['reapplyFile', filePath]);
          return { success: true };
        },
        revertHunk: async (input: any) => {
          calls.push(['revertHunk', input]);
          return { success: true };
        },
        revertTurn: async (commit: string, options: any) => {
          calls.push(['rollbackTurn', commit, options]);
          return { commit, restored: [], skipped: [], failed: [] };
        },
        getSessionChanges: async (sessionId: string, options: any) => {
          calls.push(['getSessionChanges', sessionId, options]);
          return { turns: [], files: [] };
        },
      } as any,
    });

    await handlers.revertFile!('a.ts', { force: true });
    await handlers.reapplyFile!('a.ts');
    await handlers.revertHunk!({ filePath: 'a.ts', oldString: 'x', newString: 'y', startLine: 3 });
    await handlers.rollbackTurn!('c1', { files: ['a.ts'] });
    await handlers.getSessionChanges!('s1', { reconcile: true });

    expect(calls).toEqual([
      ['revertFile', 'a.ts', { force: true }],
      ['reapplyFile', 'a.ts'],
      ['revertHunk', { filePath: 'a.ts', oldString: 'x', newString: 'y', startLine: 3 }],
      ['rollbackTurn', 'c1', { files: ['a.ts'] }],
      ['getSessionChanges', 's1', { reconcile: true }],
    ]);
  });
});
