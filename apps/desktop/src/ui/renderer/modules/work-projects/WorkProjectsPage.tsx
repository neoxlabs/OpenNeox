/**
 * Work 全部项目页 (设计稿 E8jf「Work 项目」图 6) —— 项目浮层底部「全部项目 N ›」进来
 *
 * 标题 + 搜索 (项目名和任务名都搜) + 排序 (最近用过 / 名称 / 任务数) + 新建项目;
 * 置顶一排, 下面全部; 卡片右键: 置顶 / 改名 / 归档 / 在访达中显示。归档的收在页底「已归档 N 个」。
 */
import React, { useMemo, useState } from 'react';
import { ContextMenu, type ContextMenuItem } from '../../components/ContextMenu';
import { dispatchHint } from '../../components/notifyEvents';
import { useNeoxRuntime } from '../../app/NeoxRuntimeContext';
import { displaySessionName } from '../../state/sessionDisplayName';
import { revealInFileManagerLabel } from '../../utils/fileManagerLabels';
import { createWorkProject, projectArt, shortDay, tasksByProject, updateWorkProject, useWorkProjects, type WorkProject } from '../shell/workProjects';
import emptyArt from '../../media/clay/proj-box.webp';
import './work-projects-page.css';

type Sort = 'recent' | 'name' | 'count';

const pinIcon = (
  <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" aria-hidden="true"><path d="M9.8 1.5 14.5 6.2l-1.4.4-2.6 2.6.3 3.3-1.2 1.2-2.6-2.6L3.3 14.7l-.6-.6 3.6-3.7-2.6-2.6 1.2-1.2 3.3.3 2.6-2.6z" /></svg>
);
const plus = (
  <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" /></svg>
);

export const WorkProjectsPage: React.FC<{ onOpenProject: (dir: string) => void; onClose: () => void; zh: boolean }> = ({ onOpenProject, onClose, zh }) => {
  const projects = useWorkProjects();
  const { sessions } = useNeoxRuntime();
  const byProject = useMemo(() => tasksByProject(sessions, projects), [sessions, projects]);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<Sort>('recent');
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState('');
  const [menu, setMenu] = useState<{ x: number; y: number; p: WorkProject } | null>(null);

  const lastTs = (p: WorkProject) => {
    const t = byProject.get(p.dir)?.[0];
    return t ? (t.updatedAt ?? t.createdAt ?? 0) : p.createdAt;
  };
  const query = q.trim().toLowerCase();
  const visible = projects
    .filter((p) => p.archived === showArchived)
    .filter((p) => !query || p.name.toLowerCase().includes(query)
      || (byProject.get(p.dir) ?? []).some((s) => (s.name ?? '').toLowerCase().includes(query)))
    .sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name, 'zh')
      : sort === 'count' ? (byProject.get(b.dir)?.length ?? 0) - (byProject.get(a.dir)?.length ?? 0)
      : lastTs(b) - lastTs(a));
  const pinned = showArchived || query ? [] : visible.filter((p) => p.pinned);
  const rest = visible.filter((p) => !pinned.includes(p));
  const archivedCount = projects.filter((p) => p.archived).length;
  const liveCount = projects.length - archivedCount;

  const create = async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      const p = await createWorkProject(name);
      setCreating(false); setNewName('');
      if (p) onOpenProject(p.dir);
    } catch (e) { dispatchHint((e as Error).message, 'warning'); }
  };
  const commitRename = async (p: WorkProject) => {
    const v = renameVal.trim();
    setRenaming(null);
    if (v && v !== p.name) { try { await updateWorkProject(p.dir, { name: v }); } catch (e) { dispatchHint((e as Error).message, 'warning'); } }
  };
  const menuItems = (p: WorkProject): ContextMenuItem[] => [
    ...(p.archived ? [] : [{ id: 'pin', label: p.pinned ? (zh ? '取消置顶' : 'Unpin') : (zh ? '置顶' : 'Pin'), onClick: () => void updateWorkProject(p.dir, { pinned: !p.pinned }).catch(() => {}) }]),
    { id: 'rename', label: zh ? '改名' : 'Rename', onClick: () => { setRenaming(p.dir); setRenameVal(p.name); } },
    { id: 'reveal', label: revealInFileManagerLabel(zh), onClick: () => {
      try {
        const opening = (window as { neox?: { openInFinder?: (p: string) => Promise<unknown> } }).neox?.openInFinder?.(p.dir);
        void opening?.catch(() => dispatchHint(zh ? '打开文件夹失败' : 'Couldn’t open the folder', 'warning'));
      } catch { /* 没有 bridge 的宿主直接忽略 */ }
    } },
    { separator: true },
    p.archived
      ? { id: 'restore', label: zh ? '恢复' : 'Restore', onClick: () => void updateWorkProject(p.dir, { archived: false }).catch(() => {}) }
      : { id: 'archive', label: zh ? '归档' : 'Archive', onClick: () => void updateWorkProject(p.dir, { archived: true }).catch(() => {}) },
  ];

  const card = (p: WorkProject) => {
    const tasks = byProject.get(p.dir) ?? [];
    const last = tasks[0];
    return (
      <div
        key={p.dir}
        role="button"
        tabIndex={0}
        className="nx-pj-card"
        onClick={() => { if (renaming !== p.dir) onOpenProject(p.dir); }}
        onKeyDown={(e) => { if (e.key === 'Enter' && renaming !== p.dir) onOpenProject(p.dir); }}
        onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, p }); }}
        title={p.dir}
      >
        <div className="nx-pj-card__top">
          <img className="nx-pj-card__art" src={projectArt(p.icon)} alt="" draggable={false} />
          <div style={{ minWidth: 0, flex: 1 }}>
            {renaming === p.dir ? (
              <input
                autoFocus
                value={renameVal}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setRenameVal(e.target.value)}
                onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') void commitRename(p); if (e.key === 'Escape') setRenaming(null); }}
                onBlur={() => void commitRename(p)}
              />
            ) : <div className="nx-pj-card__name">{p.name}</div>}
            <div className="nx-pj-card__meta">{zh ? `${tasks.length} 个任务` : `${tasks.length} tasks`}{last ? ` · ${shortDay(last.updatedAt ?? last.createdAt)}` : ''}</div>
          </div>
          {p.pinned && !p.archived && <span className="nx-pj-card__pin">{pinIcon}</span>}
        </div>
        <div className="nx-pj-card__last">
          {last ? `${zh ? '最近：' : 'Latest: '}${displaySessionName(last.name, last.createdAt, zh)}` : (zh ? '还没有任务' : 'No tasks yet')}
        </div>
      </div>
    );
  };

  return (
    <div className="nx-pj">
      <button type="button" className="nx-pj__back" onClick={onClose}>
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" /></svg>
        {zh ? '返回' : 'Back'}
      </button>
      <div className="nx-pj__head">
        <div className="nx-pj__title">{showArchived ? (zh ? '已归档的项目' : 'Archived projects') : (zh ? '项目' : 'Projects')}</div>
        <div className="nx-pj__count">{zh ? `${showArchived ? archivedCount : liveCount} 个` : `${showArchived ? archivedCount : liveCount}`}</div>
        <div className="nx-pj__tools">
          <label className="nx-pj__search">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" /></svg>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={zh ? '搜项目或任务' : 'Search projects or tasks'} spellCheck={false} />
          </label>
          <div className="nx-pj__seg" role="tablist">
            {([['recent', zh ? '最近用过' : 'Recent'], ['name', zh ? '名称' : 'Name'], ['count', zh ? '任务数' : 'Tasks']] as const).map(([k, l]) => (
              <button key={k} type="button" role="tab" aria-selected={sort === k} className={sort === k ? 'is-on' : ''} onClick={() => setSort(k)}>{l}</button>
            ))}
          </div>
          {!showArchived && (
            <button type="button" className="nx-pj__primary" onClick={() => { setCreating(true); setNewName(''); }}>{plus}{zh ? '新建项目' : 'New project'}</button>
          )}
        </div>
      </div>
      {creating && (
        <div className="nx-pj__new">
          <img src={projectArt('cup')} alt="" style={{ width: 24, height: 24, objectFit: 'contain' }} />
          <input
            autoFocus
            value={newName}
            placeholder={zh ? '项目名，比如「咖啡店运营」' : 'Project name'}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void create(); if (e.key === 'Escape') setCreating(false); }}
            onBlur={() => { if (!newName.trim()) setCreating(false); }}
          />
          <span>{zh ? '回车建好' : 'Enter to create'}</span>
        </div>
      )}
      {liveCount === 0 && !showArchived && !creating ? (
        <div className="nx-pj__empty">
          <img src={emptyArt} alt="" />
          {zh ? '还没有项目' : 'No projects yet'}
          <p>{zh ? '每周重复的活放进项目：说明和资料只交代一次，项目里每个任务都带上。' : 'Put recurring work in a project: notes and files are shared by every task.'}</p>
          <button type="button" className="nx-pj__primary" onClick={() => setCreating(true)}>{plus}{zh ? '新建项目' : 'New project'}</button>
        </div>
      ) : (
        <>
          {pinned.length > 0 && <><div className="nx-pj__cap">{zh ? '置顶' : 'Pinned'}</div><div className="nx-pj__grid">{pinned.map(card)}</div></>}
          {rest.length > 0 && <><div className="nx-pj__cap">{pinned.length > 0 ? (zh ? '全部' : 'All') : ''}</div><div className="nx-pj__grid">{rest.map(card)}</div></>}
          {visible.length === 0 && <div className="nx-pj__empty">{query ? (zh ? '没有对得上的项目' : 'No match') : (zh ? '没有归档的项目' : 'Nothing archived')}</div>}
        </>
      )}
      {(archivedCount > 0 || showArchived) && (
        <button type="button" className="nx-pj__archived" onClick={() => setShowArchived((v) => !v)}>
          {showArchived ? (zh ? '‹ 回到全部项目' : '‹ All projects') : (zh ? `已归档 ${archivedCount} 个 ›` : `${archivedCount} archived ›`)}
        </button>
      )}
      {menu && <ContextMenu position={{ x: menu.x, y: menu.y }} items={menuItems(menu.p)} onClose={() => setMenu(null)} />}
    </div>
  );
};

export default WorkProjectsPage;
