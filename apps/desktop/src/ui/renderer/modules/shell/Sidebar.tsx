import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { copyToClipboard } from '../../utils/copyToClipboard';
import { useAgentModeVariant } from '../../hooks/useAgentModeVariant';
import { SidebarAccountFooter } from './SidebarAccountFooter';
/* 侧栏工具方块的陶土图标 (UI 2.0, 跟手机端 assets/clay 同一套) */
import './sidebar-clay.css';
import './shell-motion.css';
import { SidebarToolDock, type DockTool } from './SidebarToolDock';
import { SESSION_MIME } from './sidebarDockActions';
import clayNewchatArt from '../../media/clay/newchat-art.webp';
import { SidebarWorkbench, WorkbenchHead, SidebarSearchBar, ImageModeHead, type ListMode, type HeadMoreProps, type WorkbenchProject, type WorkProjectsProps } from './SidebarWorkbench';
import { createWorkProject, projectOfTask, setWorkProjectFilter, useWorkProjectFilter, useWorkProjects, type WorkProject } from './workProjects';
import { useCodeWorkspaces, workspaceOf } from './codeWorkspaces';
import { useAppStore } from '../../../state/appStore';
import { SessionOverview } from './SessionOverview';
import { SidebarGroupBlock, type GroupCtx } from './SidebarGroupBlock';

const EMPTY_IDS: ReadonlySet<string> = new Set();
import {
  IconPlus,
  IconFilter,
  IconTrash,
  IconPencil,
  IconChat,
  IconCollapseAll,
  IconFolder,
  IconLayers,
  IconCopy,
  IconCloudUp,
  IconCloudDown,
  IconExport,
} from './shellIcons';
import { UiSlot } from './uiSlots';
import { isTeamEnabled, teamUnavailableReason } from '../../pages/team/teamAvailability';
import { confirmAsync } from '../../components/confirmEvents';
import { ContextMenu, type ContextMenuItem } from '../../components/ContextMenu';
import { ProjectPicker } from './ProjectPicker';
import { dispatchHint } from '../../components/notifyEvents';
import { useI18n } from '../../hooks/useI18n';
import { workspaceKey, sameWorkspace } from '../../utils/pathUtils';
import { useCloudAgentAvailable } from './editionHooks';
import { formatRelativeTime } from '../../utils/formatRelativeTime';
import { kbd } from '../../utils/keymap';
import { NeoxIllus } from '../../media/illus';
import { revealInFileManagerLabel } from '../../utils/fileManagerLabels';
import { displayWorkspaceName } from '../../utils/modeHomeName';
import { showFeatureIntro } from '../../components/featureIntro/FeatureIntro';
import { DotSpinner } from '../../components/DotSpinner';

export type SessionStatus = 'active' | 'done' | 'warn';

export interface SessionItem {
  id: string;
  title: string;
  subtitle?: string;             /* 二级描述 (真实侧目前用作 messageCount/tokens 元信息) */
  statusText?: string;           /* 历史保留 — Sidebar 现在按 activeSessionId+streaming 自己算, 不依赖此字段 */
  status?: SessionStatus;
  timeText?: string;             /* 显示用: "14:28" / "昨天" / "3 天" / "5 月" / "2 年" */
  ts?: number;
  /** session 所属工作区路径,用于多项目分组. 缺失则归到"未关联"组 */
  workspacePath?: string;
  /** Work 任务文件夹 (见 shared Session.taskDir) */
  taskDir?: string | null;
  /** session 跑在哪里 — 真相源是 control-plane cloud_agent_sessions.migration_state.
   *   undefined / 'local' = 本机普通 session.
   *   'cloud' = 在云端跑 (mobile 创的 / desktop 推过去的).
   *   'migrating' = desktop → cloud 迁移中 (UI 禁点).
   *   'syncing-back' = cloud → desktop 拉回中 (UI 禁点). */
  cloudLocation?: 'local' | 'cloud' | 'migrating' | 'syncing-back';
  /** 仅 cloud-only session (本机没本地副本) — 标 true 时 row 半透明, 提示"在云端 only" */
  cloudOnly?: boolean;
  /** 消息数 — Sidebar 在 row 渲染时跟 active/streaming 一起算 statusText. 0=空会话. */
  messageCount?: number;
  /** sub-agent 子会话 — 指向发起它的主 session id, Sidebar 据此把它嵌在父下渲染 */
  parentSessionId?: string | null;
  agentMode?: 'work' | 'code' | 'pilot' | null;
  effectiveMode?: 'work' | 'code' | 'pilot';
  /** 会话种类 — 'image' 图片会话显图标 + 点击路由到图片页; 缺省 'chat'. */
  kind?: 'chat' | 'image';
}

interface WorkspaceRef {
  path: string;
  name: string;
  roots?: string[];
}

interface SidebarProps {
  motion?: 'closed' | 'opening' | 'open' | 'closing';
  sessions?: SessionItem[];
  /** 首次会话加载是否仍 inflight. true 时 group 内不显示"暂无对话"空状态, 而是显示
   *  几行骨架 pulse, 等数据到 (或失败 finally) 再切真实状态. 后续 refresh 不算 loading,
   *  避免每次刷新都闪骨架. */
  sessionsLoading?: boolean;
  activeSessionId?: string | null;
  /** active session 当前是否在 streaming. SessionRow 据此决定显 "进行中" + 流式高亮.
   *  从 NeoxShellHost runtime.streaming 透传, **不打进 SessionItem** — 避免 sessionItems
   *  每次 streaming chunk 都重算引发整列 reconcile. */
  streaming?: boolean;
  /** per-session 运行态 — 支持"切走的 session 也在侧栏显示转圈".
   *  跟 streaming 同源 (streamingBySessionRef 镜像). SessionRow 用 runningSessionIds.has(id)
   *  单独判定, 与 activeSessionId 无关. */
  runningSessionIds?: ReadonlySet<string>;
  onNewSession?: () => void;
  /** "+ 新建任务 ▼" caret 弹菜单点 "云端" — 新建 cloud session. undefined 时 caret 不渲染. */
  onNewCloudSession?: () => void;
  /** @deprecated 侧栏搜索已改为插件入口；搜索走顶栏 / ⌘K */
  onSearch?: () => void;
  /** 打开插件管理页 */
  onOpenPlugins?: () => void;
  onOpenTools?: () => void;
  onOpenSettings?: () => void;
  onSelectSession?: (id: string) => void;
  onRenameSession?: (id: string, name: string) => void;
  onDeleteSession?: (id: string) => void;
  onExportSession?: (id: string) => void;
  /** "推到云端继续" — local session 才出现, 已 cloud 不出现 */
  onPushSessionToCloud?: (id: string) => void;
  /** "拉回本机" — cloud_active 时出现 */
  onPullSessionToLocal?: (id: string) => void;
  /** 当前生效模式 (Work / Code 会话池严格隔离, 列表已由 host 过滤) */
  currentAgentMode?: 'work' | 'code' | 'pilot';
  /** 右键"移动到文件夹…" (仅 Code 会话) — 只改会话 workspacePath 标签 */
  onMoveSessionToWorkspace?: (id: string, target: { path: string }) => void;
  modeHomes?: { work?: string; pilot?: string };
  /** 当前打开的工作区(用于"当前项目"高亮 + 默认展开 + 新建对话归属) */
  currentWorkspace?: WorkspaceRef;
  /** 最近工作区列表(用于解析 path → name + 让空 group 也可见) */
  recentWorkspaces?: WorkspaceRef[];
  /** 点击 "+ 文件夹" — 添加/打开新工作区 */
  onAddWorkspace?: () => void;
  /** 点击其他 group 内 session — 切换到那个工作区 */
  onSelectWorkspace?: (path: string, opts?: { silent?: boolean }) => void;
  /** 从侧栏 recent 列表移除一个工作区 (不删除磁盘文件) */
  onRemoveWorkspace?: (path: string) => void;
  /** 重命名工作区（改显示名，不改文件夹） */
  onRenameWorkspace?: (path: string, newName: string) => void;
  /** 打开工作区设置面板（切换到 workspace rail） */
  /** 打开工作区面板。带 path = 编辑那个工作区 (不切换过去); 不带 = 当前工作区 */
  onShowWorkspacePanel?: (workspacePath?: string) => void;
  /** 在指定工作区下创建一条新会话(若非当前则先切换). 不传时回退到 onNewSession (只能在当前工作区建) */
  onCreateSessionInWorkspace?: (path: string) => void;
  /** 点击底部"管理项目" — 回首页/工作区管理 */
  onManageWorkspaces?: () => void;
  /** 打开独立知识库页面 */
  onOpenKnowledgeBase?: () => void;
  onOpenLibrary?: () => void;
  onOpenImageStudio?: () => void;
  /** 切到文件管理器视图 (左栏整体换成工作区文件树) — 不传则不显示入口按钮 */
  onOpenFileExplorer?: () => void;
  onNewImageSession?: () => void;
  onOpenTeam?: () => void;
  /** 顶部常用入口的选中态 */
  activeUtility?: 'knowledge' | 'library' | 'image' | 'team' | 'plugins' | 'skills' | 'mcp' | null;
  onOpenSkills?: () => void;
  onOpenMcp?: () => void;
}

interface SessionGroup {
  path: string;
  name: string;
  sessions: SessionItem[];
  isActive: boolean;
  /** 用于排序非 active 组 */
  latestActivity: number;
  isTimeBucket?: boolean;
  spaceMode?: 'work';
}

const mkModeIcon = (paths: React.ReactNode, size: number, strokeWidth = 1.2) => (
  <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {paths}
  </svg>
);
/* 工作 = briefcase: 圆角箱体 + 提手 + 搭扣横线 */
const BRIEFCASE_PATHS = (
  <>
    <rect x="2.2" y="5" width="11.6" height="8.3" rx="1.4" />
    <path d="M5.8 5V4a1.5 1.5 0 0 1 1.5-1.5h1.4A1.5 1.5 0 0 1 10.2 4v1" />
    <path d="M2.2 8.4h11.6" />
  </>
);

const SPACE_META: Record<'work', { icon: React.ReactNode; zh: string; en: string }> = {
  work: { icon: mkModeIcon(BRIEFCASE_PATHS, 16), zh: '工作', en: 'Work' },
};

const SEG_HOME_PATHS = (
  <>
    <path d="M2.6 7.4 8 3l5.4 4.4" />
    <path d="M4.2 6.6V12a1 1 0 0 0 1 1h5.6a1 1 0 0 0 1-1V6.6" />
  </>
);
const SEG_IMAGE_PATHS = (
  <>
    <rect x="2" y="3" width="12" height="10" rx="1.2" />
    <circle cx="5.6" cy="6.4" r="1" />
    <path d="M3 11.6 6.6 8.4l2.4 2 4-3.4" />
  </>
);
type SidebarSeg = 'spaces' | 'projects' | 'images';
/* 项目段用 IconFolder (闭环 folder 描边) — 与组行 folder 同一套, 避免 16-viewBox 扁 path 和 24-viewBox 视觉大小不一. */
const SIDEBAR_SEGMENTS: Array<{ id: SidebarSeg; zh: string; en: string; icon: React.ReactNode }> = [
  { id: 'spaces', zh: '空间', en: 'Spaces', icon: mkModeIcon(SEG_HOME_PATHS, 16) },
  { id: 'projects', zh: '项目', en: 'Projects', icon: <IconFolder size={16} strokeWidth={1.5} /> },
  { id: 'images', zh: '图片', en: 'Images', icon: mkModeIcon(SEG_IMAGE_PATHS, 16) },
];
const SIDEBAR_TAB_KEY = 'neox-sidebar-tab-v1';
function loadSidebarTab(): SidebarSeg {
  try {
    const v = window.localStorage.getItem(SIDEBAR_TAB_KEY);
    return v === 'spaces' || v === 'images' ? v : 'projects'; /* 默认「项目」 */
  } catch {
    return 'projects';
  }
}

function bucketByTime(
  sessions: SessionItem[],
  isZh: boolean,
  now: number = Date.now(),
): SessionGroup[] {
  const startOfToday = (() => {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  })();
  const startOfYesterday = startOfToday - 24 * 3600 * 1000;
  const startOfWeek = (() => {
    /* 周一起算 (中/西风俗对齐 Cursor/ChatGPT) */
    const d = new Date(startOfToday);
    const dow = d.getDay(); /* 0=Sun */
    const back = (dow + 6) % 7; /* Mon=0 */
    d.setDate(d.getDate() - back);
    return d.getTime();
  })();
  const startOfMonth = (() => {
    const d = new Date(now);
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  })();
  type BucketKey = 'today' | 'yesterday' | 'week' | 'month' | 'earlier';
  const buckets: Record<BucketKey, SessionItem[]> = {
    today: [], yesterday: [], week: [], month: [], earlier: [],
  };
  for (const s of sessions) {
    const ts = s.ts || 0;
    let key: BucketKey;
    if (ts >= startOfToday) key = 'today';
    else if (ts >= startOfYesterday) key = 'yesterday';
    else if (ts >= startOfWeek) key = 'week';
    else if (ts >= startOfMonth) key = 'month';
    else key = 'earlier';
    buckets[key].push(s);
  }
  const nameMap: Record<BucketKey, string> = {
    today:     isZh ? '今天'   : 'Today',
    yesterday: isZh ? '昨天'   : 'Yesterday',
    week:      isZh ? '本周'   : 'This week',
    month:     isZh ? '本月'   : 'This month',
    earlier:   isZh ? '更早'   : 'Earlier',
  };
  const order: BucketKey[] = ['today', 'yesterday', 'week', 'month', 'earlier'];
  const result: SessionGroup[] = [];
  for (let i = 0; i < order.length; i++) {
    const k = order[i];
    const list = buckets[k];
    if (list.length === 0) continue;
    list.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    result.push({
      path: `__time__${k}`,
      name: nameMap[k],
      sessions: list,
      isActive: k === 'today',
      latestActivity: -i, /* 越靠前时间越新 (result push 顺序已保证, 这个字段不参与排序) */
      isTimeBucket: true,
    });
  }
  return result;
}

const COLLAPSE_STORAGE_KEY = 'neox-sidebar-project-collapsed-v1';

function loadCollapsed(): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(COLLAPSE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveCollapsed(state: Record<string, boolean>) {
  try {
    window.localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify(state));
  } catch { /* ignore */ }
}

function basenameOf(path: string): string {
  if (!path) return '';
  const segs = path.split(/[\\/]/).filter(Boolean);
  return segs[segs.length - 1] || path;
}

/* 每组默认显示上限 — 超过这个数量收起,点"显示更多 (N)"展开全组. 跟 IDE 侧"Recently Opened"那个 4 的语义一致, 这边偏长留 5. */
const GROUP_COLLAPSE_LIMIT = 5;
/* 点一次「显示更多」多铺几条 — 不是全铺. 一页约 20 行 ≈ 600px, 「收起」仍在一屏内够得着. */
const GROUP_PAGE_STEP = 20;
/* 子会话(sub-agent)默认显示几条 — 长跑会挂出成百上千个子 agent, 全铺会把列表撑爆. */
const CHILD_COLLAPSE_LIMIT = 8;

/* Sidebar view + pin/archive/workspace-order 持久化 → ./sidebarPersist */
import {
  type SessionView, VIEW_LABELS, SB_PINNED_KEY, SB_ARCHIVED_KEY, SB_SEEN_IMAGE_KEY,
  SETTINGS_INITIAL_TAB_KEY, loadIdSet, saveIdSet, loadWsOrder, saveWsOrder,
} from './sidebarPersist';

/* ============================================================
 * Sidebar 显示顺序 "rank" 缓存 — *模块顶层* (跨 Sidebar 实例 + 跨 NeoxShellHost
 * remount 持久).
 *
 *   设计变迁:
 *     v1 (useRef): rankCacheRef 是 component-instance 级, AppShell 用
 *       key={workspace.path} 强制 NeoxShellHost remount → Sidebar 也 remount →
 *       rankCacheRef = new Map() 重新建, 顺序按当前 ts 重算, 用户感到 "刷新一次"
 *     v2 (模块顶层 — 本): 单 Map<string, number>, 跨 remount 保留. 切 workspace
 *       后新 Sidebar 实例直接用旧 rank, 顺序立刻稳定不抖.
 *
 *   GC: groups memo 每次跑都用 alive set sweep 一次, 防长生命周期累积无限.
 *     用户跨 workspace 切换可能同一 sessionId 不会 alive (workspace 隔离), 那条
 *     entry 在新 workspace 的 sidebar 渲染时会被清掉, 不留 stale rank.
 * ============================================================ */
const sessionRankCache = new Map<string, number>();

const workspaceOrderRank = new Map<string, number>();
let workspaceOrderCounter = 0;
function ensureWorkspaceOrderRank(path: string): number {
  const existing = workspaceOrderRank.get(path);
  if (existing !== undefined) return existing;
  const rank = ++workspaceOrderCounter;
  workspaceOrderRank.set(path, rank);
  return rank;
}

/* useEvent — 稳定 callback ref. Sidebar 内大量闭包 callback 每次 render 都是新 ref,
 *   传给 SessionRow 会让 React.memo 浅比失效, 整列重 render. 这里把 callback 存 ref,
 *   暴露稳定 wrapper (函数 identity 不变, 内部调最新 callback).
 *   等价 React RFC useEvent (实验中); 自己实现避免依赖 react@experimental. */
function useEvent<T extends (...args: any[]) => any>(fn: T): T {
  const ref = useRef<T>(fn);
  useEffect(() => { ref.current = fn; });
  return useCallback(((...args: Parameters<T>) => ref.current(...args)) as T, []);
}

/* ============================================================
 * SessionRow — 单条会话行, React.memo 化避免切 active / 30s cloud poll 时
 *   全列表 reconcile. props 全部 stable: callbacks 经 useEvent 包, 标志位 boolean
 *   或字符串 — memo 浅比 skip 非变更行.
 *
 *   设计:
 *     · 渲染时按 isActive/isStreaming/isArchived/isEditing 自己组 className 跟 status
 *     · 不接收 group 整对象 — 只接 groupPath + groupIsActive (两个稳定值)
 *     · editValue + onEditChange 只在 editing row 上变, 其他 row props 浅比都相等
 * ============================================================ */
interface SessionRowProps {
  session: SessionItem;
  groupPath: string;
  groupIsActive: boolean;
  isActive: boolean;
  isStreaming: boolean;
  isArchived: boolean;
  isEditing: boolean;
  editValue: string;
  showDelete: boolean;
  onClick: (groupPath: string, groupIsActive: boolean, id: string) => void;
  onContextMenu: (e: React.MouseEvent, id: string) => void;
  onEditChange: (v: string) => void;
  onCommitEdit: (id: string) => void;
  onCancelEdit: () => void;
  onToggleArchive: (id: string) => void;
  onDeleteRequested: (id: string, title: string) => void;
  isZh: boolean;
  plain?: boolean;
}

function plainTimeText(ts: number | undefined, fallback: string | undefined, isZh: boolean): string {
  if (!ts) return fallback ?? '';
  const diff = Math.max(0, Date.now() - ts);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return isZh ? '刚刚' : 'now';
  if (min < 60) return isZh ? `${min} 分钟` : `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return isZh ? `${hr} 小时` : `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day === 1) return isZh ? '昨天' : 'yesterday';
  if (day < 7) return isZh ? `${day} 天前` : `${day}d`;
  const d = new Date(ts);
  return isZh
    ? `${d.getMonth() + 1}月${d.getDate()}日`
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/* 会话类型图标 —— 单色线标, 靠形状区分.
 * 盒宽/16px/stroke 1.5 对齐 group IconFolder, 整列 icon 起 X / 中心 X 一致. */
const SessionTypeIcon: React.FC<{ kind?: 'chat' | 'image'; agentMode?: 'work' | 'code' | 'pilot' | null; plain?: boolean; zh?: boolean; noWorkspace?: boolean }> = ({ kind, agentMode, plain, zh, noWorkspace }) => {
  let title = ''; let node: React.ReactNode = null;
  if (kind === 'image') {
    title = zh ? '图片会话' : 'Image';
    node = <><rect x="3" y="3" width="18" height="18" rx="3.5" /><circle cx="8.5" cy="8.5" r="1.7" /><path d="M21 15.5 16 10.5 5 21" /></>;
  } else if (plain) {
    return null; /* Work 池全是工作会话, 每行一个公文包是噪音 */
  } else if (agentMode === 'work') {
    title = 'Work'; /* 公文包 */
    node = <><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></>;
  } else if (noWorkspace) {
    title = zh ? '对话' : 'Chat';
    node = <path d="M20 12.5a7.5 7.5 0 0 1-11 6.6L4 20.5l1.4-4.6A7.5 7.5 0 1 1 20 12.5Z" />;
  } else {
    title = 'Code';
    node = <><path d="m8 8-4 4 4 4" /><path d="m16 8 4 4-4 4" /><path d="m13.5 5-3 14" /></>;
  }
  return (
    <span
      className="neox-session-item__type-icon"
      aria-hidden="true"
      title={title}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">{node}</svg>
    </span>
  );
};

const SessionRow = React.memo<SessionRowProps>(function SessionRow({
  session: s,
  groupPath,
  groupIsActive,
  isActive,
  isStreaming,
  isArchived,
  isEditing,
  editValue,
  showDelete,
  onClick,
  onContextMenu,
  onEditChange,
  onCommitEdit,
  onCancelEdit,
  onToggleArchive,
  onDeleteRequested,
  isZh,
  plain = false,
}) {
  const busy = s.cloudLocation === 'migrating' || s.cloudLocation === 'syncing-back';
  return (
    <div
      data-session-id={s.id}
      className={`neox-session-item neox-session-item--in-group${isActive ? ' is-active' : ''}${s.cloudOnly ? ' is-cloud-only' : ''}${busy ? ' is-cloud-busy' : ''}${isStreaming ? ' is-streaming' : ''}`}
      onClick={() => {
        if (isEditing) return;
        if (busy) return;
        onClick(groupPath, groupIsActive, s.id);
      }}
      onContextMenu={(e) => onContextMenu(e, s.id)}
      /* 会话能拖到底部工具托盘上 (拖到知识库 = 存成知识), 见 sidebarDockActions.ts */
      draggable={!isEditing && !busy}
      onDragStart={(e) => { e.dataTransfer.setData(SESSION_MIME, s.id); e.dataTransfer.effectAllowed = 'copy'; }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (isEditing) return;
        if (e.key === 'Enter' || e.key === ' ') onClick(groupPath, groupIsActive, s.id);
      }}
    >
      <span className="neox-session-item__info">
        {isEditing ? (
          <input
            autoFocus
            className="neox-session-item__rename"
            value={editValue}
            onChange={(e) => onEditChange(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') onCommitEdit(s.id);
              if (e.key === 'Escape') onCancelEdit();
            }}
            onBlur={() => onCommitEdit(s.id)}
          />
        ) : (
          <>
            {isStreaming ? (
              <span className="neox-session-item__type-icon neox-session-item__dots" aria-hidden>
                <DotSpinner size={12} />
              </span>
            ) : (
              /* 会话类型图标 — 按 kind/mode 显精致 line icon, 垂直居中对齐 (替掉 low 的 3px 圆点).
               * image=图片 / work=公文包 / code=代码. Work 池非图片会话保持干净不显. */
              <SessionTypeIcon kind={s.kind} agentMode={s.agentMode} plain={plain} zh={isZh} noWorkspace={!s.workspacePath} />
            )}
            <span className="neox-session-item__title" title={s.title || undefined}>{s.title}</span>
            <UiSlot name="sidebar.session.badge" props={{ location: s.cloudLocation }} />
          </>
        )}
      </span>
      {!isEditing && (
        <span className="neox-session-item__right">
          <span
            className="neox-session-item__time"
            title={s.ts ? new Date(s.ts).toLocaleString(isZh ? 'zh-CN' : 'en-US', {
              year: 'numeric', month: 'numeric', day: 'numeric',
              hour: '2-digit', minute: '2-digit', hour12: !isZh,
            }) : undefined}
          >
            {plain
              ? plainTimeText(s.ts, s.timeText, isZh)
              : (s.ts ? formatRelativeTime(s.ts, isZh ? 'zh' : 'en') : (s.timeText ?? ''))}
          </span>
          <span className="neox-session-item__actions">
            <button
              type="button"
              className={`neox-session-item__act neox-session-item__act--arch${isArchived ? ' is-archived' : ''}`}
              onClick={(e) => { e.stopPropagation(); onToggleArchive(s.id); }}
              title={isArchived ? (isZh ? '取消归档 (恢复到最近)' : 'Unarchive (restore to Recent)') : (isZh ? '归档' : 'Archive')}
              aria-label={isArchived ? (isZh ? '取消归档' : 'Unarchive') : (isZh ? '归档' : 'Archive')}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill={isArchived ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2.34" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="2" y="3" width="20" height="5" rx="1" />
                <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
                <path d="M10 12h4" />
              </svg>
            </button>
            {showDelete && (
              <button
                type="button"
                className="neox-session-item__act neox-session-item__act--del"
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  onDeleteRequested(s.id, s.title);
                }}
                title={isZh ? "删除会话" : "Delete chat"}
                aria-label={isZh ? "删除会话" : "Delete chat"}
              >
                <IconTrash size={12} />
              </button>
            )}
          </span>
        </span>
      )}
    </div>
  );
});

/* ============================================================
 * Sidebar — 多工作区分组
 *   · 顶部 CTA: "+ 新建任务" (在当前工作区下创建)
 *   · 搜索 ⌘K
 *   · subhead: "最近任务" + "+ 文件夹" + filter
 *   · 主区: 按 workspacePath 分组的可折叠列表; active 工作区永远在顶, 默认展开
 *   · 跨工作区点击 session = 切换到那个工作区(避免错读上下文)
 *   · 折叠状态 localStorage 持久化
 *   · 底部: 「全部项目」打开工作区列表面板 (不再甩到 Welcome 登录墙)
 * ============================================================ */
const SidebarImpl: React.FC<SidebarProps> = ({
  motion,
  sessions,
  sessionsLoading = false,
  activeSessionId,
  streaming = false,
  runningSessionIds,
  onNewSession,
  onOpenPlugins,
  onOpenTools,
  onOpenSettings,
  onSelectSession,
  onRenameSession,
  onDeleteSession,
  onExportSession,
  onPushSessionToCloud,
  onPullSessionToLocal,
  currentAgentMode,
  onMoveSessionToWorkspace,
  modeHomes,
  currentWorkspace,
  recentWorkspaces,
  onAddWorkspace,
  onSelectWorkspace,
  onRemoveWorkspace,
  onRenameWorkspace,
  onShowWorkspacePanel,
  onCreateSessionInWorkspace,
  onManageWorkspaces,
  onOpenKnowledgeBase,
  onSearch,
  onOpenLibrary,
  onOpenImageStudio,
  onNewImageSession,
  onOpenTeam,
  activeUtility,
  onOpenFileExplorer,
  onOpenSkills,
  onOpenMcp,
}) => {
  const { isZh } = useI18n();
  /* 云端运行是否对本账号开放 —— 右键菜单的「推到云端继续」跟着它显隐 (见下方注释) */
  const cloudAgentAvailable = useCloudAgentAvailable();
  const viewLabels = isZh ? VIEW_LABELS.zh : VIEW_LABELS.en;
  const data: SessionItem[] = sessions ?? [];
  const openSettingsTab = useCallback((tab: 'mcp' | 'skills' | 'memory' | 'general') => {
    try { localStorage.setItem(SETTINGS_INITIAL_TAB_KEY, tab); } catch { /* ignore */ }
    if (onOpenSettings) {
      onOpenSettings();
      return;
    }
    dispatchHint(isZh ? '请从设置页打开该功能' : 'Open this feature from Settings', 'info');
  }, [isZh, onOpenSettings]);

  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [wsEditingPath, setWsEditingPath] = useState<string | null>(null);
  const [wsEditValue, setWsEditValue] = useState('');
  const commitWsRename = () => {
    if (wsEditingPath && wsEditValue.trim() && onRenameWorkspace) {
      onRenameWorkspace(wsEditingPath, wsEditValue.trim());
    }
    setWsEditingPath(null);
  };

  const [contextMenu, setContextMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [wsContextMenu, setWsContextMenu] = useState<{ path: string; name: string; isActive: boolean; x: number; y: number } | null>(null);
  const [newchatMenu, setNewchatMenu] = useState<DOMRect | null>(null);
  /* 「项目 · 分支」行: 换项目的弹层 + 当前分支 (切窗口回来时重读, 外面 checkout 过也跟得上) */
  const [projMenu, setProjMenu] = useState<DOMRect | null>(null);
  const [projBranch, setProjBranch] = useState<string | null>(null);
  useEffect(() => {
    const p = currentWorkspace?.path;
    if (!p) { setProjBranch(null); return; }
    let dead = false;
    const read = () => {
      const fn = (window.neox as unknown as { gitCurrentBranch?: (p: string) => Promise<string | null> }).gitCurrentBranch;
      void fn?.(p).then((b) => { if (!dead) setProjBranch(b || null); }).catch(() => { if (!dead) setProjBranch(null); });
    };
    read();
    window.addEventListener('focus', read);
    return () => { dead = true; window.removeEventListener('focus', read); };
  }, [currentWorkspace?.path]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  /* 删除走全局 confirmAsync — 跟 AppShell 顶层的 ConfirmDialogHost 同一条路径,
   * 早期版本用 inline pendingDelete + 内嵌 ConfirmDialog 在某些环境下 dialog 不出来. */
  /* 删除缓冲窗 —— 确认后不立刻删, 先从列表隐藏并给 UNDO_MS 的撤销窗口.
   *   会话删除是硬删 + CASCADE (messages / timeline_entries 一起没), 手滑点错相邻一行
   *   就是永久丢失。加软删除要改所有查询, 这里用"延迟执行"拿到同样的用户价值而零 schema 改动。
   *   窗口内应用被关掉 → 真删压根没发生, 会话还在 —— fail-safe 方向是对的。 */
  const UNDO_MS = 8000;
  const [pendingDelete, setPendingDelete] = useState<{ id: string; title: string } | null>(null);
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /* pendingDelete 的同步镜像 —— unmount cleanup (deps=[]) 闭包里读不到最新 state,
   * 且 setState 提交是异步的, 卸载瞬间必须能同步读到真实的待删状态。
   * 每个改 pendingDelete 的地方都同步改这个 ref, ref 是"当前是否有待删"的即时事实源。 */
  const pendingDeleteRef = useRef<{ id: string; title: string } | null>(null);
  const onDeleteSessionRef = useRef(onDeleteSession);
  useEffect(() => { onDeleteSessionRef.current = onDeleteSession; }, [onDeleteSession]);

  const undoPendingDelete = useCallback(() => {
    if (pendingTimerRef.current) { clearTimeout(pendingTimerRef.current); pendingTimerRef.current = null; }
    pendingDeleteRef.current = null;
    setPendingDelete(null);
  }, []);

  useEffect(() => () => {
    if (pendingTimerRef.current) { clearTimeout(pendingTimerRef.current); pendingTimerRef.current = null; }
    const cur = pendingDeleteRef.current;
    if (cur && onDeleteSessionRef.current) {
      pendingDeleteRef.current = null;
      onDeleteSessionRef.current(cur.id);
    }
  }, []);

  const requestDeleteSession = useCallback(async (id: string, title: string) => {
    if (!onDeleteSession) return;
    const ok = await confirmAsync({
      title: isZh ? '删除会话' : 'Delete chat',
      message: isZh ? (<>确定删除会话 <strong>"{title}"</strong> 吗?</>) : (<>Delete chat <strong>"{title}"</strong>?</>),
      description: isZh
        ? '该会话所有消息和工具调用记录都会被清除。删除后有几秒可以撤销。'
        : 'All messages and tool call history in this chat will be removed. You will have a few seconds to undo.',
      variant: 'danger',
      confirmLabel: isZh ? '删除' : 'Delete',
      cancelLabel: isZh ? '取消' : 'Cancel',
    });
    if (!ok) return;
    /* 已经有一个在等 → 先把那个真删掉, 再排新的 (一次只维护一个撤销窗, 语义清楚)。
     * 真删/排队都以 pendingDeleteRef 为准并同步维护, 不在 setState updater 里做副作用
     * (updater 在 StrictMode 下会双跑, 且 unmount cleanup 读不到 state)。 */
    if (pendingTimerRef.current) { clearTimeout(pendingTimerRef.current); pendingTimerRef.current = null; }
    const prev = pendingDeleteRef.current;
    if (prev && onDeleteSession) onDeleteSession(prev.id);
    pendingDeleteRef.current = { id, title };
    setPendingDelete({ id, title });
    pendingTimerRef.current = setTimeout(() => {
      pendingTimerRef.current = null;
      const cur = pendingDeleteRef.current;
      pendingDeleteRef.current = null;
      if (cur && onDeleteSession) onDeleteSession(cur.id);
      setPendingDelete(null);
    }, UNDO_MS);
  }, [onDeleteSession, isZh]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => loadCollapsed());

  /* view: 最近 / 收藏 / 归档. dropdown 切. pin/archive 标记 localStorage 自管, 后端 schema 还没. */
  const [view, setView] = useState<SessionView>('recent');
  /* 会话怎么摆: 工作台 (SidebarWorkbench, 只摆手上的活) / 列表 (按项目文件夹, 原来的)。
   * 找旧会话走全景 (SessionOverview, ⌘E)。只是这台机器的偏好。 */
  /* 工具托盘弹层 (UI 3.0) —— 点外面 / 点了某个工具就收起 */
  const [toolsOpen, setToolsOpen] = useState(false);
  const toolsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!toolsOpen) return undefined;
    const onDown = (e: MouseEvent) => {
      const el = toolsRef.current;
      if (!el) return;
      const t = e.target as Node;
      if (!el.contains(t)) { setToolsOpen(false); return; }
      if ((t as HTMLElement).closest?.('.neox-sidebar__tool')) setTimeout(() => setToolsOpen(false), 0);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setToolsOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [toolsOpen]);
  const [listMode, setListModeState] = useState<ListMode>(() => {
    try { return localStorage.getItem('neox.sidebar.listMode.v2') === 'folders' ? 'folders' : 'workbench'; } catch { return 'workbench'; }
  });
  const setListMode = (m: ListMode) => {
    setListModeState(m);
    try { localStorage.setItem('neox.sidebar.listMode.v2', m); } catch { /* ignore */ }
  };
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [filesFor, setFilesFor] = useState<string | null>(null); /* 哪个项目组正把会话换成文件树 */
  const [sessQuery, setSessQuery] = useState('');
  const closeSearch = () => { setSearchOpen(false); setSessQuery(''); };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || (k !== 'k' && k !== 'f')) return;
      if ((e.target as HTMLElement | null)?.closest?.('.monaco-editor, .xterm')) return;
      e.preventDefault();
      e.stopImmediatePropagation(); /* 截住宿主的 ⌘K 全局浮层 */
      setSearchOpen(true);
      window.setTimeout(() => document.querySelector<HTMLInputElement>('.neox-sb-search input')?.focus(), 0);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'e') return;
      if ((e.target as HTMLElement | null)?.closest?.('.monaco-editor, .xterm')) return; /* 编辑器 / 终端里的 ⌘E 留给它们 */
      e.preventDefault();
      setOverviewOpen((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [sessKind, setSessKind] = useState<'normal' | 'image'>('normal');
  const [kindMenuOpen, setKindMenuOpen] = useState(false);
  const [groupTab, setGroupTab] = useState<'spaces' | 'projects'>(() => (loadSidebarTab() === 'spaces' ? 'spaces' : 'projects'));
  const [seenImageIds, setSeenImageIds] = useState<Set<string>>(() => loadIdSet(SB_SEEN_IMAGE_KEY));
  const [pinnedSet, setPinnedSet] = useState<Set<string>>(() => loadIdSet(SB_PINNED_KEY));
  const [archivedSet, setArchivedSet] = useState<Set<string>>(() => loadIdSet(SB_ARCHIVED_KEY));
  /* workspace 自定义顺序 + 拖拽状态. user 拖动后落盘. */
  const [wsOrder, setWsOrder] = useState<string[]>(() => loadWsOrder());
  const [draggingPath, setDraggingPath] = useState<string | null>(null);
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);
  const [groupShowCount, setGroupShowCount] = useState<Map<string, number>>(() => new Map());
  const showMoreInGroup = useCallback((path: string, total: number) => {
    setGroupShowCount((prev) => {
      const next = new Map(prev);
      const cur = next.get(path) ?? GROUP_COLLAPSE_LIMIT;
      next.set(path, Math.min(total, cur + GROUP_PAGE_STEP));
      return next;
    });
  }, []);
  /* 点完把按钮自己拉回视野 — 新长出来的一页会把它往下推 ~700px, 不拉回来用户又得去找它.
   * 双 rAF: 第一帧等 React 把新行 commit 进 DOM, 第二帧布局已定再滚. */
  const keepInView = useCallback((el: HTMLElement) => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      el.scrollIntoView({ block: 'nearest' });
    }));
  }, []);
  const collapseGroup = useCallback((path: string) => {
    setGroupShowCount((prev) => {
      if (!prev.has(path)) return prev;
      const next = new Map(prev);
      next.delete(path);
      return next;
    });
  }, []);

  const [childShowCount, setChildShowCount] = useState<Map<string, number>>(() => new Map());
  const showMoreChildren = useCallback((parentId: string, total: number) => {
    setChildShowCount((prev) => {
      const next = new Map(prev);
      const cur = next.get(parentId) ?? CHILD_COLLAPSE_LIMIT;
      next.set(parentId, Math.min(total, cur + GROUP_PAGE_STEP));
      return next;
    });
  }, []);
  const [expandedChildrenSet, setExpandedChildrenSet] = useState<Set<string>>(() => new Set());
  /* 运行中的子会话会把父会话强制展开 (见 render 处注释)。这里把这份"强制"沉淀进
   * expandedChildrenSet —— 否则 run 一结束强制条件消失, 子会话列表在用户眼皮底下
   * 自动折回去, 行又开始动。用户要收起自己点, 不由完成事件代劳。 */
  useEffect(() => {
    if (!runningSessionIds?.size) return;
    const parentsWithRunningChild = new Set<string>();
    for (const s of data) {
      const pid = (s as { parentSessionId?: string | null }).parentSessionId;
      if (pid && runningSessionIds.has(s.id)) parentsWithRunningChild.add(pid);
    }
    if (!parentsWithRunningChild.size) return;
    setExpandedChildrenSet((prev) => {
      let changed = false;
      const next = new Set(prev);
      parentsWithRunningChild.forEach((id) => { if (!next.has(id)) { next.add(id); changed = true; } });
      return changed ? next : prev;
    });
  }, [data, runningSessionIds]);
  const toggleChildExpand = useCallback((sessionId: string) => {
    setExpandedChildrenSet((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId); else next.add(sessionId);
      return next;
    });
  }, []);

  /* rankOf — sidebar 显示顺序"冻结". 见模块顶层 sessionRankCache 注释.
   *   useRef wrap 单 cache map 让 hooks 规则满足, 实际 ref 指向模块级 Map (跨 remount 保留). */
  const rankCacheRef = useRef<Map<string, number>>(sessionRankCache);
  const rankOf = useCallback((id: string, ts: number | undefined): number => {
    const map = rankCacheRef.current;
    const cached = map.get(id);
    if (cached !== undefined) return cached;
    const v = ts ?? Date.now();
    map.set(id, v);
    return v;
  }, []);
  const togglePin = useCallback((id: string) => {
    setPinnedSet((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      saveIdSet(SB_PINNED_KEY, next);
      return next;
    });
  }, []);
  const toggleArchive = useCallback((id: string) => {
    setArchivedSet((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      saveIdSet(SB_ARCHIVED_KEY, next);
      return next;
    });
  }, []);
  /* 外面点击关 view 菜单 */
  useEffect(() => {
    if (!viewMenuOpen) return;
    const close = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      /* 顶部行 (含 filter 触发) 跟弹出菜单 都视为"菜单内" — 点这两块不关 */
      if (t.closest('.neox-sidebar__top')) return;
      if (t.closest('.neox-sidebar__view-menu')) return;
      setViewMenuOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setViewMenuOpen(false); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', esc);
    };
  }, [viewMenuOpen]);

  useEffect(() => {
    if (!projectMenuOpen) return;
    const close = () => setProjectMenuOpen(false);
    requestAnimationFrame(() => document.addEventListener('click', close));
    return () => document.removeEventListener('click', close);
  }, [projectMenuOpen]);

  useEffect(() => {
    if (!kindMenuOpen) return;
    const close = () => setKindMenuOpen(false);
    requestAnimationFrame(() => document.addEventListener('click', close));
    return () => document.removeEventListener('click', close);
  }, [kindMenuOpen]);

  useEffect(() => {
    saveCollapsed(collapsed);
  }, [collapsed]);

  /* 关掉右键菜单 (点外面 / Esc) */
  useEffect(() => {
    if (!contextMenu && !wsContextMenu) return;
    const closeOnClick = () => { setContextMenu(null); setWsContextMenu(null); };
    const closeOnEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') { setContextMenu(null); setWsContextMenu(null); } };
    window.addEventListener('click', closeOnClick);
    window.addEventListener('keydown', closeOnEsc);
    return () => {
      window.removeEventListener('click', closeOnClick);
      window.removeEventListener('keydown', closeOnEsc);
    };
  }, [contextMenu, wsContextMenu]);

  const [hiddenSessionIds, setHiddenSessionIds] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('neox.sidebar.hiddenSessions') || '[]') as string[]); } catch { return new Set(); }
  });
  const hideSessionIds = useCallback((ids: string[]) => {
    if (!ids.length) return;
    setHiddenSessionIds((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.add(id));
      try { localStorage.setItem('neox.sidebar.hiddenSessions', JSON.stringify([...next])); } catch { /* 持久化失败不阻塞 */ }
      return next;
    });
  }, []);

  const filtered = useMemo(() => {
    const base = data.filter((s) => {
      if (hiddenSessionIds.has(s.id)) return false; /* 用户从侧栏移除过 */
      if (pendingDelete?.id === s.id) return false; /* 删除缓冲窗内: 先从列表拿掉, 可撤销 */
      if (view === 'archived') return archivedSet.has(s.id);
      if (view === 'pinned')   return pinnedSet.has(s.id) && !archivedSet.has(s.id);
      /* recent: 排除已归档 */
      return !archivedSet.has(s.id);
    });
    const q = sessQuery.trim().toLowerCase();
    if (!q) return base;
    return base.filter((s) => s.title.toLowerCase().includes(q) || (s.workspacePath ?? '').split(/[\\/]/).pop()!.toLowerCase().includes(q));
  }, [data, view, pinnedSet, archivedSet, hiddenSessionIds, pendingDelete, sessQuery]);

  const modeVariant = useAgentModeVariant();

  const imageSessions = useMemo(() => {
    return data
      .filter((s) => s.kind === 'image' && !hiddenSessionIds.has(s.id) && pendingDelete?.id !== s.id)
      .slice()
      .sort((a, b) => rankOf(b.id, b.ts) - rankOf(a.id, a.ts));
  }, [data, hiddenSessionIds, rankOf, pendingDelete]);

  useEffect(() => {
    if (modeVariant.hideProjects && sessKind === 'image' && imageSessions.length === 0) setSessKind('normal');
  }, [sessKind, imageSessions.length, modeVariant.hideProjects]);

  /* 首次运行 (localStorage 无 seen 记录) → 把当前已有图片会话全标记 seen, 角标从 0 起,
   *   只有之后新增的才算"新". 否则老用户一升级就看到一个大数字, 是噪音. */
  const seenSeededRef = useRef(false);
  useEffect(() => {
    if (seenSeededRef.current) return;
    if (localStorage.getItem(SB_SEEN_IMAGE_KEY) != null) { seenSeededRef.current = true; return; }
    if (imageSessions.length === 0) return; /* 等 data 到位 */
    seenSeededRef.current = true;
    const next = new Set(imageSessions.map((s) => s.id));
    saveIdSet(SB_SEEN_IMAGE_KEY, next);
    setSeenImageIds(next);
  }, [imageSessions]);

  const newImageCount = useMemo(
    () => imageSessions.reduce((n, s) => (seenImageIds.has(s.id) ? n : n + 1), 0),
    [imageSessions, seenImageIds],
  );

  const activeKind = useMemo(
    () => data.find((s) => s.id === activeSessionId)?.kind,
    [data, activeSessionId],
  );
  const lastSyncedSessionRef = useRef<string | null>(null);
  /* 图片视图是不是「进图片工作室」自动切过去的 —— 离开时只撤销自己切的, 用户手动选的不动 */
  const imageViewByUtilityRef = useRef(false);
  useEffect(() => {
    if (activeUtility === 'image' || activeKind === 'image') return;
    if (imageViewByUtilityRef.current) {
      imageViewByUtilityRef.current = false;
      setSessKind('normal');
    }
    if (!activeSessionId) return;
    if (activeKind === 'chat') {
      /* 切到普通会话才回普通视图; activeKind 未定 (data 还没到) 时先不动, 免得闪一下. */
      if (lastSyncedSessionRef.current !== activeSessionId) {
        setSessKind('normal');
        lastSyncedSessionRef.current = activeSessionId;
      }
    }
  }, [activeSessionId, activeKind, activeUtility]);

  /* 进入图片视图即视为"已看" → 把当前所有图片会话标记 seen, 清掉角标. */
  useEffect(() => {
    if (sessKind !== 'image' || imageSessions.length === 0) return;
    setSeenImageIds((prev) => {
      let changed = false;
      const next = new Set(prev);
      imageSessions.forEach((s) => { if (!next.has(s.id)) { next.add(s.id); changed = true; } });
      if (!changed) return prev;
      saveIdSet(SB_SEEN_IMAGE_KEY, next);
      return next;
    });
  }, [sessKind, imageSessions]);

  /* path → name 映射, 优先 currentWorkspace, 然后 recentWorkspaces, 最后 basename */
  const workspaceNameByPath = useMemo(() => {
    const map = new Map<string, string>();
    if (currentWorkspace) map.set(currentWorkspace.path, displayWorkspaceName(currentWorkspace.path, currentWorkspace.name, isZh));
    recentWorkspaces?.forEach((w) => {
      if (w.path && !map.has(w.path)) map.set(w.path, displayWorkspaceName(w.path, w.name, isZh));
    });
    return map;
  }, [currentWorkspace, recentWorkspaces, isZh]);

  const groups = useMemo<SessionGroup[]>(() => {
    /* GC: rank 缓存是模块顶层跨 workspace 持久, 不能在 data 缺时就清 —
     *   切到 workspace B 时 workspace A 的 session 不在 data, 但切回 A 顺序要稳.
     *   改成纯 LRU 上限: 超过 LIMIT 才 evict 最早插入的 (Map 插入序就是 evict 序).
     *   2000 条 sessionId * ~ 20B/entry = 40KB, 内存压力可忽略. */
    {
      const LIMIT = 2000;
      const map = rankCacheRef.current;
      if (map.size > LIMIT) {
        const toDrop = map.size - LIMIT;
        let i = 0;
        for (const k of map.keys()) {
          if (i >= toDrop) break;
          map.delete(k);
          i++;
        }
      }
    }
    const buckets = new Map<string, { path: string; list: SessionItem[] }>();
    const bucketFor = (rawPath: string): { path: string; list: SessionItem[] } => {
      const key = workspaceKey(rawPath);
      let b = buckets.get(key);
      if (!b) { b = { path: rawPath, list: [] }; buckets.set(key, b); }
      else if (currentWorkspace?.path && rawPath === currentWorkspace.path) b.path = rawPath;
      return b;
    };
    filtered.forEach((s) => { bucketFor(s.workspacePath || '').list.push(s); });
    /* 当前工作区即使没 session 也要露一个空组 (用户刚打开新项目) */
    if (currentWorkspace?.path) bucketFor(currentWorkspace.path);
    if (!modeVariant.hideProjects) {
      /* Pilot 的家不是用户的项目 (它的会话切过去时被记进了最近工作区) */
      const pilotKey = modeHomes?.pilot ? workspaceKey(modeHomes.pilot) : '';
      recentWorkspaces?.forEach((w) => { if (w.path && (!pilotKey || workspaceKey(w.path) !== pilotKey)) bucketFor(w.path); });
      if (modeHomes?.work) bucketFor(modeHomes.work);
    }

    const spaceModeOf = (path: string): 'work' | undefined => {
      const k = workspaceKey(path);
      if (!k) return undefined;
      if (modeHomes?.work && k === workspaceKey(modeHomes.work)) return 'work';
      return undefined;
    };

    const result: SessionGroup[] = [];
    buckets.forEach(({ path, list }, key) => {
      list.sort((a, b) => rankOf(b.id, b.ts) - rankOf(a.id, a.ts));
      /* group 顺序不再随点击/发消息冒泡 — 首次看到该 workspace 时冻结一个稳定 rank.
       * 见 workspaceOrderRank 定义处注释. */
      const latest = ensureWorkspaceOrderRank(key);   /* 按 key 冻结, 换个写法不算新项目 */
      const allCloudOnly = list.length > 0 && list.every((s) => s.cloudOnly);
      const spaceMode = spaceModeOf(path);
      const name = spaceMode
        ? (isZh ? SPACE_META[spaceMode].zh : SPACE_META[spaceMode].en)
        : (workspaceNameByPath.get(path) ||
           (path ? displayWorkspaceName(path, null, isZh) : '') ||
           (path === '' && allCloudOnly ? (isZh ? '云端会话' : 'Cloud sessions') : (isZh ? '未关联' : 'Unlinked')));
      result.push({
        path,
        name,
        sessions: list,
        isActive: !!currentWorkspace?.path && key === workspaceKey(currentWorkspace.path),
        latestActivity: latest,
        spaceMode,
      });
    });

    /* 工作区顺序:
     *   1. 用户拖动过的 (在 wsOrder 里) 按用户 order index 排;
     *   2. 没拖过的按 latestActivity desc 排, 接在用户定义的之后.
     *   不再 active 强制置顶 — 那种排序点击不同文件夹会跳, 用户没安全感. */
    const wsOrderKeys = wsOrder.map(workspaceKey);
    result.sort((a, b) => {
      /* wsOrder 落盘的是原始路径写法, 比较前一并归一化 (同 bucket key 的理由) */
      const ai = wsOrderKeys.indexOf(workspaceKey(a.path));
      const bi = wsOrderKeys.indexOf(workspaceKey(b.path));
      if (ai >= 0 && bi >= 0) return ai - bi;
      if (ai >= 0) return -1;
      if (bi >= 0) return 1;
      return a.latestActivity - b.latestActivity;
    });
    if (modeVariant.hideProjects) {
      const allSessions: SessionItem[] = [];
      for (const g of result) allSessions.push(...g.sessions);
      return bucketByTime(allSessions, isZh);
    }
    const spaces = result.filter((g) => g.spaceMode);
    if (spaces.length === 0) return result;
    return [...spaces, ...result.filter((g) => !g.spaceMode)];
  }, [filtered, data, workspaceNameByPath, currentWorkspace?.path, recentWorkspaces, rankOf, wsOrder, isZh, modeVariant.hideProjects, modeHomes?.work, modeHomes?.pilot]);

  const visibleSegments = useMemo(
    () => (modeVariant.isCode ? SIDEBAR_SEGMENTS.filter((s) => s.id !== 'spaces') : SIDEBAR_SEGMENTS),
    [modeVariant.isCode],
  );
  const visibleGroups = useMemo(() => {
    const pick = (): SessionGroup[] => {
      if (modeVariant.hideProjects) return groups;
      if (modeVariant.isCode) return groups.filter((g) => !g.spaceMode);
      if (groupTab === 'spaces') return groups.filter((g) => g.spaceMode);
      return groups.filter((g) => !g.spaceMode);
    };
    const picked = pick();
    if (sessionsLoading && data.length === 0) {
      const activeOnly = picked.filter((g) => g.isActive);
      if (activeOnly.length > 0) return activeOnly;
    }
    return picked;
  }, [groups, groupTab, modeVariant.hideProjects, modeVariant.isCode, sessionsLoading, data.length]);

  /* 段高亮: 图片段复用 sessKind='image' (自动跟随图片会话的既有联动不动). */
  /* Code 模式下「空间」段不存在 —— 用户此前若停在该段 (localStorage 持久), 段标题会显示
   * "空间"而列表里是项目。这里把它归一到「项目」, 免得标题与内容对不上。 */
  const effectiveGroupTab: 'spaces' | 'projects' =
    modeVariant.isCode && groupTab === 'spaces' ? 'projects' : groupTab;
  const activeSeg: SidebarSeg = sessKind === 'image' ? 'images' : effectiveGroupTab;
  const activeSegMeta = SIDEBAR_SEGMENTS.find((s) => s.id === activeSeg) ?? SIDEBAR_SEGMENTS[1];
  const selectSeg = useCallback((seg: SidebarSeg) => {
    if (seg === 'images') {
      setSessKind('image');
    } else {
      setSessKind('normal');
      setGroupTab(seg);
    }
    setKindMenuOpen(false);
    /* 用户主动选段才持久化 — 自动跟随 (active 图片会话联动) 不覆写偏好. */
    try { window.localStorage.setItem(SIDEBAR_TAB_KEY, seg); } catch { /* ignore */ }
  }, []);

  const groupHasActiveSession = useCallback((g: SessionGroup) => {
    return !!activeSessionId && g.sessions.some((s) => s.id === activeSessionId);
  }, [activeSessionId]);

  const isGroupCollapsed = useCallback((g: SessionGroup) => {
    if (sessQuery.trim()) return false; /* 搜索时全部摊开 (看文件树的组照常可折叠, 打开文件树时已顺手展开) */
    if (g.path in collapsed) return collapsed[g.path]; /* 用户手动操作优先 */
    if (g.isTimeBucket) {
      return g.path === '__time__month' || g.path === '__time__earlier';
    }
    if (g.sessions.some((s) => runningSessionIds?.has(s.id) || s.id === activeSessionId)) return false;
    return !g.isActive; /* 默认: 活跃工作区展开, 其他折叠 */
  }, [collapsed, runningSessionIds, activeSessionId, sessQuery]);

  const toggleGroup = useCallback((path: string, currentlyCollapsed: boolean) => {
    setCollapsed((prev) => ({ ...prev, [path]: !currentlyCollapsed }));
  }, []);

  const commitRename = useCallback(
    (id: string) => {
      const v = editValue.trim();
      if (v) onRenameSession?.(id, v);
      setEditingId(null);
      setEditValue('');
    },
    [editValue, onRenameSession],
  );

  /* 稳定 callback ref — 传给 SessionRow 后 props.identity 不再每帧变,
   * React.memo 浅比 skip 非变更行. */
  const rowOnClick = useEvent((groupPath: string, groupIsActive: boolean, id: string) => {
    handleSessionClick({ path: groupPath, isActive: groupIsActive } as SessionGroup, id);
  });
  const rowOnContextMenu = useEvent((e: React.MouseEvent, id: string) => {
    handleContextMenu(e, id);
  });
  const rowOnEditChange = useEvent((v: string) => setEditValue(v));
  const rowOnCommitEdit = useEvent((id: string) => commitRename(id));
  const rowOnCancelEdit = useEvent(() => { setEditingId(null); setEditValue(''); });
  const rowOnToggleArchive = useEvent((id: string) => toggleArchive(id));
  const rowOnDeleteRequested = useEvent((id: string, title: string) => { void requestDeleteSession(id, title); });

  /* 启动/切换 activeSession 自动滚到可见 — 用户报"重启后会话在底部, 每次手动滚".
   * - listRef 抓 .neox-sidebar__list 这个 overflow:auto 容器
   * - 用 querySelector('[data-session-id="X"]') 找 row
   * - scrolledForIdRef 防同一 id 反复滚 (用户主动上滚后切回, 别再硬拽)
   * - 等 rAF 让 React commit + DOM 落定再读 offset, 避免拿到 0 height */
  const listRef = useRef<HTMLUListElement | null>(null);
  /* P2-26: scrolledIdsRef 用 Set 记录所有已滚过的 id, 而不是 single ref. 之前单 string ref
   *  在"切到 B → 切回 A"场景下覆盖 A 的滚动记录, 用户在 A 上主动翻历史的位置被重滚
   *  强制覆盖. Set 让"已滚过一次"语义跨 id 持久, 切回旧 id 不再硬拽. */
  const scrolledIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!activeSessionId) return;
    /* 已滚过 (无论之前是否切走过), 不再硬拽 — 保留用户主动上滚位置 */
    if (scrolledIdsRef.current.has(activeSessionId)) return;
    const list = listRef.current;
    if (!list) return;
    const raf = requestAnimationFrame(() => {
      const row = list.querySelector(`[data-session-id="${CSS.escape(activeSessionId)}"]`) as HTMLElement | null;
      if (!row) return; /* group 折叠 / 还没渲染 — 等下次 effect (sessions 更新) */
      const lr = list.getBoundingClientRect();
      const rr = row.getBoundingClientRect();
      /* 完全在可视区内就别动. 部分露出 / 完全不可见才滚. */
      if (rr.top >= lr.top && rr.bottom <= lr.bottom) {
        scrolledIdsRef.current.add(activeSessionId);
        return;
      }
      row.scrollIntoView({ block: 'nearest', behavior: 'auto' });
      scrolledIdsRef.current.add(activeSessionId);
    });
    return () => cancelAnimationFrame(raf);
    /* groups 也加进 deps — 跨 workspace 选 session 时 group 从折叠变展开,
     *  row 才出现在 DOM 里, 此时需要重跑 effect 滚到可见.
     *  data.length 单独 = 防 sessions 列表增删时重 scroll. */
  }, [activeSessionId, data.length, groups]);

  const locateActiveSession = useCallback(() => {
    if (!activeSessionId) return;
    const cur = data.find((s) => s.id === activeSessionId);
    const path = cur?.workspacePath || '';
    /* ① 展开组 */
    setCollapsed((prev) => (prev[path] === false ? prev : { ...prev, [path]: false }));
    /* ② 保证这条在"显示更多"的可见页内 */
    const inGroup = data.filter((s) => (s.workspacePath || '') === path);
    const idx = inGroup.findIndex((s) => s.id === activeSessionId);
    if (idx >= 0) {
      setGroupShowCount((prev) => {
        const cur2 = prev.get(path) ?? GROUP_COLLAPSE_LIMIT;
        if (cur2 > idx) return prev;
        const next = new Map(prev);
        next.set(path, Math.min(inGroup.length, idx + 1));
        return next;
      });
    }
    /* ③ 等 DOM 落定再滚 + 闪 —— 展开是 setState, 这一帧行还没进 DOM, 重试几帧 */
    const tryScroll = (attempt: number) => {
      const list = listRef.current;
      const row = list?.querySelector(`[data-session-id="${CSS.escape(activeSessionId)}"]`) as HTMLElement | null;
      if (!row) {
        if (attempt < 10) requestAnimationFrame(() => tryScroll(attempt + 1));
        return;
      }
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      /* 高亮直接打在 DOM 上, 不走 state —— 这是个一次性的视觉提示,
       * 走 state 会让整条会话列表 (可能几百行) 白重渲两次。 */
      row.classList.remove('is-located');
      void row.offsetWidth;           /* 重启动画: 连点两次也要每次都闪 */
      row.classList.add('is-located');
      window.setTimeout(() => row.classList.remove('is-located'), 1700);
    };
    requestAnimationFrame(() => tryScroll(0));
  }, [activeSessionId, data]);

  /* 新建/导入项目后滚到对应 group — AppShell 派 neox:scroll-to-workspace */
  useEffect(() => {
    const onScrollToWorkspace = (e: Event) => {
      const path = (e as CustomEvent<{ path?: string }>).detail?.path;
      if (!path) return;
      /* 展开该组, 避免滚到折叠 header 后仍看不见 */
      setCollapsed((prev) => {
        if (prev[path] === false) return prev;
        return { ...prev, [path]: false };
      });
      const list = listRef.current;
      if (!list) return;
      const tryScroll = (attempt: number) => {
        const row = list.querySelector(`[data-workspace-path="${CSS.escape(path)}"]`) as HTMLElement | null;
        if (!row) {
          if (attempt < 8) requestAnimationFrame(() => tryScroll(attempt + 1));
          return;
        }
        const lr = list.getBoundingClientRect();
        const rr = row.getBoundingClientRect();
        if (rr.top >= lr.top && rr.bottom <= lr.bottom) return;
        row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      };
      requestAnimationFrame(() => tryScroll(0));
    };
    window.addEventListener('neox:scroll-to-workspace', onScrollToWorkspace as EventListener);
    return () => window.removeEventListener('neox:scroll-to-workspace', onScrollToWorkspace as EventListener);
  }, []);

  /* workspace 拖拽 — 重写 wsOrder + 落盘. drop 时根据 当前 groups 中 dragging/target
   * 的相对位置插入. 不限制只能拖到自己之上/之下 — 任意位置 swap. */
  const onWsDragStart = useEvent((e: React.DragEvent, path: string) => {
    setDraggingPath(path);
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', path); } catch { /* ignore */ }
  });
  const onWsDragOver = useEvent((e: React.DragEvent, path: string) => {
    if (!draggingPath || draggingPath === path) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverPath(path);
  });
  const onWsDragLeave = useEvent(() => setDragOverPath(null));
  const onWsDrop = useEvent((e: React.DragEvent, targetPath: string) => {
    e.preventDefault();
    setDragOverPath(null);
    if (!draggingPath || draggingPath === targetPath) { setDraggingPath(null); return; }
    /* 用当前 groups 序构造新 order: 抽出 draggingPath, 插到 targetPath 位置 */
    const allPaths = groups.map((g) => g.path);
    const tIdx = allPaths.indexOf(targetPath);
    if (tIdx < 0) { setDraggingPath(null); return; }
    const next = allPaths.filter((p) => p !== draggingPath);
    next.splice(tIdx, 0, draggingPath);
    setWsOrder(next);
    saveWsOrder(next);
    setDraggingPath(null);
  });
  const onWsDragEnd = useEvent(() => { setDraggingPath(null); setDragOverPath(null); });

  const handleContextMenu = (e: React.MouseEvent, id: string) => {
    if (!onRenameSession && !onDeleteSession && !onExportSession) return;
    e.preventDefault();
    e.stopPropagation();
    setWsContextMenu(null);
    setContextMenu({ id, x: e.clientX, y: e.clientY });
  };

  const handleWsContextMenu = (e: React.MouseEvent, g: SessionGroup) => {
    if (!onRemoveWorkspace && !onCreateSessionInWorkspace) return;
    e.preventDefault();
    e.stopPropagation();
    setWsContextMenu({ path: g.path, name: g.name, isActive: g.isActive, x: e.clientX, y: e.clientY });
  };

  /* 工作台 / 全景用: 全部非图片、非子 agent 会话拍平, 带上项目名 */
  /* UI 3.0: Work 没有项目概念, 一律工作台 (设计稿「进行中 → 最近」), 不给切列表 */
  const workbenchOn = sessKind === 'normal' && (modeVariant.hideProjects || listMode === 'workbench');
  const wbSessions = useMemo(
    () => groups.flatMap((g) => g.sessions.filter((s) => !s.parentSessionId).map((s) => ({ id: s.id, title: s.title, ts: s.ts, timeText: s.timeText, groupName: g.isTimeBucket ? undefined : g.name }))),
    [groups],
  );
  /* Code 工作区 = 同色的一组项目 (codeWorkspaces.ts): 组头文件夹上色; 改完同步当前工作区的根, agent 立刻能读写新加的项目 */
  const codeWsList = useCodeWorkspaces(!modeVariant.hideProjects);
  const { applyWorkspacePatch } = useAppStore();
  const codeWs = useMemo(() => (modeVariant.hideProjects ? undefined : {
    list: codeWsList,
    onSaved: (changed: Array<{ primary: string; roots: string[]; name?: string }>) => {
      for (const c of changed) applyWorkspacePatch(c.primary, { roots: c.roots, name: c.name });
    },
  }), [modeVariant.hideProjects, codeWsList, applyWorkspacePatch]);
  const wbProjects = useMemo<WorkbenchProject[] | undefined>(() => {
    if (modeVariant.hideProjects) return undefined;
    return groups
      .filter((g) => !g.isTimeBucket && g.path)
      .map((g) => ({
        key: g.path,
        name: g.name,
        branch: g.isActive ? projBranch ?? undefined : undefined,
        isActive: !!g.isActive,
        sessionIds: g.sessions.filter((s) => !s.parentSessionId).map((s) => s.id),
        lastTs: g.sessions.reduce((m, s) => Math.max(m, s.ts ?? 0), 0),
        color: workspaceOf(g.path, codeWsList)?.color,
      }));
  }, [groups, modeVariant.hideProjects, projBranch, codeWsList]);
  /* Work 项目 (设计稿 E8jf「Work 项目」): 「最近」右边项目下拉。任务属于哪个项目看它的任务文件夹 */
  const wpList = useWorkProjects(!!modeVariant.isWork);
  const wpFilter = useWorkProjectFilter();
  const wpProjectOf = useMemo(() => {
    const m = new Map<string, WorkProject>();
    if (!modeVariant.isWork || wpList.length === 0) return m;
    for (const g of groups) for (const s of g.sessions) {
      const p = projectOfTask(s.taskDir, wpList);
      if (p) m.set(s.id, p);
    }
    return m;
  }, [groups, wpList, modeVariant.isWork]);
  const wpSyncedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!modeVariant.isWork || !activeSessionId || wpSyncedRef.current === activeSessionId) return;
    if (!groups.some((g) => g.sessions.some((s) => s.id === activeSessionId))) return;   /* 列表还没带上它, 等下一轮 */
    wpSyncedRef.current = activeSessionId;
    if (!wpFilter) return;
    const own = wpProjectOf.get(activeSessionId)?.dir ?? null;
    if (own !== wpFilter) setWorkProjectFilter(own);
  }, [activeSessionId, groups, wpFilter, wpProjectOf, modeVariant.isWork]);
  const wpCreate = useEvent(async (name: string) => {
    try {
      const p = await createWorkProject(name);
      if (p) setWorkProjectFilter(p.dir);
    } catch (e) {
      dispatchHint((e as Error).message || (isZh ? '新建项目失败' : 'Could not create project'), 'warning');
    }
  });
  const workProjectsProps = useMemo<WorkProjectsProps | undefined>(() => (modeVariant.isWork ? {
    projects: wpList,
    filter: wpFilter,
    projectOf: wpProjectOf,
    onPick: setWorkProjectFilter,
    onCreate: (n) => void wpCreate(n),
    onAllProjects: () => window.dispatchEvent(new CustomEvent('neox:open-work-projects')),
    onProjectHome: (dir) => window.dispatchEvent(new CustomEvent('neox:open-work-project', { detail: { dir } })),
  } : undefined), [modeVariant.isWork, wpList, wpFilter, wpProjectOf, wpCreate]);
  /* Code 新建项目: 编码目录下建空文件夹 (git init), 建好直接在里面开一个新任务 */
  const wbCreateCodeProject = useEvent(async (name: string) => {
    const r = await (window as { neox?: { codeProjectCreate?: (n: string) => Promise<{ ok?: boolean; path?: string; error?: string }> } }).neox?.codeProjectCreate?.(name);
    if (!r?.ok || !r.path) { dispatchHint(r?.error || (isZh ? '新建项目失败' : 'Could not create project'), 'warning'); return; }
    onCreateSessionInWorkspace?.(r.path);
  });
  /* 项目组头「⋯」: 复用列表模式那份工作区菜单 (重命名 / 移除 / 编辑工作区 / 在访达中显示) */
  const wbProjectMenu = useEvent((key: string, rect: DOMRect) => {
    const g = groups.find((x) => x.path === key);
    if (g) gOpenMenu(g, rect);
  });
  const wbNewInProject = useEvent((key: string) => {
    const g = groups.find((x) => x.path === key);
    if (g) gNewChatIn(g);
  });
  const wbIsRunning = (id: string) => runningSessionIds?.has(id) === true || (id === activeSessionId && streaming);
  const wbSelect = (id: string) => { const g = groups.find((x) => x.sessions.some((s) => s.id === id)); if (g) handleSessionClick(g, id); else onSelectSession?.(id); };
  /* ── 列表模式分组 (SidebarGroupBlock) 用: 每组的会话 id 集合 + 一份引用稳定的回调 ctx ── */
  const groupIdSets = useMemo(() => new Map(visibleGroups.map((g) => [g.path, new Set(g.sessions.map((s) => s.id))])), [visibleGroups]);
  const gToggleFiles = useEvent((g: SessionGroup) => {
    if (!g.isActive && onSelectWorkspace) onSelectWorkspace(g.path, { silent: true });
    setFilesFor((cur) => (cur === g.path ? null : g.path));
    if (filesFor !== g.path) setCollapsed((prev) => (prev[g.path] === false ? prev : { ...prev, [g.path]: false })); /* 打开文件树时展开这一组 */
  });
  const gNewChatIn = useEvent((g: SessionGroup) => {
    if (g.isActive && onNewSession) onNewSession();
    else if (onCreateSessionInWorkspace) onCreateSessionInWorkspace(g.path);
  });
  const gOpenMenu = useEvent((g: SessionGroup, rect: DOMRect) => setWsContextMenu({ path: g.path, name: g.name, isActive: g.isActive, x: rect.right - 160, y: rect.bottom + 4 }));
  const gSwitchAndCreate = useEvent((g: SessionGroup) => {
    /* 让 NeoxShellHost 跨 workspace 挂载后调 createNewSession (已有 flag 路径) */
    try { window.localStorage.setItem('neox-pending-new-session', '1'); } catch { /* ignore */ }
    if (onSelectWorkspace) onSelectWorkspace(g.path);
  });
  const gToggleGroup = useEvent(toggleGroup);
  const gWsContextMenu = useEvent(handleWsContextMenu);
  const gSetWsEditValue = useEvent((v: string) => setWsEditValue(v));
  const gCommitWsRename = useEvent(commitWsRename);
  const gCancelWsRename = useEvent(() => setWsEditingPath(null));
  const gShowWsPanel = useEvent((p?: string) => onShowWorkspacePanel?.(p));
  const gToggleChild = useEvent(toggleChildExpand);
  const gMoreChildren = useEvent(showMoreChildren);
  const gKeepInView = useEvent(keepInView);
  const gMoreInGroup = useEvent(showMoreInGroup);
  const gCollapseGroup = useEvent(collapseGroup);
  const groupCtx = useMemo<GroupCtx>(() => ({
    isZh, hideProjects: !!modeVariant.hideProjects, isWork: !!modeVariant.isWork, spaceIcon: SPACE_META.work.icon,
    hasDelete: !!onDeleteSession, hasNewChat: !!(onCreateSessionInWorkspace || onNewSession), hasWorkspacePanel: !!onShowWorkspacePanel,
    SessionRow,
    toggleGroup: gToggleGroup, onWsDragStart, onWsDragOver, onWsDragLeave, onWsDrop, onWsDragEnd, onWsContextMenu: gWsContextMenu,
    setWsEditValue: gSetWsEditValue, commitWsRename: gCommitWsRename, cancelWsRename: gCancelWsRename,
    toggleFiles: gToggleFiles, showWorkspacePanel: gShowWsPanel, newChatIn: gNewChatIn, openGroupMenu: gOpenMenu, switchAndCreate: gSwitchAndCreate,
    row: { onClick: rowOnClick, onContextMenu: rowOnContextMenu, onEditChange: rowOnEditChange, onCommitEdit: rowOnCommitEdit, onCancelEdit: rowOnCancelEdit, onToggleArchive: rowOnToggleArchive, onDeleteRequested: rowOnDeleteRequested },
    toggleChildExpand: gToggleChild, showMoreChildren: gMoreChildren, keepInView: gKeepInView, showMoreInGroup: gMoreInGroup, collapseGroup: gCollapseGroup,
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 回调全是 useEvent 稳定引用, 只随这几个值重建
  }), [isZh, modeVariant.hideProjects, modeVariant.isWork, !!onDeleteSession, !!(onCreateSessionInWorkspace || onNewSession), !!onShowWorkspacePanel]);

  /* 头部「⋯」里的东西 = 原来列表头上那排小图标 */
  const headMore: HeadMoreProps = {
    segments: visibleSegments, activeSeg, onSeg: (id) => selectSeg(id as SidebarSeg),
    onLocate: activeSessionId ? locateActiveSession : undefined,
    onOpenProject: onAddWorkspace, onManageProjects: onShowWorkspacePanel ? () => onShowWorkspacePanel() : undefined,
    onFileExplorer: onOpenFileExplorer,
    view, views: (['recent', 'pinned', 'archived'] as const).map((v) => ({ id: v, label: viewLabels[v] })), onView: (v) => setView(v as SessionView),
  };

  const handleSessionClick = (group: SessionGroup, id: string) => {
    onSelectSession?.(id);
    if (group.path.startsWith('__time__')) {
      /* 会话自带 workspacePath 与当前 workspace 不同时 (老会话 bake 的目录),
       * 按会话自己的归属切过去 (与跨 workspace 组点击同语义). */
      const s = data.find((x) => x.id === id);
      if (s?.workspacePath && workspaceKey(s.workspacePath) !== workspaceKey(currentWorkspace?.path) && onSelectWorkspace) {
        onSelectWorkspace(s.workspacePath, { silent: true });
      }
      return;
    }
    if (!group.isActive && onSelectWorkspace) {
      onSelectWorkspace(group.path, { silent: true });
    }
  };

  const isNoMatch = data.length > 0 && filtered.length === 0;
  /* 没有任何 group 时才显示全局空态 — 通常是没打开 workspace 的极端场景.
   * 当 currentWorkspace 存在,即使该 workspace 暂无 sessions 也会有一个 group 显示出来. */
  const showGlobalEmpty = !isNoMatch && groups.length === 0;

  return (
    <aside
      className={`neox-sidebar neox-shell__sidebar${modeVariant.isWork ? ' neox-sidebar--plain' : ''}`}
      data-motion={motion}
      aria-label={isZh ? "任务侧栏" : "Task sidebar"}
    >
      <div className="neox-sidebar__quick"
        aria-label={isZh ? '常用入口' : 'Common actions'}
        /* 侧栏任何 quick action click 前都广播一次 sidebar-nav — 让打开中的收藏 modal / 其他内嵌 popover
         * 主动关掉自己, 避免 modal + 新页面叠层 (P2-7 之前收藏 modal 开着点搜索, 两个都显在屏上). */
        onClickCapture={() => { try { window.dispatchEvent(new CustomEvent('neox:sidebar-nav')); } catch { /* noop */ } }}
      >
        <button
          type="button"
          className="neox-sidebar__newchat"
          data-tour="new-chat"
          onClick={(e) => {
            setSessKind('normal');
            const rect = e.currentTarget.getBoundingClientRect();
            onNewSession?.();
            /* Work 不弹: 那份菜单列的是代码项目 (neox-bench / Neox…), Work 的项目在「最近」右边的项目下拉里选 */
            if (!modeVariant.isWork && onCreateSessionInWorkspace && recentWorkspaces?.length) setNewchatMenu(rect);
          }}
          disabled={!onNewSession}
          title={isZh ? `新建任务 (${kbd('mod+n')})` : `New task (${kbd('mod+n')})`}
        >
          {/* 设计稿 UI 3.0: Work / Code 都叫「新建任务」 */}
          <span className="neox-sidebar__newchat-label">
            {isZh ? '新建任务' : 'New task'}
            {/* 选着 Work 项目: 新任务建在项目里, 按钮上写明 */}
            {modeVariant.isWork && wpFilter && wpList.find((p) => sameWorkspace(p.dir, wpFilter)) && (
              <span className="neox-sidebar__newchat-proj"> · {wpList.find((p) => sameWorkspace(p.dir, wpFilter))!.name}</span>
            )}
          </span>
          <kbd className="neox-sidebar__newchat-kbd">{kbd('mod+n')}</kbd>
          <img className="neox-sidebar__newchat-art" src={clayNewchatArt} alt="" aria-hidden="true" draggable={false} />
          <span className="neox-sidebar__newchat-plus" aria-hidden="true"><IconPlus size={14} /></span>
        </button>
        {newchatMenu && (
          <ProjectPicker
            anchor={newchatMenu}
            matchWidth
            title={isZh ? '在哪个项目里新建' : 'New chat in'}
            projects={[...(currentWorkspace ? [currentWorkspace] : []), ...(recentWorkspaces ?? [])]}
            currentPath={currentWorkspace?.path}
            isZh={isZh}
            onPick={(p) => { setNewchatMenu(null); if (p !== currentWorkspace?.path) onCreateSessionInWorkspace?.(p); }}
            onOpenFolder={onAddWorkspace ? () => { setNewchatMenu(null); onAddWorkspace(); } : undefined}
            onClose={() => setNewchatMenu(null)}
          />
        )}
      </div>

      {/* Code 稿: 新建按钮下面一行「项目 · 分支 ▾」, 点开换项目 (工作台模式没有项目分组, 靠这行知道自己在哪) */}
      {/* 工作台按项目分组之后 (wbProjects) 这一行就多余了: 项目就是组头, 点哪组的会话就在哪个项目里 */}
      {!modeVariant.hideProjects && workbenchOn && currentWorkspace && !wbProjects && (
        <>
          <button
            type="button"
            className="neox-sidebar__proj"
            onClick={(e) => setProjMenu(e.currentTarget.getBoundingClientRect())}
            title={currentWorkspace.path}
          >
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.8l1.4 1.5h4.8A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" /></svg>
            <span className="neox-sidebar__proj-name">{currentWorkspace.name}{projBranch ? ` · ${projBranch}` : ''}</span>
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m4.5 6.5 3.5 3.5 3.5-3.5" /></svg>
          </button>
          {projMenu && (
            <ProjectPicker
              anchor={projMenu}
              matchWidth
              title={isZh ? '切换项目' : 'Switch project'}
              projects={[currentWorkspace, ...(recentWorkspaces ?? []).filter((w) => w.path !== currentWorkspace.path)]}
              currentPath={currentWorkspace.path}
              isZh={isZh}
              onPick={(p) => { setProjMenu(null); if (p !== currentWorkspace.path) onSelectWorkspace?.(p); }}
              onOpenFolder={onAddWorkspace ? () => { setProjMenu(null); onAddWorkspace(); } : undefined}
              onClose={() => setProjMenu(null)}
            />
          )}
        </>
      )}

      {(!modeVariant.hideProjects || imageSessions.length > 0)
        && !(workbenchOn && !searchOpen) && (
      <div className="neox-sidebar__section-head">
        {sessKind === 'image' && !modeVariant.hideProjects ? (
          <ImageModeHead count={imageSessions.length} onNew={onNewImageSession} zh={isZh} onBack={() => {
            /* 侧栏回会话列表, 主区也回对话: 图片工作台是页面状态, 不跟当前会话走, 所以总要重新选一次会话
             * (当前就是普通会话就选它自己, 否则选最近一个) —— 选会话会把主区切回对话页 */
            selectSeg('projects');
            const cur = data.find((s) => s.id === activeSessionId);
            const target = cur && cur.kind !== 'image' ? cur.id : [...wbSessions].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))[0]?.id;
            if (target) wbSelect(target);
          }} />
        ) : sessKind === 'normal' && !modeVariant.hideProjects ? (
          searchOpen
            ? <SidebarSearchBar value={sessQuery} onChange={setSessQuery} onClose={closeSearch} onFullText={onSearch} count={filtered.length} zh={isZh} />
            : <WorkbenchHead mode={listMode} onMode={setListMode} onOverview={() => setOverviewOpen(true)} onSearch={() => setSearchOpen(true)} more={headMore} zh={isZh} />
        ) : (<>
        {!modeVariant.hideProjects ? (
          <div className="neox-sidebar__kind-dd-wrap" style={{ position: 'relative' }}>
            <button
              type="button"
              className={`neox-sidebar__kind-dd neox-sidebar__kind-dd--seg${kindMenuOpen ? ' is-open' : ''}`}
              onClick={() => setKindMenuOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={kindMenuOpen}
              aria-label={isZh ? '侧栏视图' : 'Sidebar view'}
              title={isZh ? activeSegMeta.zh : activeSegMeta.en}
            >
              <span className="neox-sidebar__kind-dd-icon" aria-hidden="true">{activeSegMeta.icon}</span>
              <span className="neox-sidebar__section-head__title">
                {isZh ? activeSegMeta.zh : activeSegMeta.en}
              </span>
              <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 6l4 4 4-4" /></svg>
              {activeSeg !== 'images' && newImageCount > 0 && (
                <span className="neox-sidebar__kind-badge" title={isZh ? `${newImageCount} 个新图片会话` : `${newImageCount} new image sessions`}>
                  {newImageCount > 9 ? '9+' : newImageCount}
                </span>
              )}
            </button>
            {kindMenuOpen && (
              <div className="neox-sidebar__kind-menu" role="menu" onClick={() => setKindMenuOpen(false)}>
                {visibleSegments.map((seg) => (
                  <button
                    key={seg.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={activeSeg === seg.id}
                    className={`neox-sidebar__kind-menu-item${activeSeg === seg.id ? ' is-active' : ''}`}
                    onClick={() => selectSeg(seg.id)}
                  >
                    <span className="neox-sidebar__kind-menu-item-icon" aria-hidden="true">{seg.icon}</span>
                    <span>{isZh ? seg.zh : seg.en}</span>
                    {seg.id === 'images' && (
                      <span className="neox-sidebar__kind-menu-count">{imageSessions.length}</span>
                    )}
                    {activeSeg === seg.id && <span className="neox-sidebar__view-check" aria-hidden>✓</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : imageSessions.length > 0 ? (
          <div className="neox-sidebar__kind-dd-wrap" style={{ position: 'relative' }}>
            <button
              type="button"
              className={`neox-sidebar__kind-dd${kindMenuOpen ? ' is-open' : ''}`}
              onClick={() => setKindMenuOpen(v => !v)}
              aria-haspopup="menu"
              aria-expanded={kindMenuOpen}
            >
              <span className="neox-sidebar__section-head__title">
                {sessKind === 'image'
                  ? (isZh ? '图片' : 'Images')
                  : (view === 'recent' ? (isZh ? (modeVariant.hideProjects ? '对话' : '项目') : (modeVariant.hideProjects ? 'Chats' : 'Projects')) : viewLabels[view])}
              </span>
              <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 6l4 4 4-4" /></svg>
              {sessKind === 'normal' && newImageCount > 0 && (
                <span className="neox-sidebar__kind-badge" title={isZh ? `${newImageCount} 个新图片会话` : `${newImageCount} new image sessions`}>
                  {newImageCount > 9 ? '9+' : newImageCount}
                </span>
              )}
            </button>
            {kindMenuOpen && (
              <div className="neox-sidebar__kind-menu" role="menu" onClick={() => setKindMenuOpen(false)}>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={sessKind === 'normal'}
                  className={`neox-sidebar__kind-menu-item${sessKind === 'normal' ? ' is-active' : ''}`}
                  onClick={() => setSessKind('normal')}
                >
                  <span>{isZh ? (modeVariant.hideProjects ? '对话' : '项目') : (modeVariant.hideProjects ? 'Chats' : 'Projects')}</span>
                  {sessKind === 'normal' && <span className="neox-sidebar__view-check" aria-hidden>✓</span>}
                </button>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={sessKind === 'image'}
                  className={`neox-sidebar__kind-menu-item${sessKind === 'image' ? ' is-active' : ''}`}
                  onClick={() => setSessKind('image')}
                >
                  <span>{isZh ? '图片' : 'Images'}</span>
                  <span className="neox-sidebar__kind-menu-count">{imageSessions.length}</span>
                  {sessKind === 'image' && <span className="neox-sidebar__view-check" aria-hidden>✓</span>}
                </button>
              </div>
            )}
          </div>
        ) : (
          <span className="neox-sidebar__section-head__title">
            {view === 'recent' ? (isZh ? '项目' : 'Projects') : viewLabels[view]}
          </span>
        )}
        {sessKind === 'image' && onNewImageSession && (
        <div className="neox-sidebar__section-head__tools">
          <button
            type="button"
            className="neox-sidebar__icobtn"
            onClick={onNewImageSession}
            title={isZh ? '新建图片' : 'New image'}
            aria-label={isZh ? '新建图片' : 'New image'}
          >
            <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3.3v9.4M3.3 8h9.4" /></svg>
          </button>
        </div>
        )}
        {sessKind === 'normal' && !modeVariant.hideProjects && (
        <div className="neox-sidebar__section-head__tools">
          <button
            type="button"
            className="neox-sidebar__icobtn"
            onClick={locateActiveSession}
            disabled={!activeSessionId}
            title={isZh ? '定位当前会话' : 'Locate current chat'}
            aria-label={isZh ? '定位当前会话' : 'Locate current chat'}
          >
            <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.3">
              <circle cx="8" cy="8" r="6.1" />
              <circle cx="8" cy="8" r="2.9" strokeWidth="1.15" opacity="0.75" />
              <circle cx="8" cy="8" r="1.15" fill="currentColor" stroke="none" />
            </svg>
          </button>
          {onAddWorkspace && (
            <div className="neox-sidebar__project-btn-wrap" style={{ position: 'relative' }}>
              <button
                type="button"
                className="neox-sidebar__icobtn"
                onClick={() => setProjectMenuOpen(v => !v)}
                title={isZh ? "项目管理" : "Project management"}
                aria-label={isZh ? "项目管理" : "Project management"}
                aria-haspopup="menu"
              >
                <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2 4.5h12M2 4.5V12a1.5 1.5 0 001.5 1.5h9A1.5 1.5 0 0014 12V4.5M2 4.5l1.2-2.1A1.5 1.5 0 014.5 1.5h7a1.5 1.5 0 011.3.9L14 4.5" />
                  <path d="M5.8 9l1.7 1.7L10.8 7.5" />
                </svg>
              </button>
              {projectMenuOpen && (
                <div className="neox-sidebar__project-menu" role="menu" onClick={() => setProjectMenuOpen(false)}>
                  <button type="button" role="menuitem" className="neox-sidebar__project-menu__item" onClick={() => { onAddWorkspace(); }}>
                    <svg viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d="M1 7.5V11a2 2 0 002 2h8a2 2 0 002-2V7.5M7 1v8M4.5 3.5L7 1l2.5 2.5" /></svg>
                    <span>{isZh ? "打开项目…" : "Open project…"}</span>
                  </button>
                  <button type="button" role="menuitem" className="neox-sidebar__project-menu__item" onClick={() => { onShowWorkspacePanel?.(); }}>
                    <svg viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><rect x="1" y="1" width="12" height="12" rx="2" /><path d="M1 5h12M5 5v8" /></svg>
                    <span>{isZh ? "管理项目列表" : "Manage project list"}</span>
                  </button>
                </div>
              )}
            </div>
          )}
          {onOpenFileExplorer && (
            <button
              type="button"
              className="neox-sidebar__icobtn"
              onClick={onOpenFileExplorer}
              title={isZh ? '文件管理器' : 'File explorer'}
              aria-label={isZh ? '文件管理器' : 'File explorer'}
            >
              <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1.5 4.2A1.7 1.7 0 013.2 2.5h2.6l1.5 1.7h5.5a1.7 1.7 0 011.7 1.7v6A1.7 1.7 0 0112.8 13.6H3.2a1.7 1.7 0 01-1.7-1.7v-7.7z" />
                <path d="M1.5 6.4h13" opacity="0.55" />
              </svg>
            </button>
          )}
          {/* 回工作台: 跟工作台头里同一个两段切换, 这里只露图标 (列表模式头上已经挤了几颗按钮) */}
          <button
            type="button"
            className={`neox-sidebar__icobtn${viewMenuOpen ? ' is-active' : ''}`}
            onClick={() => setViewMenuOpen((v) => !v)}
            title={isZh ? "筛选 / 视图" : "Filter / View"}
            aria-label={isZh ? "筛选" : "Filter"}
            aria-haspopup="menu"
            aria-expanded={viewMenuOpen}
          >
            <IconFilter size={16} />
          </button>
          {viewMenuOpen && (
            <div className="neox-sidebar__view-menu neox-sidebar__view-menu--anchored" role="menu">
              {(['recent', 'pinned', 'archived'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  role="menuitemradio"
                  aria-checked={view === v}
                  className={`neox-sidebar__view-item${view === v ? ' is-active' : ''}`}
                  onClick={() => { setView(v); setViewMenuOpen(false); }}
                >
                  <span>{viewLabels[v]}</span>
                  {view === v && <span className="neox-sidebar__view-check" aria-hidden>✓</span>}
                </button>
              ))}
            </div>
          )}
        </div>
        )}
        </>)}
      </div>
      )}

      <div className="neox-sidebar__section">
        {sessKind === 'image' && imageSessions.length === 0 && (
          <div className="neox-sidebar__empty">
            <div className="neox-sidebar__empty__hint">{isZh ? '还没有图片会话' : 'No image sessions yet'}</div>
          </div>
        )}
        {sessKind === 'image' && (
          <ul className="neox-sidebar__list neox-sidebar__list--flat">
            {imageSessions.map((s) => {
              const isActive = s.id === activeSessionId;
              const isRunning = runningSessionIds?.has(s.id) === true;
              const isStreaming = isRunning || (isActive && streaming);
              const isEditing = editingId === s.id;
              const isArchived = archivedSet.has(s.id);
              return (
                <SessionRow
                  key={s.id}
                  session={s}
                  groupPath={s.workspacePath || ''}
                  groupIsActive={isActive}
                  isActive={isActive}
                  isStreaming={isStreaming}
                  isArchived={isArchived}
                  isEditing={isEditing}
                  editValue={isEditing ? editValue : ''}
                  showDelete={!!onDeleteSession}
                  onClick={rowOnClick}
                  onContextMenu={rowOnContextMenu}
                  onEditChange={rowOnEditChange}
                  onCommitEdit={rowOnCommitEdit}
                  onCancelEdit={rowOnCancelEdit}
                  onToggleArchive={rowOnToggleArchive}
                  onDeleteRequested={rowOnDeleteRequested}
                  isZh={isZh}
                  plain={modeVariant.isWork}
                />
              );
            })}
          </ul>
        )}
        {sessKind === 'normal' && showGlobalEmpty && (
          <div className="neox-sidebar__empty">
            {/* 侧栏只有 218px 宽, 图给到 76px 就够 —— 再大就把这一栏的主角
                (会话列表) 挤没了。 */}
            <img className="nx-illus nx-illus--sm" src={NeoxIllus.task} alt="" aria-hidden draggable={false} />
            <div className="neox-sidebar__empty__title">{isZh ? "还没有任务" : "No tasks yet"}</div>
            <div className="neox-sidebar__empty__hint">{isZh ? `点上方「新建」或按 ${kbd('mod+n')} 开始` : `Click New above or press ${kbd('mod+n')} to start`}</div>
          </div>
        )}
        {/* 删除缓冲窗 —— 会话已从列表拿掉但还没真删, 这几秒里给一条明确的退路.
          * 不做 toast 是因为 toast 会飘走, 而这条要一直在视线里直到窗口结束. */}
        {pendingDelete && (
          <div className="neox-sidebar__undobar" role="status">
            <span className="neox-sidebar__undobar__text">
              {isZh ? `已删除「${pendingDelete.title}」` : `Deleted "${pendingDelete.title}"`}
            </span>
            <button type="button" className="neox-sidebar__undobar__btn" onClick={undoPendingDelete}>
              {isZh ? '撤销' : 'Undo'}
            </button>
          </div>
        )}
        {sessKind === 'normal' && isNoMatch && sessQuery.trim() && !workbenchOn && (
          <div className="neox-sidebar__empty">
            <div className="neox-sidebar__empty__hint">{isZh ? '没有标题或项目名对得上的会话' : 'No chat title or project matches'}</div>
          </div>
        )}
        {sessKind === 'normal' && isNoMatch && !sessQuery.trim() && (
          <div className="neox-sidebar__empty">
            <div className="neox-sidebar__empty__title">
              {view === 'archived' ? (isZh ? '还没有归档的会话' : 'Nothing archived yet')
                : view === 'pinned' ? (isZh ? '还没有收藏的会话' : 'Nothing pinned yet')
                : (isZh ? '这里还是空的' : 'Nothing here yet')}
            </div>
            <div className="neox-sidebar__empty__hint">
              {view === 'archived' ? (isZh ? '把不想看的会话归档, 它们会收到这里' : 'Archive a session and it lands here')
                : view === 'pinned' ? (isZh ? '收藏常用会话, 方便随时找回' : 'Pin the sessions you come back to')
                : (isZh ? '新建一个会话开始' : 'Start a new session')}
            </div>
          </div>
        )}
        {sessKind === 'normal' && !showGlobalEmpty && !isNoMatch && visibleGroups.length === 0 && (
          <div className="neox-sidebar__empty">
            <div className="neox-sidebar__empty__hint">
              {groupTab === 'spaces'
                ? (isZh ? '空间还没就绪' : 'Spaces not ready yet')
                : (isZh ? '还没有项目,点上方文件夹图标打开' : 'No projects yet. Open one via the folder icon above')}
            </div>
          </div>
        )}
        {workbenchOn && !showGlobalEmpty && (
          <SidebarWorkbench
            sessions={wbSessions}
            pinnedIds={pinnedSet}
            activeSessionId={activeSessionId}
            isRunning={wbIsRunning}
            onSelect={wbSelect}
            onContextMenu={handleContextMenu}
            onOverview={() => setOverviewOpen(true)}
            onFolders={modeVariant.hideProjects ? undefined : () => setListMode('folders')}
            query={sessQuery}
            work={!!modeVariant.isWork}
            projects={wbProjects}
            onNewInProject={onCreateSessionInWorkspace || onNewSession ? wbNewInProject : undefined}
            onOpenProject={onAddWorkspace}
            onCreateProject={wbProjects && onCreateSessionInWorkspace ? (n) => void wbCreateCodeProject(n) : undefined}
            codeWs={wbProjects ? codeWs : undefined}
            onProjectMenu={wbProjects ? wbProjectMenu : undefined}
            workProjects={workProjectsProps}
            zh={isZh}
          />
        )}
        {overviewOpen && (
          <SessionOverview
            groups={groups.filter((g) => g.sessions.length > 0).map((g) => ({ key: g.path || g.name, name: g.name, sessions: g.sessions.filter((s) => !s.parentSessionId).sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0)) }))}
            activeSessionId={activeSessionId}
            isRunning={wbIsRunning}
            onSelect={wbSelect}
            onClose={() => setOverviewOpen(false)}
            zh={isZh}
          />
        )}
        {sessKind === 'normal' && !showGlobalEmpty && !isNoMatch && !workbenchOn && (
          <ul className="neox-sidebar__list" ref={listRef}>
            {/* 每组一个 memo 组件 (SidebarGroupBlock): 切会话只重渲染新旧两组, 不再 61 组整片重建 */}
            {visibleGroups.map((g) => {
              const ids = groupIdSets.get(g.path) ?? EMPTY_IDS;
              const inG = (id: string | null | undefined): id is string => !!id && ids.has(id);
              const pick = (it: Iterable<string> | undefined) => { if (!it) return ''; const out: string[] = []; for (const x of it) if (ids.has(x)) out.push(x); return out.join('|'); };
              const ws = g.isActive ? currentWorkspace : recentWorkspaces?.find((w) => workspaceKey(w.path) === workspaceKey(g.path));
              const childShow: string[] = [];
              for (const [k, v] of childShowCount) if (ids.has(k)) childShow.push(`${k}:${v}`);
              return (
                <SidebarGroupBlock
                  key={g.path || '__empty__'}
                  g={g}
                  ctx={groupCtx}
                  collapsedNow={isGroupCollapsed(g)}
                  activeId={inG(activeSessionId) ? activeSessionId : null}
                  streamingActive={inG(activeSessionId) && !!streaming}
                  runningKey={pick(runningSessionIds)}
                  editingId={inG(editingId) ? editingId : null}
                  editValue={inG(editingId) ? editValue : ''}
                  archivedKey={pick(archivedSet)}
                  showCount={groupShowCount.get(g.path)}
                  expandedKey={pick(expandedChildrenSet)}
                  childShowKey={childShow.join('|')}
                  filesOn={filesFor === g.path}
                  isDragging={draggingPath === g.path}
                  isDragOver={dragOverPath === g.path}
                  wsEditing={wsEditingPath === g.path}
                  wsEditValue={wsEditingPath === g.path ? wsEditValue : ''}
                  rootCount={ws?.roots?.length ?? 1}
                  loading={!!sessionsLoading && g.isActive}
                />
              );
            })}

          </ul>
        )}
      </div>

      <div ref={toolsRef} className={`neox-sidebar__tools${toolsOpen ? ' is-open' : ''}`}>
        <button
          type="button"
          className="neox-sidebar__tools-toggle"
          title={isZh ? '工具 — 技能 · MCP · 知识库 · 图片 · 插件 · 团队' : 'Tools'}
          aria-label={isZh ? '工具' : 'Tools'}
          aria-expanded={toolsOpen}
          onClick={() => (onOpenTools ? onOpenTools() : setToolsOpen((v) => !v))}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="2" y="2" width="5" height="5" rx="1.4" /><rect x="9" y="2" width="5" height="5" rx="1.4" /><rect x="2" y="9" width="5" height="5" rx="1.4" /><rect x="9" y="9" width="5" height="5" rx="1.4" /></svg>
          <span>{isZh ? '工具' : 'Tools'}</span>
          <em>{isZh ? '技能 · 知识库 · 插件…' : 'Skills · knowledge · plugins…'}</em>
        </button>
        <SidebarToolDock
          active={activeUtility}
          tools={([
            { id: 'skills',label: isZh ? '技能' : 'Skills', title: isZh ? '技能' : 'Skills',
              onClick: () => { (onOpenSkills ?? (() => openSettingsTab('skills')))(); showFeatureIntro('skills'); } },
            !modeVariant.isWork && { id: 'mcp',label: 'MCP', title: isZh ? 'MCP 工具' : 'MCP tools',
              onClick: () => { (onOpenMcp ?? (() => openSettingsTab('mcp')))(); showFeatureIntro('mcp'); } },
            { id: 'knowledge',label: isZh ? '知识库' : 'Knowledge', title: isZh ? '知识库 — 长期记忆 / 参考资料' : 'Knowledge base — long-term memory & references',
              onClick: () => { (onOpenKnowledgeBase ?? (() => openSettingsTab('memory')))(); showFeatureIntro('knowledge'); } },
            /* 图片工作台: 三模式都显 —— 点进去每次开新 kind=image 会话 (跟分段里翻已有图片会话的「图片」不是一回事) */
            onOpenImageStudio && { id: 'image',label: isZh ? '图片' : 'Images', title: isZh ? '图片工作台 (直连出图, 不占对话)' : 'Image studio (direct generation, no chat)',
              onClick: onOpenImageStudio },
            { id: 'plugins',label: isZh ? '插件' : 'Plugins', title: isZh ? '插件管理 — 扩展模块 / 市场 / 本地安装' : 'Plugins — modules, marketplace, local install',
              onClick: onOpenPlugins, disabled: !onOpenPlugins },
            /* 文件库: Neox 生成的所有产出文件 —— 只在 Work (Code 有完整文件树) */
            modeVariant.isWork && onOpenLibrary && { id: 'library',label: isZh ? '成品架' : 'Shelf', title: isZh ? '成品架 — 所有任务做出来的东西' : 'Shelf — everything Neox has produced',
              onClick: onOpenLibrary },
            /* 团队: 按能力位置灰 (见 pages/team/teamAvailability.ts) */
            onOpenTeam && (() => {
              const teamOpen = isTeamEnabled();
              return { id: 'team',label: isZh ? '团队' : 'Team',
                title: teamOpen ? (isZh ? '团队 · Team 集群' : 'Team cluster') : teamUnavailableReason(isZh),
                onClick: () => { if (teamOpen) onOpenTeam(); }, disabled: !teamOpen, unavailable: !teamOpen };
            })(),
          ].filter(Boolean) as DockTool[])}
          zh={isZh}
          onSelectSession={onSelectSession}
          onOpenImageStudio={onOpenImageStudio}
        />
      </div>
      <SidebarAccountFooter
        onOpenAccount={onOpenSettings}
        onOpenSettings={onOpenSettings}
        onShowWorkspacePanel={onShowWorkspacePanel}
      />


      {wsContextMenu && (() => {
        const ctxKey = workspaceKey(wsContextMenu.path);
        const ctxIsSpace = !!modeHomes?.work && ctxKey === workspaceKey(modeHomes.work);
        const wsItems: ContextMenuItem[] = [
          ...(onCreateSessionInWorkspace ? [{ id: 'new', label: isZh ? '新建会话' : 'New chat', icon: <IconChat size={15} />, onClick: () => { onCreateSessionInWorkspace(wsContextMenu.path); setWsContextMenu(null); } }] : []),
          ...(onRenameWorkspace && !ctxIsSpace ? [{ id: 'rename-ws', label: isZh ? '重命名工作区' : 'Rename workspace', icon: <IconPencil size={15} />, onClick: () => { setWsEditingPath(wsContextMenu.path); setWsEditValue(wsContextMenu.name); setWsContextMenu(null); } }] : []),
          { id: 'collapse-all', label: isZh ? '折叠所有会话' : 'Collapse all chats', icon: <IconCollapseAll size={15} />, onClick: () => { const next = { ...collapsed }; groups.forEach(g => { next[g.path] = true; }); setCollapsed(next); saveCollapsed(next); setWsContextMenu(null); } },
          { separator: true },
          { id: 'copy-path', label: isZh ? '复制路径' : 'Copy path', icon: <IconCopy size={15} />, onClick: () => { void copyToClipboard(wsContextMenu.path); setWsContextMenu(null); } },
          { id: 'open-finder', label: revealInFileManagerLabel(isZh), icon: <IconFolder size={15} />, onClick: () => { (window as any).neox?.openExternal?.(`file://${wsContextMenu.path}`); setWsContextMenu(null); } },
          ...(onShowWorkspacePanel ? [{ id: 'show-roots', label: isZh ? '编辑工作区 (项目列表)' : 'Edit workspace (projects)', icon: <IconLayers size={15} />, onClick: () => { onShowWorkspacePanel(wsContextMenu.path || undefined); setWsContextMenu(null); } }] : []),
          ...(!wsContextMenu.isActive && !ctxIsSpace ? [
            { separator: true } as ContextMenuItem,
            { id: 'remove', label: isZh ? '从侧栏移除' : 'Remove from sidebar', icon: <IconTrash size={15} />, destructive: true, onClick: () => { const grp = groups.find(g => g.path === wsContextMenu.path); if (grp) hideSessionIds(grp.sessions.map(s => s.id)); onRemoveWorkspace?.(wsContextMenu.path); setWsContextMenu(null); } },
          ] : []),
        ];
        return <ContextMenu position={{ x: wsContextMenu.x, y: wsContextMenu.y }} items={wsItems} onClose={() => setWsContextMenu(null)} />;
      })()}
      {contextMenu && (() => {
        const cur = data.find((x) => x.id === contextMenu.id);
        const loc = cur?.cloudLocation;
        const isBusy = loc === 'migrating' || loc === 'syncing-back';
        const sessionItems: ContextMenuItem[] = [
          ...(isBusy ? [{ id: 'cloud-busy', label: isZh ? '迁移中…' : 'Migrating…', disabled: true }] : []),
          ...((!loc || loc === 'local') && onPushSessionToCloud && cloudAgentAvailable ? [{ id: 'push', label: isZh ? '推到云端继续' : 'Continue in cloud', icon: <IconCloudUp size={15} />, onClick: () => { onPushSessionToCloud(contextMenu.id); setContextMenu(null); } }] : []),
          ...(loc === 'cloud' && onPullSessionToLocal ? [{ id: 'pull', label: isZh ? '拉回本机' : 'Pull back locally', icon: <IconCloudDown size={15} />, onClick: () => { onPullSessionToLocal(contextMenu.id); setContextMenu(null); } }] : []),
          ...((onPushSessionToCloud || onPullSessionToLocal || isBusy) ? [{ separator: true } as ContextMenuItem] : []),
          ...(onRenameSession ? [{ id: 'rename', label: isZh ? '重命名' : 'Rename', shortcut: 'F2', icon: <IconPencil size={15} />, onClick: () => { setEditingId(contextMenu.id); setEditValue(cur?.title ?? ''); setContextMenu(null); } }] : []),
          ...(onMoveSessionToWorkspace && cur && !cur.cloudOnly && cur.kind !== 'image'
            && (cur.effectiveMode ?? cur.agentMode ?? 'code') === 'code' ? (() => {
            const moveItems: ContextMenuItem[] = [];
            /* 工作目录不作为编码会话的目标 */
            const seen = new Set<string>();
            if (modeHomes?.work) seen.add(modeHomes.work);
            const wsList: Array<{ path: string; name: string }> = [];
            if (currentWorkspace?.path && !seen.has(currentWorkspace.path)) {
              seen.add(currentWorkspace.path);
              wsList.push({ path: currentWorkspace.path, name: displayWorkspaceName(currentWorkspace.path, currentWorkspace.name, isZh) });
            }
            for (const w of recentWorkspaces ?? []) {
              if (!w.path || seen.has(w.path)) continue;
              seen.add(w.path);
              wsList.push({ path: w.path, name: displayWorkspaceName(w.path, w.name, isZh) });
              if (wsList.length >= 8) break; /* 菜单别无限长 — 最近 8 个够覆盖常用 */
            }
            const targets = wsList.filter((w) => !sameWorkspace(w.path, cur.workspacePath));
            if (targets.length === 0) return [];
            for (const w of targets) {
              moveItems.push({
                id: `move-ws-${w.path}`,
                label: w.name,
                icon: <IconFolder size={14} />,
                onClick: () => { onMoveSessionToWorkspace(contextMenu.id, { path: w.path }); setContextMenu(null); },
              });
            }
            return [{
              id: 'move-to',
              label: isZh ? '移动到文件夹…' : 'Move to folder…',
              icon: <IconFolder size={15} />,
              submenu: moveItems,
            } as ContextMenuItem];
          })() : []),
          ...(onExportSession ? [{ id: 'export', label: isZh ? '导出 Markdown' : 'Export Markdown', icon: <IconExport size={15} />, onClick: () => { onExportSession(contextMenu.id); setContextMenu(null); } }] : []),
          { id: 'copy-id', label: isZh ? '复制会话 ID' : 'Copy chat ID', icon: <IconCopy size={15} />, onClick: () => {
            const id = contextMenu.id;
            setContextMenu(null);
            void copyToClipboard(id).then(
              () => dispatchHint(isZh ? '已复制会话 ID' : 'Chat ID copied', 'success'),
              (err) => dispatchHint(
                isZh ? `复制失败: ${err?.message ?? err}` : `Copy failed: ${err?.message ?? err}`,
                'warning',
              ),
            );
          } },
          ...(onDeleteSession ? [
            { separator: true } as ContextMenuItem,
            { id: 'delete', label: isZh ? '删除' : 'Delete', destructive: true, icon: <IconTrash size={15} />, onClick: () => { const title = cur?.title ?? contextMenu.id; setContextMenu(null); void requestDeleteSession(contextMenu.id, title); } },
          ] : []),
        ];
        return <ContextMenu position={{ x: contextMenu.x, y: contextMenu.y }} items={sessionItems} onClose={() => setContextMenu(null)} />;
      })()}
    </aside>
  );
};

/* 右键菜单: 已迁移到 ContextMenu 组件 (Portal 渲染, 视口检测, 键盘导航) */

export const Sidebar = React.memo(SidebarImpl);
Sidebar.displayName = 'Sidebar';

export default Sidebar;
