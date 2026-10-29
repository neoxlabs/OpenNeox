
/** 某个文件的改动刚被撤销 —— detail.path 是绝对路径。TurnSummaryBar 订阅它清待审条目。 */
export const FILE_REVERTED_EVENT = 'neox:file-reverted';

export interface RevertableChange {
  /** 文件路径 — 绝对或工作区相对都行, 后端归一化 */
  filePath: string;
  op?: 'edit' | 'write' | 'delete' | 'rename';
  editHunks?: Array<{
    oldString?: string;
    newString?: string;
    startLine?: number;
    previewTruncated?: boolean;
  }>;
  /** write_file 覆盖前存的原内容快照 id */
  previousSnapshotId?: string;
  /** 会话工作区 — 只用来把相对路径解析成绝对路径, 好去匹配 Surface 上的 source.path */
  workspacePath?: string;
}

export type RevertMode = 'file' | 'hunks' | 'edit' | 'snapshot';

export interface RevertOutcome {
  success: boolean;
  mode: RevertMode;
  error?: string;
}

/** 执行回滚。只回结果, 不弹提示 —— 提示交给 notifyRevertOutcome, 方便调用方自定文案。 */
export async function revertFileChange(change: RevertableChange): Promise<RevertOutcome> {
  const outcome = await runRevert(change);
  if (outcome.success) {
    /* 磁盘变了就得让右侧跟上 —— 这里是所有回滚路径的唯一出口, 放在这里就不会有哪条路忘了同步。
     *   · 文件还在 → 让盯着它的 Surface 重读, 否则用户看到的还是回滚前的内容;
     *   · 文件没了 (回滚掉一个 AI 新建的文件) → 直接关掉标签页。留着只会变成一张红色的
     *     "Failed to load source / ENOENT ... stat", 用户刚点的是"撤销这个文件", 不该被
     *     一条 stat 系统错误怼脸上还得自己去关。 */
    try {
      const [store, { resolveWorkspacePath }] = await Promise.all([
        import('../../../state/surfaceStore'),
        import('../../../utils/pathUtils'),
      ]);
      const abs = resolveWorkspacePath(change.filePath, change.workspacePath);
      if (await fileExists(abs)) store.refreshFileSurfaces(abs);
      else store.closeSurfacesForDeletedFile(abs);
      /* 这个文件的改动已经被撤销了, composer 上方那条「N 处改动等你接受或回退」不该
       * 还挂着它 —— 用户刚做的就是"回退"。广播出去让 TurnSummaryBar 把对应 hunk 标成
       * rejected, 条目清空后整条自然消失 (明康截图: 回滚完 Pending edits 1 还在)。 */
      window.dispatchEvent(new CustomEvent(FILE_REVERTED_EVENT, { detail: { path: abs } }));
    } catch { /* 同步失败不该让回滚显示成失败 */ }
  }
  return outcome;
}

/** 回滚完文件还在不在 —— 决定该刷新还是该关标签页。读不到就当"还在", 宁可留标签也别误关。 */
async function fileExists(absPath: string): Promise<boolean> {
  const api: any = (window as any).neox;
  const reader = api?.surfaceReadFile ?? api?.readFile;
  if (!reader) return true;
  try {
    const r = await reader(absPath);
    if (r?.success === false) {
      return !/ENOENT|no such file|not found/i.test(String(r.error ?? ''));
    }
    return true;
  } catch (err: any) {
    return !/ENOENT|no such file|not found/i.test(String(err?.message ?? err));
  }
}

async function runRevert(change: RevertableChange): Promise<RevertOutcome> {
  const api: any = (window as any).neox;
  if (!api?.revertFileEdit || !change.filePath) {
    return { success: false, mode: 'file', error: 'revertFileEdit unavailable' };
  }

  const hunks = change.editHunks ?? [];
  const contentHunks = hunks.filter((h) => !!h.oldString && !!h.newString && !h.previewTruncated);
  const canContentRevert = hunks.length > 0 && contentHunks.length === hunks.length;

  /* ---- 1. Shadow Git: 真源。开着就永远走这条, 不管有没有 hunk。 ---- */
  const checkpointOn = await isCheckpointEnabled();
  if (checkpointOn) {
    try {
      const r = await api.revertFileEdit(change.filePath, '', '', 'file');
      if (r?.success) return { success: true, mode: 'file' };
      const shadowErr = r?.error ? String(r.error) : undefined;
      const fallback = await revertByContent(api, change, contentHunks, canContentRevert);
      if (fallback) return fallback;
      return { success: false, mode: 'file', error: shadowErr };
    } catch (err: any) {
      const fallback = await revertByContent(api, change, contentHunks, canContentRevert);
      if (fallback) return fallback;
      return { success: false, mode: 'file', error: String(err?.message ?? err) };
    }
  }

  /* ---- 2/3. checkpoint 被关掉 —— 只能靠内容兜底 ---- */
  const fallback = await revertByContent(api, change, contentHunks, canContentRevert);
  if (fallback) return fallback;
  return {
    success: false,
    mode: 'file',
    error: 'checkpoint-disabled',
  };
}

async function isCheckpointEnabled(): Promise<boolean> {
  const api: any = (window as any).neox;
  try {
    /* 超时保护: 这个查询只是决定"先走哪条路", 绝不能因为一次 IPC 卡住就让整个回滚
     * 按钮点下去没反应。默认按开着算, 反正失败还有兜底链。 */
    const r = await Promise.race([
      api?.isCheckpointEnabled?.(),
      new Promise((resolve) => setTimeout(() => resolve({ enabled: true }), 2000)),
    ]) as { enabled?: boolean } | undefined;
    /* 查不到就当开着 —— 它默认 opt-out, 而且真源失败还有兜底链, 不该因为一次
     * IPC 抖动就把用户推到"去设置里打开检查点"这种误导提示上。 */
    return r?.enabled !== false;
  } catch {
    return true;
  }
}

/** 内容反向 apply / 覆盖前快照。都不适用时返回 null (表示"这条路不存在", 不是失败)。 */
async function revertByContent(
  api: any,
  change: RevertableChange,
  contentHunks: NonNullable<RevertableChange['editHunks']>,
  canContentRevert: boolean,
): Promise<RevertOutcome | null> {
  if (canContentRevert && contentHunks.length === 1) {
    const h = contentHunks[0]!;
    try {
      const r = await api.revertFileEdit(change.filePath, h.oldString, h.newString, 'edit');
      return { success: !!r?.success, mode: 'edit', error: r?.error };
    } catch (err: any) {
      return { success: false, mode: 'edit', error: String(err?.message ?? err) };
    }
  }

  if (canContentRevert && api.revertFileHunk) {
    /* 多 hunk: 按 startLine 从大到小逐个回滚, 自底向上避免行号漂移 */
    const ordered = [...contentHunks].sort((a, b) => (b.startLine ?? 0) - (a.startLine ?? 0));
    for (const h of ordered) {
      try {
        const hr = await api.revertFileHunk({
          filePath: change.filePath,
          oldString: h.oldString,
          newString: h.newString,
          startLine: h.startLine,
        });
        if (!hr?.success) return { success: false, mode: 'hunks', error: hr?.error };
      } catch (err: any) {
        return { success: false, mode: 'hunks', error: String(err?.message ?? err) };
      }
    }
    return { success: true, mode: 'hunks' };
  }

  if (change.previousSnapshotId && api.restoreFileSnapshot) {
    try {
      const r = await api.restoreFileSnapshot({
        filePath: change.filePath,
        snapshotId: change.previousSnapshotId,
      });
      return { success: !!r?.success, mode: 'snapshot', error: r?.error };
    } catch (err: any) {
      return { success: false, mode: 'snapshot', error: String(err?.message ?? err) };
    }
  }

  return null;
}

export async function notifyRevertOutcome(
  outcome: RevertOutcome,
  fileName: string,
  isZh: boolean,
  ctx?: { outsideWorkspace?: boolean },
): Promise<void> {
  const notify = await import('../../../components/notifyEvents');

  if (outcome.success) {
    notify.dispatchHint(
      outcome.mode === 'file' || outcome.mode === 'snapshot'
        ? (isZh ? `已回退 ${fileName} (整文件回到本轮改动前)` : `Reverted ${fileName} (whole file back to before this turn)`)
        : (isZh ? `已回退 ${fileName}` : `Reverted ${fileName}`),
      'success',
    );
    return;
  }

  const op = isZh ? '回退改动' : 'Revert changes';

  if (outcome.error === 'checkpoint-disabled') {
    notify.dispatchOpFailed({
      op,
      message: isZh
        ? '文件检查点被关掉了，这类改动(新建文件/大段编辑)没有可回退的快照。在 设置 → 实验功能 → 「文件快照 / 回退」打开后，以后的改动就能一键回退。'
        : 'File checkpoints are turned off, so this kind of change (new file / large edit) has no snapshot to restore. Turn them on in Settings → Experimental and future changes become one-click revertible.',
    });
    return;
  }

  /* 工作区外的文件: 回退走的是本工作区的 shadow git, 它压根没跟踪这个文件 ——
   * 甩一条 git 原文 ("pathspec did not match any file" 之类) 用户看不懂也无从下手。 */
  if (ctx?.outsideWorkspace) {
    notify.dispatchOpFailed({
      op,
      message: isZh
        ? `${fileName} 不在当前工作区，文件快照没有跟踪它，所以回退不了。可以在它自己的项目里打开后再操作。`
        : `${fileName} is outside the current workspace, so file snapshots never tracked it and it can’t be reverted here. Open its own project and try there.`,
    });
    return;
  }

  notify.dispatchOpFailed({
    op,
    message: outcome.error
      ? (isZh ? `回退 ${fileName} 失败：${outcome.error}` : `Failed to revert ${fileName}: ${outcome.error}`)
      : (isZh ? `回退 ${fileName} 失败` : `Failed to revert ${fileName}`),
  });
}
