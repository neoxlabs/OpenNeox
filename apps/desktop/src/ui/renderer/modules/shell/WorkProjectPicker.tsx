/**
 * Work 项目浮层 —— 「最近」右边「全部 ▾」点开 (设计稿 E8jf「Work 项目」图 2/3/4)
 *
 *   项目少 (≤ 6): 全部任务 / 项目 (平铺) / ＋ 新建项目
 *   项目多:       搜索 / 全部任务 / 置顶 / 最近用过 / 其他 N 个 (按名称, 浮层内滚动) / ＋ 新建项目 · 全部项目 N ›
 *
 * 从侧栏右边弹出 (不盖住列表), 顶对齐触发器, 放不下就往上收。右键项目: 置顶 / 改名 / 归档。
 */
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ContextMenu, type ContextMenuItem } from '../../components/ContextMenu';
import { sameWorkspace } from '../../utils/pathUtils';
import { isMac } from '../../utils/keymap';
import { openFolderIcon } from './CodeWorkspaceCard';
import { groupProjects, projectArt, updateWorkProject, type WorkProject } from './workProjects';
import './work-projects.css';

const FLAT_MAX = 6;

const check = (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8.3 6.5 11 12.5 5" /></svg>
);
const plus = (
  <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" /></svg>
);
const gridIcon = (
  <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1.2" /><rect x="9" y="2.5" width="4.5" height="4.5" rx="1.2" /><rect x="2.5" y="9" width="4.5" height="4.5" rx="1.2" /><rect x="9" y="9" width="4.5" height="4.5" rx="1.2" /></svg>
);
const searchIcon = (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" /></svg>
);
const pinIcon = (
  <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" aria-hidden="true"><path d="M9.8 1.5 14.5 6.2l-1.4.4-2.6 2.6.3 3.3-1.2 1.2-2.6-2.6L3.3 14.7l-.6-.6 3.6-3.7-2.6-2.6 1.2-1.2 3.3.3 2.6-2.6z" /></svg>
);
const arrow = (
  <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4.5 3 7.5 6 4.5 9" /></svg>
);

export interface WorkProjectPickerProps {
  anchor: DOMRect;
  projects: readonly WorkProject[];
  counts: ReadonlyMap<string, number>;
  lastUsed: ReadonlyMap<string, number>;
  current: string | null;
  onPick: (dir: string | null) => void;
  onCreate: (name: string) => void;
  onAllProjects?: () => void;
  onClose: () => void;
  zh: boolean;
}

export const WorkProjectPicker: React.FC<WorkProjectPickerProps> = ({ anchor, projects, counts, lastUsed, current, onPick, onCreate, onAllProjects, onClose, zh }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState('');
  const [menu, setMenu] = useState<{ x: number; y: number; p: WorkProject } | null>(null);
  const [top, setTop] = useState<number | null>(null);

  const live = projects.filter((p) => !p.archived);
  const many = live.length > FLAT_MAX;
  const groups = useMemo(() => groupProjects(projects, lastUsed), [projects, lastUsed]);
  const query = q.trim().toLowerCase();
  const hits = query ? live.filter((p) => p.name.toLowerCase().includes(query)) : [];

  /* 放不下就往上收: 先按触发器顶对齐渲染一帧, 量了高度再定 top */
  useLayoutEffect(() => {
    const h = ref.current?.getBoundingClientRect().height ?? 0;
    setTop(Math.max(56, Math.min(anchor.top - 10, window.innerHeight - 14 - h)));
  }, [anchor.top, q, creating, live.length]);

  /* 点外面 / Esc 关; 右键菜单开着时让它先收 */
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (menu) return;
      const t = e.target as Node;
      if (ref.current?.contains(t) || (t as Element).closest?.('.wp-trigger')) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || menu) return;
      e.preventDefault(); e.stopPropagation();
      if (creating || renaming) { setCreating(false); setRenaming(null); } else onClose();
    };
    document.addEventListener('mousedown', down, true);
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('mousedown', down, true); document.removeEventListener('keydown', key, true); };
  }, [onClose, menu, creating, renaming]);

  const sidebarRight = (document.querySelector('.neox-sidebar') as HTMLElement | null)?.getBoundingClientRect().right ?? anchor.right;

  const commitRename = async (p: WorkProject) => {
    const v = renameVal.trim();
    setRenaming(null);
    if (v && v !== p.name) { try { await updateWorkProject(p.dir, { name: v }); } catch { /* 同名等 —— 原名不动 */ } }
  };

  const row = (p: WorkProject, hl?: string) => {
    const sel = !!current && sameWorkspace(current, p.dir);
    if (renaming === p.dir) {
      return (
        <div key={p.dir} className="wp-row is-editing">
          <img className="wp-row__art" src={projectArt(p.icon)} alt="" draggable={false} />
          <input
            autoFocus
            className="wp-row__input"
            value={renameVal}
            onChange={(e) => setRenameVal(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void commitRename(p); }}
            onBlur={() => void commitRename(p)}
          />
        </div>
      );
    }
    const name = hl ? highlight(p.name, hl) : p.name;
    return (
      <div
        key={p.dir}
        role="option"
        aria-selected={sel}
        tabIndex={-1}
        className={`wp-row${sel ? ' is-selected' : ''}`}
        onClick={() => onPick(p.dir)}
        onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, p }); }}
        title={p.dir}
      >
        <img className="wp-row__art" src={projectArt(p.icon)} alt="" draggable={false} />
        <span className="wp-row__name">{name}</span>
        <span className="wp-row__tail">{sel ? check : (counts.get(p.dir) ?? 0)}</span>
      </div>
    );
  };

  const cap = (label: string, right?: React.ReactNode) => (
    <div className="wp-cap"><span>{label}</span>{right}</div>
  );

  const menuItems = (p: WorkProject): ContextMenuItem[] => [
    { id: 'pin', label: p.pinned ? (zh ? '取消置顶' : 'Unpin') : (zh ? '置顶' : 'Pin'), onClick: () => void updateWorkProject(p.dir, { pinned: !p.pinned }).catch(() => {}) },
    { id: 'rename', label: zh ? '改名' : 'Rename', onClick: () => { setRenaming(p.dir); setRenameVal(p.name); } },
    { separator: true },
    { id: 'archive', label: zh ? '归档' : 'Archive', onClick: () => void updateWorkProject(p.dir, { archived: true }).catch(() => {}) },
  ];

  const createRow = creating ? (
    <div className="wp-row is-editing">
      <span className="wp-row__plus">{plus}</span>
      <input
        autoFocus
        className="wp-row__input"
        placeholder={zh ? '项目名，回车建好' : 'Project name, Enter to create'}
        value={newName}
        onChange={(e) => setNewName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && newName.trim()) onCreate(newName.trim()); }}
      />
    </div>
  ) : null;

  const body = (
    <div
      ref={ref}
      className="wp-pop"
      role="listbox"
      aria-label={zh ? '选项目' : 'Pick project'}
      style={{ left: sidebarRight + 2, top: top ?? anchor.top - 10, visibility: top === null ? 'hidden' : undefined }}
    >
      {many && (
        <label className="wp-search">
          {searchIcon}
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={zh ? '搜项目' : 'Search projects'} spellCheck={false} />
        </label>
      )}
      {query ? (
        <>
          {cap(hits.length ? (zh ? `找到 ${hits.length} 个项目` : `${hits.length} found`) : (zh ? '没有对得上的项目' : 'No match'))}
          {hits.map((p) => row(p, query))}
          <div className="wp-sep" />
          <div role="button" tabIndex={-1} className="wp-row is-action" onClick={() => onCreate(q.trim())}>
            <span className="wp-row__plus">{plus}</span>
            <span>{zh ? `新建项目「${q.trim()}」` : `New project “${q.trim()}”`}</span>
          </div>
        </>
      ) : (
        <>
          <div role="option" aria-selected={!current} tabIndex={-1} className={`wp-row${!current ? ' is-selected' : ''}`} onClick={() => onPick(null)}>
            <span className="wp-row__plus">{gridIcon}</span>
            <span className="wp-row__name">{zh ? '全部任务' : 'All tasks'}</span>
            <span className="wp-row__tail">{!current && check}</span>
          </div>
          {live.length > 0 && <div className="wp-sep" />}
          {!many && live.length > 0 && (
            <>
              {cap(zh ? '项目' : 'Projects')}
              {[...groups.pinned, ...groups.recent, ...groups.rest].map((p) => row(p))}
            </>
          )}
          {many && (
            <>
              {groups.pinned.length > 0 && <>{cap(zh ? '置顶' : 'Pinned', <span className="wp-cap__pin">{pinIcon}</span>)}{groups.pinned.map((p) => row(p))}</>}
              {groups.recent.length > 0 && <>{cap(zh ? '最近用过' : 'Recent')}{groups.recent.map((p) => row(p))}</>}
              {groups.rest.length > 0 && (
                <>
                  {cap(zh ? `其他 ${groups.rest.length} 个` : `${groups.rest.length} more`, <span>{zh ? '按名称' : 'A–Z'}</span>)}
                  <div className="wp-scroll">{groups.rest.map((p) => row(p))}</div>
                </>
              )}
            </>
          )}
          <div className="wp-sep" />
          {createRow ?? (
            <div className="wp-foot">
              <div role="button" tabIndex={-1} className="wp-row is-action" onClick={() => { setCreating(true); setNewName(''); }}>
                <span className="wp-row__plus">{plus}</span>
                <span>{zh ? '新建项目' : 'New project'}</span>
              </div>
              {onAllProjects && live.length > 0 && (
                <button type="button" className="wp-foot__all" onClick={onAllProjects}>
                  {zh ? `全部项目 ${live.length}` : `All projects ${live.length}`}{arrow}
                </button>
              )}
            </div>
          )}
        </>
      )}
      {menu && <ContextMenu position={{ x: menu.x, y: menu.y }} items={menuItems(menu.p)} onClose={() => setMenu(null)} />}
    </div>
  );
  return createPortal(body, document.body);
};

/**
 * Code「项目」标题右边「＋ 项目 ▾」的浮层 —— 跟 Work 项目浮层同一个样子:
 *   新建项目 (点了就地输名字, 回车建在编码目录并打开) / 打开项目… ⌘O
 */
export const CodeProjectMenu: React.FC<{
  anchor: DOMRect;
  newName: string | null;
  setNewName: (v: string | null) => void;
  onCreate?: (name: string) => void;
  onOpen?: () => void;
  /** 工作区: 新建 / 管理 (哪些项目、什么颜色) —— CodeWorkspaceCard */
  onNewWorkspace?: () => void;
  onManageWorkspaces?: () => void;
  workspaceCount?: number;
  onClose: () => void;
  zh: boolean;
}> = ({ anchor, newName, setNewName, onCreate, onOpen, onNewWorkspace, onManageWorkspaces, workspaceCount, onClose, zh }) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as Element;
      if (ref.current?.contains(t) || t.closest?.('.wp-trigger')) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } };
    document.addEventListener('mousedown', down, true);
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('mousedown', down, true); document.removeEventListener('keydown', key, true); };
  }, [onClose]);
  const sidebarRight = (document.querySelector('.neox-sidebar') as HTMLElement | null)?.getBoundingClientRect().right ?? anchor.right;
  return createPortal(
    <div ref={ref} className="wp-pop" role="menu" style={{ left: sidebarRight + 2, top: Math.max(56, Math.min(anchor.top - 10, window.innerHeight - 260)) }}>
      <div className="wp-cap"><span>{zh ? '项目' : 'Projects'}</span></div>
      {onCreate && (newName !== null ? (
        <div className="wp-row is-editing">
          <span className="wp-row__plus">{plus}</span>
          <input
            autoFocus
            className="wp-row__input"
            placeholder={zh ? '项目名，回车建好' : 'Project name, Enter to create'}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && newName.trim()) onCreate(newName.trim()); }}
          />
        </div>
      ) : (
        <div role="menuitem" tabIndex={-1} className="wp-row is-action" onClick={() => setNewName('')} title={zh ? '在编码目录里建一个空项目 (git init)' : 'Create an empty project'}>
          <span className="wp-row__plus">{plus}</span>
          <span>{zh ? '新建项目' : 'New project'}</span>
        </div>
      ))}
      {onOpen && (
        <div role="menuitem" tabIndex={-1} className="wp-row is-action" onClick={onOpen}>
          <span className="wp-row__plus">{openFolderIcon(undefined, 15)}</span>
          <span>{zh ? '打开项目…' : 'Open project…'}</span>
          <span className="wp-row__tail">{isMac ? '⌘O' : 'Ctrl+O'}</span>
        </div>
      )}
      {(onNewWorkspace || onManageWorkspaces) && (
        <>
          <div className="wp-sep" />
          <div className="wp-cap"><span>{zh ? '工作区 · 一起改的几个项目，同一个颜色' : 'Workspaces · projects changed together'}</span></div>
          {onNewWorkspace && (
            <div role="menuitem" tabIndex={-1} className="wp-row is-action" onClick={onNewWorkspace}>
              <span className="wp-row__plus">{plus}</span>
              <span>{zh ? '新建工作区' : 'New workspace'}</span>
            </div>
          )}
          {onManageWorkspaces && (
            <div role="menuitem" tabIndex={-1} className="wp-row is-action" onClick={onManageWorkspaces}>
              <span className="wp-row__plus">{layersIcon}</span>
              <span>{zh ? '工作区管理' : 'Manage workspaces'}</span>
              {!!workspaceCount && <span className="wp-row__tail">{workspaceCount}</span>}
            </div>
          )}
        </>
      )}
    </div>,
    document.body,
  );
};

const layersIcon = (
  <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true"><path d="M8 2.2 14 5.4 8 8.6 2 5.4z" /><path d="m2 8.2 6 3.2 6-3.2" /><path d="m2 11 6 3.2 6-3.2" /></svg>
);

function highlight(name: string, q: string): React.ReactNode {
  const i = name.toLowerCase().indexOf(q);
  if (i < 0) return name;
  return <>{name.slice(0, i)}<b className="wp-hl">{name.slice(i, i + q.length)}</b>{name.slice(i + q.length)}</>;
}

export default WorkProjectPicker;
