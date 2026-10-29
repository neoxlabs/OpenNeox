import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { RollbackService, latestTurnOf, type RollbackChangeSource } from '../rollbackService.js';

let ws = '';

beforeAll(async () => {
  ws = await fs.mkdtemp(path.join(os.tmpdir(), 'neox-rollback-'));
});

afterAll(async () => {
  await fs.rm(ws, { recursive: true, force: true });
});

function fakeSource(overrides: Partial<RollbackChangeSource> = {}) {
  const source = {
    getCheckpoints: vi.fn(async () => [
      { id: 'c1', label: 'Message completed', timestamp: 100, sessionId: 's1', messageIndex: 0,
        stats: { created: 0, modified: 2, deleted: 0, directories: 0, total: 2 } },
    ]),
    getCommitFileChanges: vi.fn(async () => [
      { path: 'src/b.ts', status: 'M', additions: 2, deletions: 1 },
      { path: 'src/a.ts', status: 'M', additions: 1, deletions: 0 },
    ]),
    isFileUnchangedSinceCommit: vi.fn(async () => ({ unchanged: true })),
    rollbackSingleFile: vi.fn(async () => ({ success: true })),
    reapplySingleFile: vi.fn(async () => ({ success: true })),
    ...overrides,
  } as unknown as RollbackChangeSource;
  return source as RollbackChangeSource & Record<string, any>;
}

function service(source: RollbackChangeSource, workspace: string | null = ws) {
  return new RollbackService({ source, getWorkspace: () => workspace });
}

describe('list —— 会话清单走 ChangeSet', () => {
  it('返回统一结构, turns[0] 是最近一轮', async () => {
    const svc = service(fakeSource());
    const set = await svc.list('s1');
    expect(set.scope).toBe('session');
    expect(set.files.map(f => f.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(set.totals).toEqual({ files: 2, additions: 3, deletions: 1 });
    expect(set.turns).toHaveLength(1);

    const changes = await svc.listSession('s1');
    expect(latestTurnOf(changes)!.commit).toBe('c1');
  });
});

describe('revertFile / reapply —— 转发到唯一真源', () => {
  it('revertFile 原样传护栏参数', async () => {
    const source = fakeSource();
    const r = await service(source).revertFile('src/a.ts', { guardCommit: 'c1', force: true });
    expect(r.success).toBe(true);
    expect(source.rollbackSingleFile).toHaveBeenCalledWith('src/a.ts', { guardCommit: 'c1', force: true });
  });

  it('reapply 走 reapplySingleFile; 空路径直接拒绝', async () => {
    const source = fakeSource();
    const svc = service(source);
    expect((await svc.reapply('src/a.ts')).success).toBe(true);
    expect(source.reapplySingleFile).toHaveBeenCalledWith('src/a.ts');
    expect(await svc.revertFile('')).toMatchObject({ success: false });
  });
});

describe('revertTurn —— 自底向上串行, 单个失败不连坐', () => {
  it('按路径倒序执行, 跳过 / 失败分别归位', async () => {
    const order: string[] = [];
    const source = fakeSource({
      getCommitFileChanges: vi.fn(async () => [
        { path: 'src/a.ts', status: 'M', additions: 1, deletions: 0 },
        { path: 'src/z.ts', status: 'M', additions: 1, deletions: 0 },
        { path: 'src/m.ts', status: 'M', additions: 1, deletions: 0 },
      ]),
      rollbackSingleFile: vi.fn(async (filePath: string) => {
        order.push(filePath);
        if (filePath === 'src/m.ts') return { success: false, skipped: true, reason: 'user-modified' };
        if (filePath === 'src/a.ts') return { success: false, error: 'EACCES' };
        return { success: true };
      }),
    });

    const result = await service(source).revertTurn('c1', { force: false });
    expect(order).toEqual(['src/z.ts', 'src/m.ts', 'src/a.ts']);
    expect(result.restored).toEqual(['src/z.ts']);
    expect(result.skipped).toEqual([{ path: 'src/m.ts', reason: 'user-modified' }]);
    expect(result.failed).toEqual([{ path: 'src/a.ts', error: 'EACCES' }]);
    /* 护栏基准默认是这一轮的提交 */
    expect(source.rollbackSingleFile).toHaveBeenCalledWith('src/z.ts', { guardCommit: 'c1', force: false });
  });

  it('files 只撤指定文件; force / guardCommit 透传', async () => {
    const source = fakeSource();
    await service(source).revertTurn('c1', { files: ['src/a.ts'], force: true, guardCommit: 'c0' });
    expect(source.rollbackSingleFile).toHaveBeenCalledTimes(1);
    expect(source.rollbackSingleFile).toHaveBeenCalledWith('src/a.ts', { guardCommit: 'c0', force: true });
  });
});

describe('revertHunk —— 按偏移定位', () => {
  it('同文件多个相同片段: 撤的是 startLine 附近那一处', async () => {
    const rel = 'dup.txt';
    const lines: string[] = [];
    for (let i = 0; i < 40; i++) lines.push(i === 5 || i === 35 ? 'TARGET' : `line${i}`);
    await fs.writeFile(path.join(ws, rel), lines.join('\n'), 'utf-8');

    const svc = service(fakeSource());
    /* 第二处 (第 36 行) 在后面: 撤它不能把第一处改掉 */
    const r = await svc.revertHunk({ filePath: rel, oldString: 'FIRST', newString: 'TARGET', startLine: 36 });
    expect(r.success).toBe(true);
    expect(r.anchored).toBe(true);

    const after = (await fs.readFile(path.join(ws, rel), 'utf-8')).split('\n');
    expect(after[5]).toBe('TARGET');
    expect(after[35]).toBe('FIRST');
  });

  it('找不到片段: 失败且文件不动', async () => {
    const rel = 'plain.txt';
    await fs.writeFile(path.join(ws, rel), 'hello\n', 'utf-8');
    const r = await service(fakeSource()).revertHunk({
      filePath: rel, oldString: 'x', newString: 'not-here', startLine: 1,
    });
    expect(r.success).toBe(false);
    expect(await fs.readFile(path.join(ws, rel), 'utf-8')).toBe('hello\n');
  });

  it('previewTruncated 的 hunk (缺 old/new) 直接拒绝', async () => {
    const r = await service(fakeSource()).revertHunk({ filePath: 'a.txt', newString: 'x' });
    expect(r.success).toBe(false);
  });

  it('路径逃出工作区 → 拒绝; 无工作区 → 拒绝', async () => {
    const escape = await service(fakeSource()).revertHunk({
      filePath: '../outside.txt', oldString: 'a', newString: 'b',
    });
    expect(escape.success).toBe(false);

    const noWs = await service(fakeSource(), null).revertHunk({
      filePath: 'a.txt', oldString: 'a', newString: 'b',
    });
    expect(noWs).toMatchObject({ success: false, error: 'No workspace set' });
  });
});
