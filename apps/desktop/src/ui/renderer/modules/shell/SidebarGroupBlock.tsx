import React, { useEffect, useMemo, useState } from 'react';
import { IconFolder, IconLayers, IconPlus } from './shellIcons';
import { SidebarGroupFiles } from './SidebarGroupFiles';
import type { SessionItem } from './Sidebar';

export interface SessionGroupLike {
  path: string;
  name: string;
  sessions: SessionItem[];
  isActive: boolean;
  latestActivity: number;
  isTimeBucket?: boolean;
  spaceMode?: 'work';
}

const GROUP_COLLAPSE_LIMIT = 5;
const CHILD_COLLAPSE_LIMIT = 8;

/** 分组用到的回调和很少变的值 —— Sidebar 侧用 useEvent 包好, 引用稳定 */
export interface GroupCtx {
  isZh: boolean;
  hideProjects: boolean;
  isWork: boolean;
  spaceIcon: React.ReactNode;
  hasDelete: boolean;
  hasNewChat: boolean;
  hasWorkspacePanel: boolean;
  SessionRow: React.ComponentType<any>;
  toggleGroup: (path: string, collapsed: boolean) => void;
  onWsDragStart: (e: React.DragEvent, path: string) => void;
  onWsDragOver: (e: React.DragEvent, path: string) => void;
  onWsDragLeave: () => void;
  onWsDrop: (e: React.DragEvent, path: string) => void;
  onWsDragEnd: () => void;
  onWsContextMenu: (e: React.MouseEvent, g: SessionGroupLike) => void;
  setWsEditValue: (v: string) => void;
  commitWsRename: () => void;
  cancelWsRename: () => void;
  toggleFiles: (g: SessionGroupLike) => void;
  showWorkspacePanel: (path?: string) => void;
  newChatIn: (g: SessionGroupLike) => void;
  openGroupMenu: (g: SessionGroupLike, rect: DOMRect) => void;
  switchAndCreate: (g: SessionGroupLike) => void;
  row: {
    onClick: (groupPath: string, groupIsActive: boolean, id: string) => void;
    onContextMenu: (e: React.MouseEvent, id: string) => void;
    onEditChange: (v: string) => void;
    onCommitEdit: (id: string) => void;
    onCancelEdit: () => void;
    onToggleArchive: (id: string) => void;
    onDeleteRequested: (id: string, title: string) => void;
  };
  toggleChildExpand: (sessionId: string) => void;
  showMoreChildren: (parentId: string, total: number) => void;
  keepInView: (el: HTMLElement) => void;
  showMoreInGroup: (path: string, total: number) => void;
  collapseGroup: (path: string) => void;
}

interface Props {
  g: SessionGroupLike;
  ctx: GroupCtx;
  collapsedNow: boolean;
  /** 当前会话 id —— 只在它属于本组 (含子会话) 时给, 否则 null */
  activeId: string | null;
  /** 当前会话在本组且正在流式 */
  streamingActive: boolean;
  /** 本组里正在跑的会话 id, '|' 连接 */
  runningKey: string;
  editingId: string | null;
  editValue: string;
  archivedKey: string;
  showCount: number | undefined;
  /** 本组里子会话列表被手动展开的父会话 id */
  expandedKey: string;
  /** 本组父会话的「显示更多子任务」条数, 'id:n|id:n' */
  childShowKey: string;
  filesOn: boolean;
  isDragging: boolean;
  isDragOver: boolean;
  wsEditing: boolean;
  wsEditValue: string;
  rootCount: number;
  loading: boolean;
}

const splitKey = (k: string) => new Set(k ? k.split('|') : []);

function SidebarGroupBlockImpl({
  g, ctx, collapsedNow, activeId, streamingActive, runningKey, editingId, editValue, archivedKey,
  showCount, expandedKey, childShowKey, filesOn, isDragging, isDragOver, wsEditing, wsEditValue, rootCount, loading,
}: Props) {
  const { isZh, SessionRow } = ctx;
  /* 收起时会话行先留着, 等 0fr 折叠动画播完 (260ms) 再卸载 —— 立刻卸载的话内容一空高度直接跳 0, 没动画 */
  const [keepBody, setKeepBody] = useState(!collapsedNow);
  useEffect(() => {
    if (!collapsedNow) { setKeepBody(true); return; }
    const t = window.setTimeout(() => setKeepBody(false), 260);
    return () => window.clearTimeout(t);
  }, [collapsedNow]);
  const showBody = !collapsedNow || keepBody;
  const running = useMemo(() => splitKey(runningKey), [runningKey]);
  const archived = useMemo(() => splitKey(archivedKey), [archivedKey]);
  const expandedChildren = useMemo(() => splitKey(expandedKey), [expandedKey]);
  const childShow = useMemo(() => new Map(childShowKey ? childShowKey.split('|').map((p) => { const i = p.lastIndexOf(':'); return [p.slice(0, i), Number(p.slice(i + 1))] as [string, number]; }) : []), [childShowKey]);

  return (
    <>
      {g.isTimeBucket && (
        <li
          className={`neox-sidebar__time-bucket${collapsedNow ? ' is-collapsed' : ''}`}
          role="button"
          tabIndex={0}
          onClick={() => ctx.toggleGroup(g.path, collapsedNow)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              ctx.toggleGroup(g.path, collapsedNow);
            }
          }}
          aria-expanded={!collapsedNow}
        >
          <span className="neox-sidebar__time-bucket-label">{g.name}</span>
          <span className="neox-sidebar__time-bucket-count">{g.sessions.length}</span>
        </li>
      )}
      {!ctx.hideProjects && !g.isTimeBucket && (
      <li
        className={`neox-sidebar__group${g.isActive ? ' is-active' : ''}${g.spaceMode ? ' is-space' : ''}${isDragging ? ' is-ws-dragging' : ''}${isDragOver ? ' is-ws-drag-over' : ''}`}
        data-workspace-path={g.path || undefined}
        role="button"
        tabIndex={0}
        draggable={!g.spaceMode}
        onDragStart={g.spaceMode ? undefined : (e) => ctx.onWsDragStart(e, g.path)}
        onDragOver={g.spaceMode ? undefined : (e) => ctx.onWsDragOver(e, g.path)}
        onDragLeave={g.spaceMode ? undefined : ctx.onWsDragLeave}
        onDrop={g.spaceMode ? undefined : (e) => ctx.onWsDrop(e, g.path)}
        onDragEnd={g.spaceMode ? undefined : ctx.onWsDragEnd}
        /* 文件夹行点击 = 仅折叠/展开 (工作区切换走点会话 / 新建会话, 不在这里切, 免得整棵树 remount 抖一下) */
        onClick={() => ctx.toggleGroup(g.path, collapsedNow)}
        onContextMenu={(e) => ctx.onWsContextMenu(e, g)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            ctx.toggleGroup(g.path, collapsedNow);
          }
        }}
        aria-expanded={!collapsedNow}
      >
        <span className="neox-sidebar__group-icon" aria-hidden="true">
          {g.spaceMode ? ctx.spaceIcon : (
            <IconFolder size={16} strokeWidth={1.5} />
          )}
          {rootCount > 1 ? (
            <span className="neox-sidebar__group-icon-badge">{rootCount > 9 ? '9+' : rootCount}</span>
          ) : null}
        </span>
        <span className="neox-sidebar__group-name-wrap" title={g.path || g.name}>
          {wsEditing ? (
            <input
              className="neox-sidebar__group-name-input"
              value={wsEditValue}
              onChange={(e) => ctx.setWsEditValue(e.target.value)}
              onBlur={ctx.commitWsRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') ctx.commitWsRename();
                if (e.key === 'Escape') ctx.cancelWsRename();
              }}
              onClick={(e) => e.stopPropagation()}
              autoFocus
            />
          ) : (
            <span className="neox-sidebar__group-name">{g.name}</span>
          )}
          {/* 会话条数 —— 组可折叠, 折起来之后这是唯一的量级线索 */}
          {g.sessions.length > 0 && (
            <span className="neox-sidebar__group-count">{g.sessions.length}</span>
          )}
        </span>
        {/* 文件树 + 编辑工作区共用 grid 里那一格 (行是 5 列 grid, 多一个子元素会把 ＋ ⋯ 挤到下一行) */}
        <span className="neox-sidebar__group-acts">
        {/* 看这个项目的文件树: 就地把这一组的会话换成文件树 (SidebarGroupFiles) */}
        {!g.isTimeBucket && g.path && (
          <button
            type="button"
            className={`neox-sidebar__group-editws neox-sidebar__group-files${filesOn ? ' is-on' : ''}`}
            title={filesOn ? (isZh ? '回到会话' : 'Back to chats') : (isZh ? '看这个项目的文件' : 'Browse project files')}
            aria-label={isZh ? '文件树' : 'File tree'}
            onClick={(e) => { e.stopPropagation(); ctx.toggleFiles(g); }}
            aria-pressed={filesOn}
          >
            {/* 树形图标 (根 + 两层缩进), 跟行首的文件夹图标区分开 */}
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="2" y="2.2" width="4.2" height="3.4" rx="1" /><rect x="9" y="6.3" width="4.6" height="3.4" rx="1" /><rect x="9" y="10.6" width="4.6" height="3.4" rx="1" /><path d="M4.1 5.6v6.7h4.9M4.1 8h4.9" /></svg>
          </button>
        )}
        {ctx.hasWorkspacePanel ? (
          <button
            type="button"
            className="neox-sidebar__group-editws"
            title={isZh ? '编辑工作区 (项目列表 / 主项目)' : 'Edit workspace (projects / primary)'}
            aria-label={isZh ? '编辑工作区' : 'Edit workspace'}
            onClick={(e) => { e.stopPropagation(); ctx.showWorkspacePanel(g.path || undefined); }}
          >
            <IconLayers size={14} />
          </button>
        ) : null}
        </span>
        {/* 新建会话 + 按钮 — 常驻显示 */}
        {ctx.hasNewChat && (
          <button
            type="button"
            className="neox-sidebar__group-newchat"
            onClick={(e) => { e.stopPropagation(); ctx.newChatIn(g); }}
            title={isZh ? '在该项目新建会话' : 'New chat in this project'}
            aria-label={isZh ? '新建会话' : 'New chat'}
          >
            <IconPlus size={16} />
          </button>
        )}
        {/* ⋯ 菜单 — 常驻显示, 点击弹 WorkspaceContextMenu (移除项目 / 重命名 等). */}
        <button
          type="button"
          className="neox-sidebar__group-more"
          onClick={(e) => { e.stopPropagation(); ctx.openGroupMenu(g, (e.currentTarget as HTMLElement).getBoundingClientRect()); }}
          title={isZh ? '更多操作' : 'More actions'}
          aria-label={isZh ? '更多操作' : 'More actions'}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="4" cy="8" r="1" fill="currentColor" stroke="none" />
            <circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" />
            <circle cx="12" cy="8" r="1" fill="currentColor" stroke="none" />
          </svg>
        </button>
      </li>
      )}
      <li
        className={`neox-sidebar__group-body${collapsedNow ? ' is-collapsed' : ''}`}
        aria-hidden={collapsedNow}
      >
        <div className={`neox-sidebar__group-body__inner${filesOn ? ' is-files' : ''}`}>
          {filesOn && <SidebarGroupFiles path={g.path} zh={isZh} />}
          {showBody && g.sessions.length === 0 && (
            loading ? (
              <>
                <div className="neox-sidebar__skeleton-row" aria-hidden="true" />
                <div className="neox-sidebar__skeleton-row" aria-hidden="true" style={{ animationDelay: '.08s' }} />
                <div className="neox-sidebar__skeleton-row" aria-hidden="true" style={{ animationDelay: '.16s' }} />
              </>
            ) : (
              /* 非 active group 也给引导 (P2-32): 点击切换 workspace + 新建 */
              <div className="neox-sidebar__group-empty">
                {g.isActive ? (
                  <span aria-hidden="true">{isZh ? '暂无会话,点上方「新建」开始' : 'No chats yet. Click New above to start'}</span>
                ) : (
                  <button
                    type="button"
                    className="neox-sidebar__group-empty-switch"
                    onClick={() => ctx.switchAndCreate(g)}
                    title={isZh ? `切到 ${g.name} 并新建会话` : `Switch to ${g.name} and create a chat`}
                  >
                    {isZh
                      ? (g.spaceMode ? '暂无会话,切到此空间新建 →' : '暂无会话,切到此项目新建 →')
                      : 'No chats. Switch here to create one →'}
                  </button>
                )}
              </div>
            )
          )}
          {showBody && (() => {
            /* 父子嵌套: sub-agent session 有 parentSessionId, 渲染时挂到父 row 下面;
             *  顶层 = 没 parent 的 + parent 不在本组的 (孤儿当顶级); GROUP_COLLAPSE_LIMIT 只算顶级。 */
            const groupIds = new Set(g.sessions.map((s) => s.id));
            const childMap = new Map<string, SessionItem[]>();
            const topLevel: SessionItem[] = [];
            for (const s of g.sessions) {
              const pid = s.parentSessionId;
              if (pid && groupIds.has(pid)) {
                const arr = childMap.get(pid) ?? [];
                arr.push(s);
                childMap.set(pid, arr);
              } else {
                topLevel.push(s);
              }
            }

            const shownBase = Math.min(showCount ?? GROUP_COLLAPSE_LIMIT, topLevel.length);
            let anchorIdx = activeId ? topLevel.findIndex((s) => s.id === activeId) : -1;
            if (anchorIdx < 0 && activeId) {
              for (const [pid, kids] of childMap) {
                if (kids.some((k) => k.id === activeId)) {
                  anchorIdx = topLevel.findIndex((s) => s.id === pid);
                  break;
                }
              }
            }
            const shown = anchorIdx >= shownBase ? anchorIdx + 1 : shownBase;
            const overflow = topLevel.length - shown;
            /* 「收起」只跟用户自己点出来的展开走 */
            const expanded = shownBase > GROUP_COLLAPSE_LIMIT;
            const visible = overflow > 0 ? topLevel.slice(0, shown) : topLevel;

            const renderRow = (s: SessionItem, isChild: boolean) => {
              const isActive = s.id === activeId;
              const isStreaming = running.has(s.id) || (isActive && streamingActive);
              const isEditing = editingId === s.id;
              return (
                <div key={s.id} className={isChild ? 'neox-sidebar__sub-row' : undefined}>
                  <SessionRow
                    session={s}
                    groupPath={g.path}
                    groupIsActive={g.isActive}
                    isActive={isActive}
                    isStreaming={isStreaming}
                    isArchived={archived.has(s.id)}
                    isEditing={isEditing}
                    editValue={isEditing ? editValue : ''}
                    showDelete={ctx.hasDelete}
                    onClick={ctx.row.onClick}
                    onContextMenu={ctx.row.onContextMenu}
                    onEditChange={ctx.row.onEditChange}
                    onCommitEdit={ctx.row.onCommitEdit}
                    onCancelEdit={ctx.row.onCancelEdit}
                    onToggleArchive={ctx.row.onToggleArchive}
                    onDeleteRequested={ctx.row.onDeleteRequested}
                    isZh={isZh}
                    plain={ctx.isWork}
                  />
                </div>
              );
            };

            return (
              <>
                {visible.map((s) => {
                  const children = childMap.get(s.id) ?? [];
                  const childRunning = children.some((c) => running.has(c.id));
                  const childActive = children.some((c) => c.id === activeId);
                  const childForcedOpen = childRunning || childActive;
                  const childExpanded = expandedChildren.has(s.id) || childForcedOpen;
                  return (
                    <React.Fragment key={s.id}>
                      <div onClick={children.length > 0 ? (e) => {
                        e.stopPropagation();
                        if (!childExpanded) ctx.toggleChildExpand(s.id); /* 展开 */
                        else if (!childForcedOpen && s.id === activeId) ctx.toggleChildExpand(s.id); /* 二次点击收起 */
                      } : undefined}>
                        {renderRow(s, false)}
                      </div>
                      {children.length > 0 && (() => {
                        const childBase = Math.min(childShow.get(s.id) ?? CHILD_COLLAPSE_LIMIT, children.length);
                        const activeChildIdx = activeId ? children.findIndex((c) => c.id === activeId) : -1;
                        const shownChildren = activeChildIdx >= childBase ? activeChildIdx + 1 : childBase;
                        const restChildren = children.length - shownChildren;
                        return (
                          /* __children-inner 单一包裹是 grid 0fr→1fr 展开动画的前提 */
                          <div className={`neox-sidebar__children${childExpanded ? ' is-open' : ''}`}>
                            <div className="neox-sidebar__children-inner">
                              {children.slice(0, shownChildren).map((c) => renderRow(c, true))}
                              {restChildren > 0 && (
                                <div className="neox-sidebar__group-overflow neox-sidebar__sub-row">
                                  <button
                                    type="button"
                                    className="neox-sidebar__group-overflow-btn"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      const el = e.currentTarget;
                                      ctx.showMoreChildren(s.id, children.length);
                                      ctx.keepInView(el);
                                    }}
                                    title={isZh ? `还有 ${restChildren} 个子任务` : `${restChildren} more sub-agents`}
                                  >
                                    {isZh ? `显示更多子任务 (${restChildren})` : `Show more (${restChildren})`}
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })()}
                    </React.Fragment>
                  );
                })}
                {(overflow > 0 || expanded) && (
                  /* 展开后两个入口并排 —— 多铺了一页就能原地收回去 */
                  <div className="neox-sidebar__group-overflow">
                    {overflow > 0 && (
                      <button
                        type="button"
                        className="neox-sidebar__group-overflow-btn"
                        onClick={(e) => { const el = e.currentTarget; ctx.showMoreInGroup(g.path, topLevel.length); ctx.keepInView(el); }}
                        title={isZh ? `还有 ${overflow} 条会话` : `${overflow} more chats`}
                      >
                        {isZh ? `显示更多 (${overflow})` : `Show more (${overflow})`}
                      </button>
                    )}
                    {expanded && (
                      <button
                        type="button"
                        className="neox-sidebar__group-overflow-btn"
                        onClick={(e) => { const el = e.currentTarget; ctx.collapseGroup(g.path); ctx.keepInView(el); }}
                        title={isZh ? '收起多余会话' : 'Collapse extra chats'}
                      >
                        {isZh ? '收起' : 'Collapse'}
                      </button>
                    )}
                  </div>
                )}
              </>
            );
          })()}
        </div>
      </li>
    </>
  );
}

/* g 按内容比: groups 在 data 刷新时整体重算, 对象身份每次都新, 但组里的会话对象大多不变 */
function sameGroup(a: SessionGroupLike, b: SessionGroupLike): boolean {
  if (a === b) return true;
  if (a.path !== b.path || a.name !== b.name || a.isActive !== b.isActive || a.isTimeBucket !== b.isTimeBucket || a.spaceMode !== b.spaceMode) return false;
  if (a.sessions.length !== b.sessions.length) return false;
  for (let i = 0; i < a.sessions.length; i++) if (a.sessions[i] !== b.sessions[i]) return false;
  return true;
}

export const SidebarGroupBlock = React.memo(SidebarGroupBlockImpl, (prev, next) => {
  for (const k of Object.keys(next) as Array<keyof Props>) {
    if (k === 'g') { if (!sameGroup(prev.g, next.g)) return false; continue; }
    if (prev[k] !== next[k]) return false;
  }
  return true;
});

export default SidebarGroupBlock;
