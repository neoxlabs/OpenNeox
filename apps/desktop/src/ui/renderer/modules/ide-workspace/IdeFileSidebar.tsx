import React, { useCallback, useEffect, useRef, useState } from 'react';
import FileExplorer from '../explorer/components/FileExplorer';
import { IconPanelRight, IconPencil, IconTrash } from '../shell/shellIcons';
import { useService } from '../../platform';
import { EDITOR_SERVICE } from '../../../../ide';
import { useNeoxRuntime } from '../../app/NeoxRuntimeContext';
import { openSurfaceFromPath } from '../../state/openSurfaceFromPath';
import { ensureSurfaceVisible } from '../../state/panelLayoutStore';
import { dispatchHint, dispatchOpFailedFromError } from '../../components/notifyEvents';
import { ContextMenu, type ContextMenuItem } from '../../components/ContextMenu';
import { explorerSettings, useExplorerSettings } from '../explorer/state/explorerSettings';
import { IconPlus, IconRefresh, IconFolder, IconFolderPlus, IconChevronRight, IconChevronLeft, IconLocate, IconMoreH, IconCopy, IconArrowLeft, IconCheck, IconFile, IconCollapseAll, IconPanelLeft } from '../shell/shellIcons';
import { useAppStore } from '../../../state/appStore';
import { workspaceRoots } from '../../../shared/ipc';
import { confirmAsync, promptAsync } from '../../components/confirmEvents';
import { useI18n, defaultIsZh } from '../../hooks/useI18n';
import { sameWorkspace } from '../../utils/pathUtils';
import { revealInFileManagerLabel } from '../../utils/fileManagerLabels';

interface RecentEntry {
  path: string;
  name: string;
  lastOpened?: number;
}

type IdeSideView = 'workspace' | 'explorer';

interface Props {
  /** 当前要显示的面板 (由外层 IconRail 决定) */
  view?: IdeSideView;
  /** 工作区面板要编辑哪个工作区 (primary 路径); 不给 = 当前工作区 */
  workspaceTarget?: string;
  /** 给了就在面板头部左侧显示返回箭头 (侧栏内嵌工作区面板用) */
  onBack?: () => void;
}

/* ============================================================
 * IdeFileSidebar — 左侧栏的文件树 / 工作区面板
 *
 *   点文件走 Surface, 在右侧面板里看 / 改 (代码面板自带编辑器)。
 * ============================================================ */
export const IdeFileSidebar: React.FC<Props> = ({ view = 'explorer', workspaceTarget, onBack }) => {
  const { isZh } = useI18n();
  return (
    <aside className="ide-sidebar ide-sidebar--agent" aria-label={isZh ? "资源管理器侧边栏" : "Explorer sidebar"}>
      {view === 'workspace'  && <WorkspaceHubPanel targetPath={workspaceTarget} onBack={onBack} />}
      {view === 'explorer'   && <ExplorerPanel />}
    </aside>
  );
};

/* ============================================================
 * ExplorerPanel — 资源管理器面板 (自定义 head + 文件树 + 最近工作区)
 * ============================================================ */
const ExplorerPanel: React.FC = () => {
  const { isZh } = useI18n();
  const runtime = useNeoxRuntime();
  const editorService = useService(EDITOR_SERVICE);
  const settings = useExplorerSettings();

  /* 多根工作区: roots 来自 appStore.workspace.roots (primary = runtime.workspacePath)。
   *   单根 (roots.length<=1) → 渲染跟以前完全一致, 零回归。增删根入口在「工作区」hub 面板。 */
  const { workspace, removeWorkspaceRoot } = useAppStore();
  const roots = workspaceRoots(workspace);
  const isMultiRoot = roots.length > 1;

  /* 点文件 → openSurfaceFromPath, 右栏 SurfacePanel 渲染.
   *   - 不能预览的文件类型 (.exe / .zip 等) openSurfaceFromPath 返 false, fallback 到 reveal.
   *   - sessionId 没有时用 workspacePath 兜底 (用户刚启动还没 session). */
  const handleOpenFile = useCallback(async (path: string) => {
    const surfaceSessionId = runtime.activeSession?.id || runtime.workspacePath || '__agent__';
    const ok = openSurfaceFromPath({
      sessionId: surfaceSessionId,
      path,
      workspacePath: runtime.workspacePath,
    });
    if (ok) {
      ensureSurfaceVisible();
      return;
    }
    /* 这个扩展名 Surface 打不开 (.exe/.zip 之类) —— 在访达里给他看, 别静默 */
    dispatchHint(isZh ? '这个文件类型不能预览, 已在文件管理器中定位' : 'Cannot preview this file type; revealing it instead', 'info');
    try { void (window.neox as any).fsRevealInFinder?.(path); } catch { /* 老宿主没有这个 IPC */ }
  }, [runtime.activeSession?.id, runtime.workspacePath, isZh]);

  const handleSelectOnly = useCallback((p: string) => {
    editorService.setSelectedFilePath(p || null);
  }, [editorService]);

  /* ---------- 头部三按钮: ⋯ / + / ↻ ---------- */
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuBtnRef = useRef<HTMLButtonElement>(null);

  /* 关掉菜单 (点外面 / Esc) */
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    window.addEventListener('click', close);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', esc);
    };
  }, [menuOpen]);

  const handleRefresh = useCallback(() => {
    setRefreshNonce((n) => n + 1);
  }, []);

  /* "打开文件夹" — 当前项目打开后, 想换一个新目录时的入口.
   *   走 openFolderDialog → 派 'neox:open-workspace' 事件让 AppShell 接管 (同 openRecent
   *   一致路径: focusExistingWindow + loading overlay + setWorkspace + addRecent), 不要
   *   直接调 window.neox.setWorkspace — 那样 AppShell 的 useAppStore.workspace 不会更新,
   *   key={workspace.path} 不变, 子树不重挂, 用户感知"点了没反应". */
  const handleOpenFolder = useCallback(async () => {
    try {
      const folderPath = await window.neox.openFolderDialog();
      if (!folderPath) return;
      window.dispatchEvent(new CustomEvent('neox:open-workspace', { detail: { path: folderPath } }));
    } catch (err: any) {
      console.error('[IdeFileSidebar] openFolderDialog failed', err);
      dispatchOpFailedFromError(isZh ? '打开文件夹' : 'Open folder', err);
    }
  }, [isZh]);

  /* 新建文件 / 新建文件夹 / 定位当前文件 / 折叠全部 — 全部派事件到 FileExplorer.
   *   FileExplorer 内部有 NewItemDialog / collapseAll / scroll-into-view 一整套现成逻辑,
   *   sidebar 不重做 (之前 window.prompt 的实现质感差, 且选中目录后建在子目录的语义全丢). */
  const handleNewFile   = useCallback(() => window.dispatchEvent(new Event('neox:explorer:new-file')), []);
  const handleNewFolder = useCallback(() => window.dispatchEvent(new Event('neox:explorer:new-folder')), []);
  const handleCollapse  = useCallback(() => window.dispatchEvent(new Event('neox:explorer:collapse-all')), []);

  /* ---------- 最近工作区 ---------- */
  const [recents, setRecents] = useState<RecentEntry[]>([]);
  const [showAll, setShowAll] = useState(false);
  /* section 折叠态 — 单工作区固定模式下用户多半不想看一整列, 默认展开但允许折叠并持久化 */
  const [recentsCollapsed, setRecentsCollapsed] = useState<boolean>(() => {
    try { return window.localStorage.getItem('neox-ide-recents-collapsed') === '1'; }
    catch { return false; }
  });
  const toggleRecents = useCallback(() => {
    setRecentsCollapsed((v) => {
      const next = !v;
      try { window.localStorage.setItem('neox-ide-recents-collapsed', next ? '1' : '0'); } catch { /* quota */ }
      return next;
    });
  }, []);
  const reloadRecents = useCallback(async () => {
    try {
      const list = await window.neox.listWorkspaces();
      const seen = new Set<string>();
      const out: RecentEntry[] = [];
      for (const ws of list ?? []) {
        if (!ws.path || seen.has(ws.path)) continue;
        seen.add(ws.path);
        out.push({ path: ws.path, name: ws.name || ws.path.split(/[/\\]/).pop() || ws.path, lastOpened: ws.lastOpened });
      }
      setRecents(out);
    } catch (err) {
      console.warn('[IdeFileSidebar] listWorkspaces failed', err);
    }
  }, []);
  useEffect(() => { void reloadRecents(); }, [reloadRecents]);

  const visibleRecents = showAll ? recents : recents.slice(0, 4);

  /* 最近工作区项的右键菜单 — 4 项: 当前/新窗口打开 + Finder + 复制路径.
   *   "从最近移除" 需要新 IPC (ui:remove-recent-workspace), 留 followup. */
  const [recentMenu, setRecentMenu] = useState<{
    position: { x: number; y: number };
    items: ContextMenuItem[];
  } | null>(null);

  const openRecentContextMenu = useCallback((e: React.MouseEvent, path: string) => {
    e.preventDefault();
    e.stopPropagation();
    const isCurrent = sameWorkspace(path, runtime.workspacePath);
    const items: ContextMenuItem[] = [
      {
        id: 'open-here',
        label: isZh ? '在当前窗口打开' : 'Open in current window',
        icon: <IconFolder size={15} />,
        disabled: isCurrent,
        onClick: () => window.dispatchEvent(new CustomEvent('neox:open-workspace', { detail: { path } })),
      },
      {
        id: 'open-new-window',
        label: isZh ? '在新窗口打开' : 'Open in new window',
        icon: <IconPanelRight size={15} />,
        onClick: async () => {
          try { await window.neox.openWindowWithWorkspace?.(path); }
          catch (err: any) { dispatchOpFailedFromError(isZh ? '在新窗口打开' : 'Open in new window', err); }
        },
      },
      { separator: true },
      {
        id: 'rename-ws',
        label: isZh ? '重命名工作区…' : 'Rename workspace…',
        icon: <IconPencil size={15} />,
        onClick: async () => {
          const cur = recents.find((r) => r.path === path)?.name || path.split(/[/\\]/).pop() || '';
          const next = await promptAsync({ title: isZh ? '重命名工作区' : 'Rename workspace', placeholder: isZh ? '工作区名称' : 'Workspace name', defaultValue: cur, confirmLabel: isZh ? '重命名' : 'Rename' });
          if (next == null) return;
          try {
            await window.neox.setWorkspaceName(path, next.trim());
            dispatchHint(isZh ? '已重命名工作区' : 'Workspace renamed', 'success');
            void reloadRecents();
          } catch (err: any) { dispatchOpFailedFromError(isZh ? '重命名工作区' : 'Rename workspace', err); }
        },
      },
      {
        id: 'delete-ws',
        label: isZh ? '从列表删除' : 'Remove from list',
        icon: <IconTrash size={15} />,
        disabled: isCurrent,
        onClick: async () => {
          const nm = recents.find((r) => r.path === path)?.name || path.split(/[/\\]/).pop() || '';
          const ok = await confirmAsync({ title: isZh ? `从列表删除工作区「${nm}」?` : `Remove workspace "${nm}" from the list?`, message: isZh ? '只移除记录, 不会删除磁盘上的文件夹。' : 'This only removes the record and will not delete files on disk.', variant: 'danger', confirmLabel: isZh ? '删除' : 'Remove' });
          if (!ok) return;
          try {
            await window.neox.deleteWorkspace(path);
            dispatchHint(isZh ? '已删除工作区' : 'Workspace removed', 'success');
            void reloadRecents();
          } catch (err: any) { dispatchOpFailedFromError(isZh ? '删除工作区' : 'Remove workspace', err); }
        },
      },
    ];
    setRecentMenu({ position: { x: e.clientX, y: e.clientY }, items });
  }, [runtime.workspacePath, recents, reloadRecents, isZh]);

  const openRecent = useCallback((path: string) => {
    if (sameWorkspace(path, runtime.workspacePath)) return;
    window.dispatchEvent(new CustomEvent('neox:open-workspace', { detail: { path } }));
  }, [runtime.workspacePath]);

  return (
    <div className="ide-side ide-side--explorer">
      <header className="ide-side__head">
        <div className="ide-side__head-title" title={runtime.workspacePath}>
          {/* 从侧栏「文件管理器」按钮切进来的, 给一条回会话列表的路 —
           *   事件解耦 (NeoxShellHost 监听), 跟 'neox:open-workspace' 同款。 */}
          <button
            type="button"
            className="ide-side__head-back"
            title={isZh ? '返回会话列表' : 'Back to sessions'}
            aria-label={isZh ? '返回会话列表' : 'Back to sessions'}
            onClick={() => window.dispatchEvent(new CustomEvent('neox:agent-explorer-back'))}
          >
            <IconArrowLeft size={16} />
          </button>
          <span>{isZh ? '资源管理器' : 'Explorer'}</span>
        </div>
        <div className="ide-side__head-actions">
          <button
            type="button"
            className="ide-side__head-btn"
            title={isZh
              ? `工作区: ${workspace?.name || runtime.workspacePath.split(/[/\\]/).pop()} · 点击管理 / 切换`
              : `Workspace: ${workspace?.name || runtime.workspacePath.split(/[/\\]/).pop()} · manage / switch`}
            aria-label={isZh ? '工作区' : 'Workspace'}
            onClick={() => window.dispatchEvent(new Event('neox:ide:open-workspace-hub'))}
          >
            {/* 多个方块摞在一起 = "一组项目", 跟树里单个文件夹图标区分得开 */}
            <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
              <path d="M2.2 5.4 8 2.4l5.8 3-5.8 3-5.8-3Z" />
              <path d="M2.2 8.4 8 11.4l5.8-3" />
              <path d="M2.2 11.2 8 14.2l5.8-3" opacity=".55" />
            </svg>
          </button>
          <div className="ide-sidebar__menu-wrap">
            <button
              ref={menuBtnRef}
              type="button"
              className="ide-side__head-btn ide-side__head-btn--more"
              title={isZh ? "更多操作" : "More actions"}
              aria-label={isZh ? "更多操作" : "More actions"}
              onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
            ><IconMoreH size={16} /></button>
            {menuOpen && menuBtnRef.current && (() => {
              const r = menuBtnRef.current.getBoundingClientRect();
              const tick = (on: boolean) => (on ? <IconCheck size={14} /> : <span style={{ width: 14, display: 'inline-block' }} />);
              const dot = (on: boolean) => (
                <span style={{ width: 14, display: 'inline-flex', justifyContent: 'center', fontSize: 11, lineHeight: '14px' }}>{on ? '●' : '○'}</span>
              );
              const items: ContextMenuItem[] = [
                { id: 'new-file', label: isZh ? '新建文件' : 'New file', icon: <IconFile size={15} />, onClick: () => { setMenuOpen(false); handleNewFile(); } },
                { id: 'new-folder', label: isZh ? '新建文件夹' : 'New folder', icon: <IconFolderPlus size={15} />, onClick: () => { setMenuOpen(false); handleNewFolder(); } },
                { id: 'open-folder', label: isZh ? '打开文件夹…' : 'Open folder…', icon: <IconFolder size={15} />, onClick: () => { setMenuOpen(false); void handleOpenFolder(); } },
                { separator: true },
                { id: 'collapse-all', label: isZh ? '折叠全部' : 'Collapse all', icon: <IconCollapseAll size={15} />, onClick: () => { setMenuOpen(false); handleCollapse(); } },
                { id: 'refresh', label: isZh ? '刷新' : 'Refresh', icon: <IconRefresh size={15} />, onClick: () => { setMenuOpen(false); handleRefresh(); } },
                { id: 'collapse-sidebar', label: isZh ? '折叠侧栏' : 'Collapse sidebar', icon: <IconPanelLeft size={15} />, onClick: () => { setMenuOpen(false); window.dispatchEvent(new Event('neox:sidebar:toggle-collapse')); } },
                { separator: true },
                { id: 'hidden', label: isZh ? '显示隐藏文件' : 'Show hidden files', icon: tick(settings.showHiddenFiles), onClick: () => { explorerSettings.toggle('showHiddenFiles'); setMenuOpen(false); } },
                { id: 'single-click', label: isZh ? '单击打开文件/展开文件夹' : 'Open on single click', icon: tick(settings.openOnSingleClick), onClick: () => { explorerSettings.toggle('openOnSingleClick'); setMenuOpen(false); } },
                { id: 'excluded', label: isZh ? '显示已排除文件' : 'Show excluded files', icon: tick(settings.showExcludedFiles), onClick: () => { explorerSettings.toggle('showExcludedFiles'); setMenuOpen(false); } },
                { separator: true },
                ...(['name', 'type', 'time-desc'] as const).map((sb) => ({
                  id: `sort-${sb}`,
                  label: sb === 'name' ? (isZh ? '按名称' : 'By name') : sb === 'type' ? (isZh ? '按类型' : 'By type') : (isZh ? '按修改时间' : 'By modified time'),
                  icon: dot(settings.sortBy === sb),
                  onClick: () => { explorerSettings.set('sortBy', sb); setMenuOpen(false); },
                })),
              ];
              return (
                <ContextMenu
                  position={{ x: Math.max(8, r.right - 200), y: r.bottom + 4 }}
                  items={items}
                  onClose={() => setMenuOpen(false)}
                />
              );
            })()}
          </div>
        </div>
      </header>


      {/* 文件树 — 单根: 跟以前完全一致 (ide-sidebar__top, FileExplorer flex:1 占满).
          多根: 用独立容器 ide-sidebar__multiroot —— 不继承单根的 flex:1 子规则, 每段按
          自然高度紧凑堆叠, 外层统一滚动 (避免 flex:1 平分留大空白)。 */}
      {!isMultiRoot ? (
        <div className="ide-sidebar__top">
          <FileExplorer
            key={`${runtime.workspacePath}:${refreshNonce}`}
            workspacePath={runtime.workspacePath}
            /* 没有编辑器 tab 概念, 不高亮"当前文件" */
            selectedFile={null}
            onSelectFile={handleSelectOnly}
            onOpenFile={(p) => void handleOpenFile(p)}
            className="ide-sidebar__tree"
          />
        </div>
      ) : (
        <div className="ide-sidebar__multiroot">
          {roots.map((root, i) => {
            const isPrimary = sameWorkspace(root, runtime.workspacePath);
            return (
              <FileExplorer
                key={`${root}:${refreshNonce}`}
                workspacePath={root}
                selectedFile={null}
                onSelectFile={handleSelectOnly}
                onOpenFile={(p) => void handleOpenFile(p)}
                className="ide-sidebar__tree ide-sidebar__tree--root"
                hideHeader
                respondsToGlobalActions={isPrimary || i === 0}
                onRemoveFromWorkspace={isPrimary ? undefined : () => void (async () => {
                  const nm = root.split(/[/\\]/).pop() || root;
                  if (await confirmAsync({ title: isZh ? `从工作区移除「${nm}」?` : `Remove "${nm}" from workspace?`, message: isZh ? '只移出当前工作区, 不会删除磁盘文件。' : 'This only removes it from the current workspace and will not delete files on disk.', confirmLabel: isZh ? '移除' : 'Remove' })) removeWorkspaceRoot(root);
                })()}
              />
            );
          })}
        </div>
      )}

      {recentMenu && (
        <ContextMenu
          position={recentMenu.position}
          items={recentMenu.items}
          onClose={() => setRecentMenu(null)}
        />
      )}
    </div>
  );
};

/* ============================================================
 * WorkspaceHubPanel — 左侧「工作区」入口面板 (rail 工作区图标点开)
 *
 *   一眼看清: 本工作区有哪些项目 (roots) + 加/删/切。这是用户要的
 *   "点工作区 logo → 显示所有项目列表"。文件树(资源管理器)负责浏览,
 *   这里负责"工作区由哪些项目组成"的管理。
 * ============================================================ */
interface OtherWs { path: string; name: string; lastOpened: number; rootCount: number; saved: boolean }

const WorkspaceHubPanel: React.FC<{ targetPath?: string; onBack?: () => void }> = ({ targetPath, onBack }) => {
  const { isZh } = useI18n();
  const runtime = useNeoxRuntime();
  const { workspace, addWorkspaceRoot, removeWorkspaceRoot, renameWorkspace } = useAppStore();
  const curRoots = workspaceRoots(workspace);
  const curPrimary = runtime.workspacePath;

  const isCurrent = !targetPath || sameWorkspace(targetPath, curPrimary);
  const [otherRoots, setOtherRoots] = useState<string[]>([]);
  const [otherName, setOtherName] = useState<string>('');
  const reloadTarget = useCallback(async () => {
    if (isCurrent || !targetPath) return;
    try {
      const rs = await window.neox.getWorkspaceRoots(targetPath);
      setOtherRoots(Array.isArray(rs) && rs.length ? rs : [targetPath]);
      const list = await window.neox.listWorkspaces();
      const hit = (list || []).find((w) => w.path === targetPath);
      setOtherName(hit?.name || targetPath.split(/[/\\]/).pop() || targetPath);
    } catch (err) {
      console.warn('[WorkspaceHubPanel] load target failed', err);
      setOtherRoots([targetPath]);
    }
  }, [isCurrent, targetPath]);
  useEffect(() => { void reloadTarget(); }, [reloadTarget]);

  const roots = isCurrent ? curRoots : otherRoots;
  const primary = isCurrent ? curPrimary : (otherRoots[0] || targetPath || curPrimary);
  const wsName = isCurrent
    ? (workspace?.name || curPrimary.split(/[/\\]/).pop() || curPrimary)
    : (otherName || (targetPath || '').split(/[/\\]/).pop() || '');
  const isCurrentSaved = isCurrent
    ? (roots.length > 1 || (workspace?.name && workspace.name !== (curPrimary.split(/[/\\]/).pop() || '')))
    : roots.length > 1;

  /* 改根: 当前工作区交给 appStore (它还要同步 runtime); 别的工作区直接写盘 + 本地刷新 */
  const applyRoots = useCallback(async (next: string[]) => {
    /* 失败必须让用户看见 —— 改的是别的工作区, 界面上不会有任何"没生效"的迹象
     * (ipcErrorFeedback.test.ts 那条闸也盯着这类无声 IPC)。 */
    try {
      await window.neox.setWorkspaceRoots(primary, next);
      await reloadTarget();
    } catch (err: any) {
      dispatchOpFailedFromError(isZh ? '更新工作区项目' : 'Update workspace projects', err);
    }
  }, [primary, reloadTarget, isZh]);
  const addRoot = useCallback(async (p: string) => {
    if (isCurrent) { await addWorkspaceRoot(p); return; }
    if (roots.includes(p)) { dispatchHint(isZh ? '这个项目已在该工作区里' : 'Already in that workspace', 'info'); return; }
    await applyRoots([...roots, p]);
    dispatchHint(isZh ? `已添加到「${wsName}」` : `Added to "${wsName}"`, 'success');
  }, [isCurrent, addWorkspaceRoot, roots, applyRoots, wsName, isZh]);
  const removeRoot = useCallback(async (p: string) => {
    if (isCurrent) { removeWorkspaceRoot(p); return; }
    await applyRoots(roots.filter((r) => r !== p));
    dispatchHint(isZh ? `已从「${wsName}」移除` : `Removed from "${wsName}"`, 'success');
  }, [isCurrent, removeWorkspaceRoot, roots, applyRoots, wsName, isZh]);

  /* 其它工作区 (带 saved 标记+rootCount) — 排除当前工作区的所有根。 */
  const [others, setOthers] = useState<OtherWs[]>([]);
  const reload = useCallback(async () => {
    try {
      const list = await window.neox.listWorkspaces();
      const cur = new Set<string>(roots);
      setOthers((list || []).filter((w) => w.path !== primary && !cur.has(w.path)));
    } catch (err) {
      console.warn('[WorkspaceHubPanel] listWorkspaces failed', err);
    }
  }, [primary, roots.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void reload(); }, [reload]);

  /* 重命名当前工作区 — 内联编辑。 */
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState(wsName);
  useEffect(() => { setNameInput(wsName); }, [wsName]);
  const commitName = useCallback(async () => {
    setEditingName(false);
    const next = nameInput.trim();
    if (!next || next === wsName) return;
    try {
      if (isCurrent) await renameWorkspace(next);
      else { await window.neox.setWorkspaceName(primary, next); await reloadTarget(); }
    } catch (err: any) {
      dispatchOpFailedFromError(isZh ? '重命名工作区' : 'Rename workspace', err);
      return;
    }
    void reload();
  }, [nameInput, wsName, renameWorkspace, reload, isCurrent, primary, reloadTarget, isZh]);

  const handleAdd = useCallback(async () => {
    try {
      const folderPath = await window.neox.openFolderDialog();
      if (!folderPath) return;
      await addRoot(folderPath);
    } catch (err: any) {
      dispatchOpFailedFromError(isZh ? '添加文件夹到工作区' : 'Add folder to workspace', err);
    }
  }, [addRoot, isZh]);

  /* 新建工作区 = 打开我们自己的创建弹窗 (命名 + 组合项目), 不直接弹文件夹。 */

  const openInExplorer = useCallback(() => {
    window.dispatchEvent(new Event('neox:ide:open-explorer'));
  }, []);

  const switchWorkspace = useCallback((path: string) => {
    if (path === primary) return;
    window.dispatchEvent(new CustomEvent('neox:open-workspace', { detail: { path } }));
  }, [primary, isZh]);

  /* 设为主项目 — 重排 roots + 重新 key, 然后切到新 primary (runner cwd 跟着变)。 */
  const setPrimary = useCallback(async (r: string) => {
    if (r === primary) return;
    try {
      await window.neox.setPrimaryRoot(primary, r);
      dispatchHint(isZh ? `已设为主项目: ${r.split(/[/\\]/).pop()}` : `Primary project set: ${r.split(/[/\\]/).pop()}`, 'success');
      /* 改的是当前工作区才需要把应用切过去 (runner cwd 得跟着变);
         改别人的工作区只写盘, 不打扰用户正在做的事 */
      if (isCurrent) window.dispatchEvent(new CustomEvent('neox:open-workspace', { detail: { path: r } }));
      else await reloadTarget();
    } catch (err: any) {
      dispatchOpFailedFromError(isZh ? '设为主项目' : 'Set as primary project', err);
    }
  }, [primary, isZh, isCurrent, reloadTarget]);

  /* 删除工作区 (仅其它工作区; 当前的需先切走)。不删磁盘, 只从列表移除。 */
  const deleteWs = useCallback(async (path: string, name: string) => {
    const ok = await confirmAsync({ title: isZh ? `从列表删除工作区「${name}」?` : `Remove workspace "${name}" from the list?`, message: isZh ? '只移除记录, 不会删除磁盘上的文件夹。' : 'This only removes the record and will not delete files on disk.', variant: 'danger', confirmLabel: isZh ? '删除' : 'Remove' });
    if (!ok) return;
    try {
      await window.neox.deleteWorkspace(path);
      dispatchHint(isZh ? `已删除工作区「${name}」` : `Workspace "${name}" removed`, 'success');
      void reload();
    } catch (err: any) {
      dispatchOpFailedFromError(isZh ? '删除工作区' : 'Remove workspace', err);
    }
  }, [reload, isZh]);

  const [rowMenu, setRowMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);

  const copyPath = useCallback((p: string) => {
    try {
      void navigator.clipboard.writeText(p);
      dispatchHint(isZh ? '已复制路径' : 'Path copied', 'success');
    } catch { /* 剪贴板不可用时静默 —— 右键菜单不该因为复制失败弹错误卡 */ }
  }, [isZh]);

  const revealInFileManager = useCallback((p: string) => {
    void (async () => {
      try {
        const r = await (window.neox as any)?.fsRevealInFinder?.(p);
        /* 宿主没有这个 IPC (返回 undefined) 或明确失败 → 退回内置资源管理器 */
        if (!r || r.success === false) throw new Error(r?.error || 'reveal unavailable');
      } catch {
        window.dispatchEvent(new Event('neox:ide:open-explorer'));
      }
    })();
  }, []);

  const openRootMenu = useCallback((e: React.MouseEvent, r: string) => {
    e.preventDefault();
    e.stopPropagation();
    const isPrimary = r === primary;
    const nm = r.split(/[/\\]/).pop() || r;
    const items: ContextMenuItem[] = [
      ...(isPrimary ? [] : [{ id: 'primary', label: isZh ? '设为主项目' : 'Set as primary project', icon: <IconLocate size={15} />, onClick: () => void setPrimary(r) }]),
      { id: 'reveal', label: revealInFileManagerLabel(isZh), icon: <IconFolder size={15} />, onClick: () => revealInFileManager(r) },
      { id: 'copy', label: isZh ? '复制路径' : 'Copy path', icon: <IconCopy size={15} />, onClick: () => copyPath(r) },
      ...(isPrimary || roots.length <= 1 ? [] : [
        { separator: true },
        { id: 'remove', label: isZh ? '从工作区移除' : 'Remove from workspace', icon: <IconTrash size={15} />, destructive: true, onClick: () => void (async () => {
          if (await confirmAsync({ title: isZh ? `从工作区移除「${nm}」?` : `Remove "${nm}" from workspace?`, message: isZh ? '只移出当前工作区, 不会删除磁盘文件。' : 'This only removes it from the current workspace and will not delete files on disk.', confirmLabel: isZh ? '移除' : 'Remove' })) void removeRoot(r);
        })() },
      ]),
    ];
    setRowMenu({ x: e.clientX, y: e.clientY, items });
  }, [primary, roots.length, isZh, setPrimary, revealInFileManager, copyPath, removeRoot]);

  const openOtherMenu = useCallback((e: React.MouseEvent, o: OtherWs) => {
    e.preventDefault();
    e.stopPropagation();
    const items: ContextMenuItem[] = [
      { id: 'switch', label: isZh ? '切换到这个工作区' : 'Switch to this workspace', icon: <IconChevronRight size={15} />, onClick: () => switchWorkspace(o.path) },
      { id: 'add', label: isZh ? '加进当前工作区' : 'Add to current workspace', icon: <IconPlus size={15} />, onClick: () => void addRoot(o.path) },
      { id: 'reveal', label: revealInFileManagerLabel(isZh), icon: <IconFolder size={15} />, onClick: () => revealInFileManager(o.path) },
      { id: 'copy', label: isZh ? '复制路径' : 'Copy path', icon: <IconCopy size={15} />, onClick: () => copyPath(o.path) },
      { separator: true },
      { id: 'del', label: isZh ? '从列表删除' : 'Remove from list', icon: <IconTrash size={15} />, destructive: true, onClick: () => void deleteWs(o.path, o.name) },
    ];
    setRowMenu({ x: e.clientX, y: e.clientY, items });
  }, [isZh, switchWorkspace, addRoot, revealInFileManager, copyPath, deleteWs]);

  const savedOthers = others.filter((o) => o.saved);
  const projectOthers = others.filter((o) => !o.saved);

  const renderOther = (o: OtherWs) => (
    <li
      key={o.path}
      className="ws-hub__recent"
      title={o.path}
      role="button"
      tabIndex={0}
      onClick={() => switchWorkspace(o.path)}
      onKeyDown={(e) => { if (e.key === 'Enter') switchWorkspace(o.path); }}
      onContextMenu={(e) => openOtherMenu(e, o)}
    >
      <span className="ws-hub__recent-icon">
        <IconFolder size={16} />
        {o.rootCount > 1 && <span className="ws-hub__icon-badge">{o.rootCount > 9 ? '9+' : o.rootCount}</span>}
      </span>
      <span className="ws-hub__recent-meta">
        <span className="ws-hub__recent-name">{o.name}</span>
        <span className="ws-hub__recent-path">{tildeify(o.path)}</span>
      </span>
      <span className="ws-hub__recent-actions">
        <button
          type="button"
          className="ws-hub__root-act ws-hub__root-act--primary"
          title={isZh ? "加进当前工作区 (并列项目, 不切换过去)" : "Add to current workspace (as a parallel project, without switching)"}
          aria-label={isZh ? "加进当前工作区" : "Add to current workspace"}
          onClick={(e) => { e.stopPropagation(); void addRoot(o.path); }}
        ><IconPlus size={14} /></button>
        <button
          type="button"
          className="ws-hub__root-act ws-hub__root-act--danger"
          title={isZh ? "从列表删除 (不删磁盘文件)" : "Remove from list (does not delete disk files)"}
          aria-label={isZh ? "从列表删除" : "Remove from list"}
          onClick={(e) => { e.stopPropagation(); void deleteWs(o.path, o.name); }}
        ><IconTrash size={14} /></button>
      </span>
    </li>
  );

  return (
    <div className="ide-side ide-side--workspace">
      <header className="ide-side__head">
        <div className="ide-side__head-title">
          {onBack && (
            <button
              type="button"
              className="ide-side__head-back"
              title={isZh ? '返回会话列表' : 'Back to chats'}
              aria-label={isZh ? '返回' : 'Back'}
              onClick={onBack}
            >
              <IconArrowLeft size={16} />
            </button>
          )}
          <span>{isZh ? '工作区' : 'Workspace'}</span>
        </div>
      </header>

      <div className="ws-hub">
        {/* 当前工作区: 名称 (可重命名) */}
        {editingName && (
          <div className="ws-hub__current">
            <input
              className="ws-hub__name-input"
              autoFocus
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              onBlur={() => void commitName()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commitName();
                else if (e.key === 'Escape') { setNameInput(wsName); setEditingName(false); }
              }}
            />
          </div>
        )}
        {/* 编辑的不是当前工作区时必须说清楚 —— 否则改完根本不知道改的是谁 */}
        {!isCurrent && (
          <div className="ws-hub__foreign">
            <span className="ws-hub__foreign-tag">{isZh ? '非当前工作区' : 'Not the current workspace'}</span>
            <button
              type="button"
              className="ws-hub__foreign-switch"
              onClick={() => switchWorkspace(primary)}
            >{isZh ? '切换过去' : 'Switch to it'}</button>
          </div>
        )}

        <div className="ws-hub__section">
          <div className="ws-hub__section-label ws-hub__section-label--ws">
            <span className="ws-hub__section-name">{isZh ? '工作区' : 'Workspace'}: {wsName}</span>
            <button
              type="button"
              className="ws-hub__section-edit"
              title={isZh ? '重命名工作区' : 'Rename workspace'}
              aria-label={isZh ? '重命名工作区' : 'Rename workspace'}
              onClick={() => { setNameInput(wsName); setEditingName(true); }}
            ><IconPencil size={13} /></button>
          </div>
          <ul className="ws-hub__roots">
            {roots.map((r) => {
              const isPrimary = r === primary;
              const name = r.split(/[/\\]/).pop() || r;
              return (
                <li
                  key={r}
                  className={`ws-hub__root${isPrimary ? ' is-primary' : ''}`}
                  title={isPrimary
                    ? `${r}\n${isZh ? '当前主项目 (agent 的工作目录)' : 'Current primary project (agent working directory)'}`
                    : `${r}\n${isZh ? '点击设为主项目' : 'Click to make it the primary project'}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => { if (!isPrimary) void setPrimary(r); }}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !isPrimary) void setPrimary(r); }}
                  onContextMenu={(e) => openRootMenu(e, r)}
                >
                  <span className="ws-hub__root-icon"><IconFolder size={16} /></span>
                  <span className="ws-hub__root-meta">
                    <span className="ws-hub__root-name">
                      {name}
                      {isPrimary && <span className="ws-hub__badge" title={isZh ? "主项目 (agent / 运行的工作目录)" : "Primary project (agent / runtime working directory)"}>{isZh ? '主' : 'Primary'}</span>}
                    </span>
                    <span className="ws-hub__root-path">{tildeify(r)}</span>
                  </span>
                  <span className="ws-hub__root-actions">
                    <button
                      type="button"
                      className="ws-hub__root-act"
                      title={revealInFileManagerLabel(isZh)}
                      aria-label={revealInFileManagerLabel(isZh)}
                      onClick={(e) => { e.stopPropagation(); openInExplorer(); }}
                    ><IconLocate size={14} /></button>
                    {/* 主项目不给移除 —— 工作区不能没有工作目录; 想换先把别的设成主 */}
                    {!isPrimary && roots.length > 1 && (
                      <button
                        type="button"
                        className="ws-hub__root-act ws-hub__root-act--danger"
                        title={isZh ? "从工作区移除 (不删磁盘文件)" : "Remove from workspace (does not delete files)"}
                        aria-label={isZh ? "从工作区移除" : "Remove from workspace"}
                        onClick={(e) => { e.stopPropagation(); void (async () => {
                          const nm = r.split(/[/\\]/).pop() || r;
                          if (await confirmAsync({ title: isZh ? `从工作区移除「${nm}」?` : `Remove "${nm}" from workspace?`, message: isZh ? '只移出当前工作区, 不会删除磁盘文件。' : 'This only removes it from the current workspace and will not delete files on disk.', confirmLabel: isZh ? '移除' : 'Remove' })) void removeRoot(r);
                        })(); }}
                      ><IconTrash size={14} /></button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
          <button type="button" className="ws-hub__add" onClick={() => void handleAdd()}>
            <IconFolderPlus size={16} />
            <span>{isZh ? '添加文件夹到工作区' : 'Add folder to workspace'}</span>
          </button>
        </div>

        {savedOthers.length > 0 && (
          <div className="ws-hub__section">
            <div className="ws-hub__section-label">{isZh ? '已保存的工作区' : 'Saved workspaces'}</div>
            <ul className="ws-hub__recents">{savedOthers.map(renderOther)}</ul>
          </div>
        )}

        <div className="ws-hub__section">
          <div className="ws-hub__section-label">{isZh ? '最近项目' : 'Recent projects'}</div>
          {projectOthers.length === 0 ? (
            <div className="ws-hub__empty">{isZh ? '没有其它最近项目' : 'No other recent projects'}</div>
          ) : (
            <ul className="ws-hub__recents">{projectOthers.map(renderOther)}</ul>
          )}
        </div>
      </div>

      {rowMenu && (
        <ContextMenu position={{ x: rowMenu.x, y: rowMenu.y }} items={rowMenu.items} onClose={() => setRowMenu(null)} />
      )}
    </div>
  );
};

/* ============================================================
 * 时间格式化: 今天 14:28 / 昨天 / N 天前 / N 周前
 * ============================================================ */
function relTime(ts?: number, isZh = defaultIsZh()): string {
  if (!ts || !Number.isFinite(ts)) return '';
  const now = Date.now();
  const diff = now - ts;
  if (diff < 60_000) return isZh ? '刚刚' : 'just now';
  if (diff < 3600_000) return isZh ? `${Math.floor(diff / 60_000)} 分钟前` : `${Math.floor(diff / 60_000)} min ago`;
  const today = new Date(now);
  const that = new Date(ts);
  const sameDay = today.toDateString() === that.toDateString();
  if (sameDay) return isZh ? `今天` : `today`;
  const yesterday = new Date(now - 86_400_000);
  if (yesterday.toDateString() === that.toDateString()) return isZh ? '昨天' : 'yesterday';
  const days = Math.floor(diff / 86_400_000);
  if (days < 7) return isZh ? `${days} 天前` : `${days} days ago`;
  if (days < 30) return isZh ? `${Math.floor(days / 7)} 周前` : `${Math.floor(days / 7)} weeks ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return isZh ? `${months} 月前` : `${months} months ago`;
  return isZh ? `${Math.floor(months / 12)} 年前` : `${Math.floor(months / 12)} years ago`;
}

/* 把 /Users/<me>/Foo → ~/Foo */
function tildeify(p: string): string {
  const m = /^\/(?:Users|home)\/[^/]+\/(.*)$/.exec(p);
  if (m) return `~/${m[1]}`;
  return p;
}

export default IdeFileSidebar;
