/**
 * useTimelineFileActions — Agent timeline 所有文件触点的统一交互原语.
 *
 * timeline 里渲染文件路径的 cell (EditDiffCard / ReadFileView / FileListView /
 * TurnSummaryView / SearchView / PlanView / TurnSummaryBar ...) 不再各写一套
 * 打开逻辑, 统一从这里拿动作 + 共享右键菜单:
 *
 *   openSurface()    右侧 Surface 打开源码 (code viewer；产品主路径，逐步替代 IDE)
 *   openEditor()     IDE 编辑器开 tab (保留 API 给兜底调用；右键菜单不再暴露)
 *   reveal()         Finder / 文件管理器高亮
 *   copyAbsolutePath() / copyRelativePath()
 *   handleContextMenu(e)  弹统一右键菜单 (复用 components/ContextMenu, 双语)
 *   contextMenu      菜单 ReactNode — caller 渲染在自己 JSX 尾部
 *
 * 打开 / reveal 前用 fsExists 做存在性检查: 文件没了给双语 toast, 不再"点了没反应".
 * fsExists 走 workspace 校验, workspace 外的路径校验失败时不拦 (照常尝试打开),
 * 由下游 viewer 自己报错 — 拦截只针对"确定不存在"这一种情况.
 */

import * as React from 'react';
import { ContextMenu, type ContextMenuItem } from '../../components/ContextMenu';
import { openSurfaceFromPath, isPreviewablePath } from '../../state/openSurfaceFromPath';
import { isPseudoEllipsisPath, relativeToWorkspace, resolveWorkspacePath } from '../../utils/pathUtils';
import { useNeoxRuntimeOptional } from '../../app/NeoxRuntimeContext';
import { useOptionalServiceContainer } from '../../platform/ServiceContainerContext';
import { EDITOR_SERVICE } from '../../../../ide/index.js';
import { dispatchHint, dispatchOpFailed } from '../../components/notifyEvents';
import { useI18n } from '../../hooks/useI18n';
import { IconPencil, IconFolder, IconCopy } from '../shell/shellIcons';
import { revealInFileManagerLabel } from '../../utils/fileManagerLabels';

export interface TimelineChangedLine {
  start: number;
  end: number;
  kind: 'add' | 'del' | 'modify';
}

export interface TimelineEditHunk {
  oldString?: string;
  newString?: string;
  startLine?: number;
  oldLineCount?: number;
  newLineCount?: number;
  oldCharCount?: number;
  newCharCount?: number;
  previewTruncated?: boolean;
  review?: 'pending' | 'accepted' | 'rejected';
}

export interface TimelineFileActionsOptions {
  /** 原始路径 (可为 workspace 相对路径) */
  path: string;
  /** 目录: Surface / 编辑器打开禁用, 左键与"打开"退化为 Finder 显示 */
  isDirectory?: boolean;
  /** 已删除文件 (turn summary delete 行): 打开/Finder 全禁, 只留复制路径 */
  deleted?: boolean;
  /** diff/edit 卡传入: Surface 打开时 Monaco 高亮这些改动行区间 */
  changedLines?: TimelineChangedLine[];
  /** edit 卡传入: Surface 打开时切 DiffEditor 渲染老/新 diff */
  editHunks?: TimelineEditHunk[];
  /** 文件尚未落盘 / 历史 workspace 不匹配时的内容兜底 — 存在检查放行 */
  fallbackContent?: string;
  /** 强制落 diff/源码视图 — 见 openSurface 里的注释 */
  forceDiffView?: boolean;
}

export interface TimelineFileActions {
  /** workspace 拼接后的绝对路径 (伪省略号路径原样返回) */
  resolvedPath: string;
  /** workspace 相对路径 (不在 workspace 内时 === resolvedPath) */
  relativePath: string;
  /** `…/foo/bar.ts` 这类展示用省略路径 — 一切打开动作不可用 */
  pseudo: boolean;
  /** 扩展名在 Surface 白名单内, 可右侧预览 */
  previewable: boolean;
  openSurface: (opts?: { preferCode?: boolean }) => Promise<void>;
  openEditor: () => Promise<void>;
  reveal: () => Promise<void>;
  copyAbsolutePath: () => Promise<void>;
  copyRelativePath: () => Promise<void>;
  /** 绑到触点元素的 onContextMenu */
  handleContextMenu: (e: React.MouseEvent) => void;
  /** 菜单 portal — caller 渲染在 JSX 尾部 (未打开时为 null) */
  contextMenu: React.ReactNode;
}

/** fsExists 三态: 明确不存在才拦, 校验失败(workspace 外)/无 IPC 一律放行. */
async function checkExists(resolvedPath: string): Promise<'exists' | 'missing' | 'unknown'> {
  try {
    const api = (window as any).neox;
    if (!api?.fsExists) return 'unknown';
    const r = await api.fsExists(resolvedPath);
    if (r?.success && r.exists === false) return 'missing';
    if (r?.success && r.exists === true) return 'exists';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

export function useTimelineFileActions(opts: TimelineFileActionsOptions): TimelineFileActions {
  const { path, isDirectory = false, deleted = false, changedLines, editHunks, fallbackContent, forceDiffView = false } = opts;
  const runtime = useNeoxRuntimeOptional();
  const container = useOptionalServiceContainer();
  const { isZh } = useI18n();
  const sessionId = runtime?.activeSession?.id ?? '';
  const workspacePath = runtime?.workspacePath;

  const [menuPos, setMenuPos] = React.useState<{ x: number; y: number } | null>(null);

  const pseudo = React.useMemo(() => isPseudoEllipsisPath(path), [path]);
  const resolvedPath = React.useMemo(
    () => (pseudo ? path : resolveWorkspacePath(path, workspacePath)),
    [path, pseudo, workspacePath],
  );
  const relativePath = React.useMemo(
    () => (pseudo ? path : relativeToWorkspace(resolvedPath, workspacePath)),
    [path, pseudo, resolvedPath, workspacePath],
  );
  const previewable = React.useMemo(
    () => !pseudo && !isDirectory && !deleted && isPreviewablePath(resolvedPath),
    [pseudo, isDirectory, deleted, resolvedPath],
  );

  const shortName = React.useMemo(
    () => resolvedPath.split(/[\\/]/).filter(Boolean).pop() || path,
    [resolvedPath, path],
  );

  const hintPseudo = React.useCallback(() => {
    dispatchHint(
      isZh ? '路径不完整（含省略号），无法打开' : 'Path is truncated (contains an ellipsis) and cannot be opened',
      'warning',
    );
  }, [isZh]);

  const hintMissing = React.useCallback(() => {
    dispatchHint(
      isZh ? `文件不存在: ${relativePath}` : `File not found: ${relativePath}`,
      'warning',
    );
  }, [isZh, relativePath]);

  const openSurface = React.useCallback(async (opts?: { preferCode?: boolean }) => {
    if (!path || deleted) return;
    if (pseudo) { hintPseudo(); return; }
    if (!sessionId || !previewable) return;
    /* 有 fallbackContent 时跳过存在检查 — 新建/覆写场景文件可能尚未落盘, surface 用兜底内容渲染. */
    if (!fallbackContent && (await checkExists(resolvedPath)) === 'missing') { hintMissing(); return; }
    const fromChange = forceDiffView
      || (changedLines && changedLines.length > 0) || (editHunks && editHunks.length > 0);
    openSurfaceFromPath({
      sessionId, path: resolvedPath, workspacePath, changedLines, editHunks, fallbackContent,
      preferKind: (opts?.preferCode || fromChange) ? 'code' : undefined,
    });
  }, [path, deleted, pseudo, sessionId, previewable, fallbackContent, resolvedPath, workspacePath, changedLines, editHunks, forceDiffView, hintPseudo, hintMissing]);

  const openEditor = React.useCallback(async () => {
    if (!path || deleted || isDirectory) return;
    if (pseudo) { hintPseudo(); return; }
    const editor = container?.tryGet(EDITOR_SERVICE);
    if (!editor) return;
    if ((await checkExists(resolvedPath)) === 'missing') { hintMissing(); return; }
    try {
      const tab = await editor.openFile(resolvedPath);
      if (!tab) {
        /* openFile 失败不抛错而是返回 null (错误经 EDITOR_TOPIC 广播) — 这里必须给直接反馈 */
        dispatchOpFailed({
          op: isZh ? '打开文件' : 'Open file',
          message: isZh ? `无法读取 ${relativePath}` : `Could not read ${relativePath}`,
        });
        return;
      }
      /* agent 模式没有编辑器视图 — tab 开在 IDE 布局里, 不提示用户会以为"点了没反应" */
      dispatchHint(
        isZh
          ? `已在 IDE 编辑器打开 ${shortName} · 顶栏切到 IDE 查看`
          : `Opened ${shortName} in the IDE editor — switch to IDE in the top bar to view`,
        'success',
      );
    } catch (err: any) {
      dispatchOpFailed({ op: isZh ? '打开文件' : 'Open file', message: String(err?.message ?? err) });
    }
  }, [path, deleted, isDirectory, pseudo, container, resolvedPath, relativePath, shortName, isZh, hintPseudo, hintMissing]);

  const reveal = React.useCallback(async () => {
    if (!path || deleted) return;
    if (pseudo) { hintPseudo(); return; }
    if ((await checkExists(resolvedPath)) === 'missing') { hintMissing(); return; }
    const api = (window as any).neox;
    try {
      /* fsRevealInFinder 走 workspace 校验; workspace 外路径 (~/Downloads 等) 校验会拒,
       * 退回 openInFinder (storage:open-in-finder, 无校验的 shell.showItemInFolder). */
      const r = api?.fsRevealInFinder ? await api.fsRevealInFinder(resolvedPath) : undefined;
      if (!r?.success && api?.openInFinder) {
        await api.openInFinder(resolvedPath);
      } else if (!r?.success && !api?.openInFinder) {
        throw new Error(r?.error || 'reveal unavailable');
      }
    } catch (err: any) {
      dispatchOpFailed({
        op: revealInFileManagerLabel(isZh),
        message: String(err?.message ?? err),
      });
    }
  }, [path, deleted, pseudo, resolvedPath, isZh, hintPseudo, hintMissing]);

  const copyText = React.useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      dispatchHint(isZh ? '已复制路径' : 'Path copied', 'success');
    } catch (err) {
      console.warn('[useTimelineFileActions] copy failed', err);
      dispatchHint(isZh ? '复制路径失败' : 'Failed to copy path', 'warning');
    }
  }, [isZh]);

  const copyAbsolutePath = React.useCallback(
    () => copyText(pseudo ? path : resolvedPath),
    [copyText, pseudo, path, resolvedPath],
  );
  const copyRelativePath = React.useCallback(
    () => copyText(pseudo ? path : relativePath),
    [copyText, pseudo, path, relativePath],
  );

  const handleContextMenu = React.useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenuPos({ x: e.clientX, y: e.clientY });
  }, []);

  const closeMenu = React.useCallback(() => setMenuPos(null), []);

  /* workspace 外文件 relativePath === resolvedPath — "复制相对路径" 没意义, 菜单不显示 */
  const hasDistinctRelative = !pseudo && relativePath !== resolvedPath;

  const contextMenu = menuPos ? (
    <ContextMenu
      position={menuPos}
      onClose={closeMenu}
      items={([
        {
          id: 'surface-edit',
          label: isZh ? '在右侧编辑源码' : 'Edit source on the right',
          icon: <IconPencil size={15} />,
          disabled: !previewable || !sessionId,
          onClick: () => { void openSurface({ preferCode: true }); },
        },
        { separator: true },
        {
          id: 'reveal',
          label: revealInFileManagerLabel(isZh),
          icon: <IconFolder size={15} />,
          disabled: pseudo || deleted,
          onClick: () => { void reveal(); },
        },
        { separator: true },
        {
          id: 'copy-path',
          label: isZh ? '复制路径' : 'Copy path',
          icon: <IconCopy size={15} />,
          onClick: () => { void copyAbsolutePath(); },
        },
        hasDistinctRelative
          ? {
              id: 'copy-rel-path',
              label: isZh ? '复制相对路径' : 'Copy relative path',
              icon: <IconCopy size={15} />,
              onClick: () => { void copyRelativePath(); },
            }
          : null,
      ] as Array<ContextMenuItem | null>).filter((it): it is ContextMenuItem => it !== null)}
    />
  ) : null;

  return {
    resolvedPath,
    relativePath,
    pseudo,
    previewable,
    openSurface,
    openEditor,
    reveal,
    copyAbsolutePath,
    copyRelativePath,
    handleContextMenu,
    contextMenu,
  };
}
