import { describe, it, expect, vi } from 'vitest';
import { handleChangesCommand, handleUndoCommand } from '../commands/undoChanges.js';

const COLORS = {
  dim: (s: string) => s,
  info: (s: string) => s,
  highlight: (s: string) => s,
  warning: (s: string) => s,
} as any;

const LAST_TURN = [
  { path: 'src/a.ts', status: 'M', additions: 3, deletions: 1 },
  { path: 'src/new.ts', status: 'A', additions: 7, deletions: 0 },
];

function makeCtx(overrides: Record<string, unknown> = {}) {
  const lines: string[] = [];
  const infos: Array<{ message: string; details?: string }> = [];
  const sdkClient: any = {
    getSessionChanges: vi.fn(async () => ({
      turns: [{ commit: 'c1', timestamp: Date.now(), label: 'Message completed', files: LAST_TURN }],
      files: LAST_TURN,
      /* 统一结构 (EDIT-02): CLI 优先读它 */
      changeSet: {
        version: 1,
        scope: 'session',
        files: LAST_TURN,
        totals: { files: 2, additions: 10, deletions: 1 },
      },
    })),
    rollbackSingleFile: vi.fn(async () => ({ success: true })),
    /* 一整轮一次调用 —— 替身按文件逐个走 rollbackSingleFile, 保持各用例的断言口径 */
    revertTurn: vi.fn(async (commit: string, opts: any = {}) => {
      const restored: string[] = [];
      const skipped: Array<{ path: string }> = [];
      const failed: Array<{ path: string; error?: string }> = [];
      for (const filePath of opts.files ?? []) {
        const r = await sdkClient.rollbackSingleFile(filePath, {
          guardCommit: opts.guardCommit,
          force: opts.force,
        });
        if (r?.success) restored.push(filePath);
        else if (r?.skipped) skipped.push({ path: filePath });
        else failed.push({ path: filePath, error: r?.error });
      }
      return { commit, restored, skipped, failed };
    }),
    addMemoryMessage: vi.fn(async () => undefined),
    isFileUnchangedSinceCommit: vi.fn(async () => ({ unchanged: true })),
    isCheckpointEnabled: vi.fn(async () => true),
  };
  const ctx: any = {
    colors: COLORS,
    currentSession: { sessionId: 's1' },
    sdkClient,
    logInfo: (message: string, details?: string) => infos.push({ message, details }),
    outputLines: (batch: string[]) => lines.push(...batch),
    promptSelect: vi.fn(async () => 'y'),
    isRunning: false,
    workspacePath: '/tmp/ws',
    ...overrides,
  };
  return { ctx, sdkClient, lines, infos };
}

describe('/changes', () => {
  it('列出本会话改过的文件与行数', async () => {
    const { ctx, lines } = makeCtx();
    await handleChangesCommand(ctx);
    const output = lines.join('\n');
    expect(output).toContain('src/a.ts');
    expect(output).toContain('+3 −1');
    expect(output).toContain('src/new.ts');
    expect(output).toContain('+7 −0');
  });

  it('没有改动时如实说, 并区分「快照没开」', async () => {
    const { ctx, sdkClient, infos } = makeCtx();
    sdkClient.getSessionChanges.mockResolvedValueOnce({ turns: [], files: [] });
    sdkClient.isCheckpointEnabled.mockResolvedValueOnce(false);
    await handleChangesCommand(ctx);
    expect(infos).toHaveLength(1);
    expect(infos[0]!.details).toContain('/checkpoint');
  });

  it('查询失败不抛, 报错给用户', async () => {
    const { ctx, sdkClient, infos } = makeCtx();
    sdkClient.getSessionChanges.mockRejectedValueOnce(new Error('boom'));
    await handleChangesCommand(ctx);
    expect(infos[0]!.details).toContain('boom');
  });

  it('清单只认 ChangeSet (三端同一结构), 老响应退回 files', async () => {
    const { ctx, sdkClient, lines } = makeCtx();
    /* 只有 changeSet、没有 files —— 统一之后这就是正常响应 */
    sdkClient.getSessionChanges.mockResolvedValueOnce({
      turns: [{ commit: 'c1', timestamp: Date.now(), label: 'Message completed', files: LAST_TURN }],
      changeSet: { version: 1, scope: 'session', files: LAST_TURN, totals: { files: 2, additions: 10, deletions: 1 } },
    });
    await handleChangesCommand(ctx);
    const output = lines.join('\n');
    expect(output).toContain('src/a.ts');
    expect(output).toContain('+3 −1');

    /* 老服务端只有 files 也不能空列表 */
    sdkClient.getSessionChanges.mockResolvedValueOnce({ turns: [], files: LAST_TURN });
    await handleChangesCommand(ctx);
    expect(lines.join('\n')).toContain('src/new.ts');
  });
});

describe('/undo', () => {
  it('列出上一轮的文件, 确认后逐个撤销, 并往会话里插说明', async () => {
    const { ctx, sdkClient, lines } = makeCtx();
    await handleUndoCommand(ctx);

    /* 先列文件 */
    const shown = lines.join('\n');
    expect(shown).toContain('src/a.ts');
    expect(shown).toContain('src/new.ts');

    expect(sdkClient.rollbackSingleFile.mock.calls.map(c => c[0])).toEqual(['src/a.ts', 'src/new.ts']);

    expect(sdkClient.addMemoryMessage).toHaveBeenCalledTimes(1);
    const [sessionId, role, note] = sdkClient.addMemoryMessage.mock.calls[0] as unknown as string[];
    expect(sessionId).toBe('s1');
    expect(role).toBe('user');
    expect(note).toContain('src/a.ts');
    expect(note).toContain('src/new.ts');
    expect(note).toContain('/undo');
  });

  it('用户选取消 → 一个文件都不动', async () => {
    const { ctx, sdkClient } = makeCtx();
    ctx.promptSelect.mockResolvedValueOnce('n');
    await handleUndoCommand(ctx);
    expect(sdkClient.rollbackSingleFile).not.toHaveBeenCalled();
    expect(sdkClient.addMemoryMessage).not.toHaveBeenCalled();
  });

  it('/undo <文件> 只撤那一个 (接受 ./ 前缀)', async () => {
    const { ctx, sdkClient } = makeCtx();
    await handleUndoCommand(ctx, './src/a.ts');
    expect(sdkClient.rollbackSingleFile.mock.calls.map(c => c[0])).toEqual(['src/a.ts']);
  });

  it('不在本会话改动里的文件: 拒绝, 不动磁盘', async () => {
    const { ctx, sdkClient, infos } = makeCtx();
    await handleUndoCommand(ctx, 'src/untouched.ts');
    expect(sdkClient.rollbackSingleFile).not.toHaveBeenCalled();
    expect(infos).toHaveLength(1);
  });

  it('回合还在跑 → 直接拒绝, 不查清单', async () => {
    const { ctx, sdkClient } = makeCtx({ isRunning: true });
    await handleUndoCommand(ctx);
    expect(sdkClient.getSessionChanges).not.toHaveBeenCalled();
    expect(sdkClient.rollbackSingleFile).not.toHaveBeenCalled();
  });

  it('单个文件撤销失败时报告失败, 不假装成功', async () => {
    const { ctx, sdkClient, infos } = makeCtx();
    sdkClient.rollbackSingleFile
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, error: 'EACCES' });
    await handleUndoCommand(ctx);
    const last = infos[infos.length - 1]!;
    expect(last.details).toContain('EACCES');
  });

  it('用户之后手改过的文件: 标「跳过」、保持用户版本, 只撤其余文件', async () => {
    const { ctx, sdkClient, lines, infos } = makeCtx();
    sdkClient.isFileUnchangedSinceCommit.mockImplementation(async (_commit: string, filePath: string) => (
      filePath === 'src/new.ts'
        ? { unchanged: false, reason: 'user-modified' }
        : { unchanged: true }
    ));
    await handleUndoCommand(ctx);

    const shown = lines.join('\n');
    expect(shown).toMatch(/你之后改过, 跳过|edited by you since/);
    expect(sdkClient.rollbackSingleFile.mock.calls.map(c => c[0])).toEqual(['src/a.ts']);
    /* 护栏基准是那一轮的提交, 不能是「最后一次碰到这个文件的提交」 */
    expect(sdkClient.rollbackSingleFile.mock.calls[0]![1]).toMatchObject({ guardCommit: 'c1', force: false });

    const note = sdkClient.addMemoryMessage.mock.calls[0]![2] as string;
    expect(note).toContain('src/new.ts');
    expect(note).toMatch(/跳过|skipped/);
    expect(infos[infos.length - 1]!.message).toMatch(/跳过|skipped/);
  });

  it('校验接口查不到时按跳过处理, 不覆盖用户文件', async () => {
    const { ctx, sdkClient, lines } = makeCtx();
    sdkClient.isFileUnchangedSinceCommit.mockRejectedValueOnce(new Error('boom'));
    await handleUndoCommand(ctx);
    expect(lines.join('\n')).toMatch(/无法确认是否改过, 跳过|couldn’t verify/);
    expect(sdkClient.rollbackSingleFile.mock.calls.map(c => c[0])).toEqual(['src/new.ts']);
  });

  it('全部文件都被手改过 → 一个都不撤, 提示 --force', async () => {
    const { ctx, sdkClient, infos } = makeCtx();
    sdkClient.isFileUnchangedSinceCommit.mockResolvedValue({ unchanged: false, reason: 'user-modified' });
    await handleUndoCommand(ctx);
    expect(ctx.promptSelect).not.toHaveBeenCalled();
    expect(sdkClient.rollbackSingleFile).not.toHaveBeenCalled();
    expect(infos[infos.length - 1]!.details).toContain('--force');
  });

  it('/undo <文件> --force 强制恢复: 不查护栏, 带上 force', async () => {
    const { ctx, sdkClient } = makeCtx();
    sdkClient.isFileUnchangedSinceCommit.mockResolvedValue({ unchanged: false, reason: 'user-modified' });
    await handleUndoCommand(ctx, 'src/new.ts', { force: true });
    expect(sdkClient.isFileUnchangedSinceCommit).not.toHaveBeenCalled();
    expect(sdkClient.rollbackSingleFile.mock.calls.map(c => c[0])).toEqual(['src/new.ts']);
    expect(sdkClient.rollbackSingleFile.mock.calls[0]![1]).toMatchObject({ guardCommit: 'c1', force: true });
  });

  it('列完清单后文件又被改 (core 护栏拦下) → 报跳过, 不算失败', async () => {
    const { ctx, sdkClient, infos } = makeCtx();
    sdkClient.rollbackSingleFile
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, skipped: true, reason: 'user-modified' });
    await handleUndoCommand(ctx);
    const last = infos[infos.length - 1]!;
    expect(last.message).toMatch(/1 (个跳过|skipped)/);
    expect(last.message).toMatch(/0 (个失败|failed)/);
  });

  it('对账结果直接当护栏: 不再逐个文件查, 且仍会跳过用户改过的', async () => {
    const { ctx, sdkClient, lines } = makeCtx();
    sdkClient.getSessionChanges.mockResolvedValueOnce({
      turns: [{ commit: 'c1', timestamp: Date.now(), label: 'Message completed', files: LAST_TURN }],
      files: LAST_TURN,
      changeSet: { version: 1, scope: 'session', files: LAST_TURN, totals: { files: 2, additions: 10, deletions: 1 } },
      /* EDIT-06: core 已经算过哈希 */
      reconciliation: {
        turnCommit: 'c1',
        files: [
          { path: 'src/a.ts', unchanged: true },
          { path: 'src/new.ts', unchanged: false },
        ],
      },
    });
    await handleUndoCommand(ctx);

    expect(sdkClient.isFileUnchangedSinceCommit).not.toHaveBeenCalled();
    expect(lines.join('\n')).toMatch(/你之后改过, 跳过|edited by you since/);
    expect(sdkClient.revertTurn).toHaveBeenCalledWith('c1', {
      files: ['src/a.ts'],
      guardCommit: 'c1',
      force: false,
    });
  });

  it('一整轮一次回调 core (revertTurn), 自底向上顺序由 core 决定', async () => {
    const { ctx, sdkClient } = makeCtx();
    await handleUndoCommand(ctx);
    expect(sdkClient.revertTurn).toHaveBeenCalledTimes(1);
    const [commit, opts] = sdkClient.revertTurn.mock.calls[0]!;
    expect(commit).toBe('c1');
    expect(opts).toMatchObject({ files: ['src/a.ts', 'src/new.ts'], guardCommit: 'c1', force: false });
  });
});
