import React, { useState, useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import TopBar from './TopBar';
import { useTopBarSlotOccupant } from './TopBarSlot';
import IconRail, { type RailKey } from './IconRail';
import Sidebar, { type SessionItem } from './Sidebar';
import { type RightPanelProps } from './RightPanel';
import TaskDetailPopover from './TaskDetailPopover';
import {
  ShellResizer,
  computeRightMaxForViewport,
  computeSidebarMaxForViewport,
  readSidebarWidth,
  readRightWidth,
  SIDEBAR_DEFAULT,
  RESIZER_STORAGE_KEY_SIDEBAR,
  RESIZER_STORAGE_KEY_RIGHT,
} from './ShellResizer';
import { shellPerf } from '../../perf/shellPerf';
import { getGlobalLanguage } from '../../hooks/useI18n';
import { usePanelLayout, useActivePanelTab } from '../../state/panelLayoutStore';
import { useSurfaceAutoFloat } from './useSurfaceAutoFloat';
import SurfaceFloatFrame from './SurfaceFloatFrame';
import './clay-studio.css';

/* ============================================================
 * NeoxShell — 5 区 grid 主容器
 *
 *   ┌─────────────────────────────────────┐ topbar
 *   ├──┬──────┬─────────────────┬────────┤
 *   │Ra│ Side │      Main       │ Right  │
 *   │il│      │  (children)     │ Panel  │
 *   └──┴──────┴─────────────────┴────────┘
 *
 *   - 只负责布局 + 左轨/顶部/侧栏/右栏的组装
 *   - main 区的内容由调用方通过 children 传入
 *   - 左轨的 activeKey 由调用方控制 (完全可控), 不给默认 state
 * ============================================================ */

/* ============================================================
 * Shell 内置 loading 骨架 — 替代旧的"Loading workspace"暗色弹层
 *   · 顶部细进度条 (indeterminate 滑动)
 *   · 主区出消息流 + composer 骨架
 *   · 不阻塞 sidebar / right panel — 它们各自渲染真实数据(可能为空也没事)
 * ============================================================ */
const ShellLoadingSkeleton: React.FC = () => {
  return (
    <div className="neox-shell__loading" aria-live="polite" aria-busy="true">
      <div className="neox-shell__loading-bar">
        <div className="neox-shell__loading-bar__inner" />
      </div>
      <div className="neox-shell__loading-stage">
        <span className="neox-shell__loading-spinner" aria-hidden="true" />
        <span>{getGlobalLanguage() === 'zh' ? '正在打开工作空间' : 'Opening workspace'}</span>
        <span className="neox-shell__loading-dots" aria-hidden="true">
          <span>.</span><span>.</span><span>.</span>
        </span>
      </div>
      <div className="neox-shell__loading-body">
        <div className="neox-shell__skel-row" style={{ width: '38%' }} />
        <div className="neox-shell__skel-row" style={{ width: '72%' }} />
        <div className="neox-shell__skel-msg">
          <div className="neox-shell__skel-avatar" />
          <div className="neox-shell__skel-msg-body">
            <div className="neox-shell__skel-row" style={{ width: '54%' }} />
            <div className="neox-shell__skel-row" style={{ width: '88%' }} />
          </div>
        </div>
        <div className="neox-shell__skel-msg">
          <div className="neox-shell__skel-avatar" />
          <div className="neox-shell__skel-msg-body">
            <div className="neox-shell__skel-row" style={{ width: '46%' }} />
          </div>
        </div>
        <div className="neox-shell__skel-msg">
          <div className="neox-shell__skel-avatar" />
          <div className="neox-shell__skel-msg-body">
            <div className="neox-shell__skel-row" style={{ width: '64%' }} />
            <div className="neox-shell__skel-row" style={{ width: '40%' }} />
          </div>
        </div>
        <div className="neox-shell__skel-composer">
          <div className="neox-shell__skel-row" style={{ width: '34%', height: 12 }} />
          <div className="neox-shell__skel-row" style={{ width: '90%', height: 14 }} />
        </div>
      </div>
    </div>
  );
};

export interface NeoxShellProps {
  /** 工作区切换/打开过程中渲染骨架占位, sidebar/right 仍照常渲染. */
  loading?: boolean;
  /** 当前激活的左轨项 */
  activeNav: RailKey;
  onChangeNav: (key: RailKey) => void;

  /** 顶栏 title (通常是 workspace 名) */
  title?: string;
  /** 顶栏中间的标题 (会话名 / 当前页名) */
  workTitle?: string;
  onOpenSettings?: () => void;
  onToggleTheme?: () => void;

  agentMode?: 'work' | 'code' | 'pilot' | null;

  /** 侧栏会话 */
  sessions?: SessionItem[];
  /** 首次会话加载是否仍 inflight. Sidebar 据此决定显示骨架行还是真实"无会话"空状态. */
  sessionsLoading?: boolean;
  activeSessionId?: string | null;
  /** active session 是否流式中. Sidebar SessionRow 据此显 "进行中" 高亮.
   *  从 runtime.streaming 透传, **不打进 SessionItem** — 避免 streaming chunk 抖动整列. */
  streaming?: boolean;
  /** per-session 运行态 — Sidebar 用来给"切走的会话"也显示转圈. */
  runningSessionIds?: ReadonlySet<string>;
  onNewSession?: () => void;
  /** Sidebar "+ 新建任务 ▼" caret 菜单 → "在云端新建". undefined 时 caret 不渲染. */
  onNewCloudSession?: () => void;
  onSelectSession?: (id: string) => void;
  onRenameSession?: (id: string, name: string) => void;
  onDeleteSession?: (id: string) => void;
  onExportSession?: (id: string) => void;
  onPushSessionToCloud?: (id: string) => void;
  onPullSessionToLocal?: (id: string) => void;

  /** 当前生效模式 — Work / Code 两个会话池严格隔离, 侧栏只列这一池 */
  currentAgentMode?: 'work' | 'code' | 'pilot';
  /** 右键"移动到文件夹…" (仅 Code 会话) — 只改会话 workspacePath 标签 */
  onMoveSessionToWorkspace?: (id: string, target: { path: string }) => void;
  modeHomes?: { work?: string };

  /** 多工作区分组 — 当前工作区 / 最近列表 / 切换 / 添加 / 移除 / 管理 */
  currentWorkspace?: { path: string; name: string; roots?: string[] };
  recentWorkspaces?: Array<{ path: string; name: string; roots?: string[] }>;
  onSelectWorkspace?: (path: string, opts?: { silent?: boolean }) => void;
  onAddWorkspace?: () => void;
  onRemoveWorkspace?: (path: string) => void;
  onRenameWorkspace?: (path: string, newName: string) => void;
  onShowWorkspacePanel?: () => void;
  onCreateSessionInWorkspace?: (path: string) => void;
  onManageWorkspaces?: () => void;
  onOpenKnowledgeBase?: () => void;
  onOpenSkills?: () => void;
  onOpenMcp?: () => void;
  onOpenLibrary?: () => void;
  onOpenTeam?: () => void;
  onOpenImageStudio?: () => void;
  onOpenFileExplorer?: () => void;
  onNewImageSession?: () => void;
  onOpenPlugins?: () => void;
  onOpenTools?: () => void;
  activeUtility?: 'knowledge' | 'library' | 'image' | 'team' | 'plugins' | 'skills' | 'mcp' | null;

  /** 完全替换默认 sessions Sidebar (文件树 / Git / 工作区面板) */
  sidebarOverride?: ReactNode;

  /** 右栏 override */
  rightPanel?: Partial<RightPanelProps> | ReactNode;

  /** 右栏折叠控制 */
  rightPanelCollapsed?: boolean;
  onToggleRightPanel?: () => void;

  /** 左侧 sessions sidebar 折叠 */
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;

  fullPage?: boolean;

  /** 重页面切换/右栏展开时使用瞬时布局提交，避免 grid 列宽动画拖着 Monaco/Timeline 重排掉帧。 */
  layoutInstant?: boolean;

  /** TopBar 右侧操作 — 由调用方决定怎么响应 (帮助 / 通知按钮都自管 dropdown 不需暴露) */
  onSearch?: () => void;
  /** 头像菜单「我的账户」点击 — 应跳设置页 Account tab */
  onOpenAccount?: () => void;

  /** 主内容 */
  children: ReactNode;
}

const isRightPanelNode = (x: unknown): x is ReactNode => {
  return React.isValidElement(x) || typeof x === 'string' || typeof x === 'number';
};

type RightSurfaceMotion = 'closed' | 'opening' | 'open' | 'closing';
const RIGHT_SURFACE_MOTION_MS = 260;
type SidebarMotion = 'closed' | 'opening' | 'open' | 'closing';
const SIDEBAR_MOTION_MS = 260;

const NeoxShellImpl: React.FC<NeoxShellProps> = ({
  fullPage = false,
  activeNav,
  onChangeNav,
  title,
  workTitle,
  onOpenSettings,
  onToggleTheme,
  agentMode,
  sessions,
  sessionsLoading = false,
  activeSessionId,
  streaming = false,
  runningSessionIds,
  onNewSession,
  onNewCloudSession,
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
  onSelectWorkspace,
  onAddWorkspace,
  onRemoveWorkspace,
  onRenameWorkspace,
  onShowWorkspacePanel,
  onCreateSessionInWorkspace,
  onManageWorkspaces,
  onOpenKnowledgeBase,
  onOpenSkills,
  onOpenMcp,
  onOpenLibrary,
  onOpenTeam,
  onOpenImageStudio,
  onOpenFileExplorer,
  onNewImageSession,
  onOpenPlugins,
  onOpenTools,
  activeUtility,
  sidebarOverride,
  rightPanel,
  rightPanelCollapsed = false,
  onToggleRightPanel,
  sidebarCollapsed = false,
  onToggleSidebar,
  layoutInstant = false,
  onSearch,
  onOpenAccount,
  loading,
  children,
}) => {
  /* 用户拖动出来的列宽 (CSS var 覆盖) — sidebar/right 各自持久化, 启动从 localStorage 读.
   * null = 未拖动过, 让 CSS 默认值 (var(--neox-sidebar-width) clamp(280,25vw,480) / right clamp(420,50vw,900)) 生效. */
  const [sidebarW, setSidebarW] = useState<number | null>(() => readSidebarWidth());
  const [rightW, setRightW] = useState<number | null>(() => readRightWidth());
  /* inline 写一个"user override" var, CSS 那边 default 用 var(--*-user, calc(...)) fallback —
   *   旧实现直接覆盖 --neox-sidebar-width / --neox-rightpanel-width 本身, 优先级永远赢, default
   *   calc 1:1 / 1:2:2 永远不会生效. 现在拆开: 没拖时 user var 不存在 fallback 到 default. */
  const rootStyle: React.CSSProperties & Record<string, string> = {};
  if (sidebarW !== null) rootStyle['--neox-shell-sidebar-user'] = `${sidebarW}px`;
  if (rightW !== null) rootStyle['--neox-shell-right-user'] = `${rightW}px`;
  if (fullPage) {
    rootStyle['--neox-rail-width'] = '0px';
    rootStyle['--neox-sidebar-width'] = '0px';
  }
  const sidebarVisible = !sidebarCollapsed;
  /* panelLayout 必须在这儿就拿到 —— rightPanelVisible 要用它 (见下一行的说明)。
   * 原来它声明在三十行之后, 跟 panelTab 放在一起。 */
  const storedPanelLayout = usePanelLayout();
  const surfaceSqueezedOut = useSurfaceAutoFloat(storedPanelLayout === 'split' || storedPanelLayout === 'swap', sidebarW, sidebarCollapsed);
  const panelLayout = storedPanelLayout;
  const rightPanelVisible = !fullPage && !surfaceSqueezedOut && (panelLayout === 'tabs' || !rightPanelCollapsed);
  const showSidebarResizer = sidebarVisible;
  const rootRef = useRef<HTMLDivElement>(null);
  const sidebarWRef = useRef<number | null>(sidebarW);
  const rightWRef = useRef<number | null>(rightW);
  const [sidebarMotion, setSidebarMotion] = useState<SidebarMotion>(() => (
    sidebarVisible ? 'open' : 'closed'
  ));
  const [rightSurfaceMotion, setRightSurfaceMotion] = useState<RightSurfaceMotion>(() => (
    rightPanelVisible ? 'open' : 'closed'
  ));
  const effectiveSidebarMotion: SidebarMotion = sidebarVisible
    ? (sidebarMotion === 'closing' || sidebarMotion === 'closed' ? 'opening' : sidebarMotion)
    : (sidebarMotion === 'opening' || sidebarMotion === 'open' ? 'closing' : sidebarMotion);
  const effectiveRightSurfaceMotion: RightSurfaceMotion = rightPanelVisible
    ? (rightSurfaceMotion === 'closing' || rightSurfaceMotion === 'closed' ? 'opening' : rightSurfaceMotion)
    : (rightSurfaceMotion === 'opening' || rightSurfaceMotion === 'open' ? 'closing' : rightSurfaceMotion);
  const panelTab = useActivePanelTab();
  const hasHoistedTabs = useTopBarSlotOccupant() !== null;
  const sidebarLayoutCollapsed = sidebarCollapsed;
  const sidebarContentMounted = sidebarVisible || effectiveSidebarMotion !== 'closed';
  const rightPanelLayoutVisible = rightPanelVisible || rightSurfaceMotion !== 'closed';
  /* 悬浮版面 Surface 是浮层, 没有列边可拖 —— 拉伸走浮层自己的右下角 */
  const showRightResizer = rightPanelVisible && panelLayout !== 'tabs' && panelLayout !== 'float';
  sidebarWRef.current = sidebarW;
  rightWRef.current = rightW;

  useLayoutEffect(() => {
    const reduceMotion =
      typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (sidebarVisible) {
      setSidebarMotion((prev) => (prev === 'open' ? 'open' : 'opening'));
      if (reduceMotion) {
        setSidebarMotion('open');
        return;
      }
      const timer = window.setTimeout(() => setSidebarMotion('open'), SIDEBAR_MOTION_MS);
      return () => window.clearTimeout(timer);
    }

    setSidebarMotion((prev) => (prev === 'closed' ? 'closed' : 'closing'));
    if (reduceMotion) {
      setSidebarMotion('closed');
      return;
    }
    const timer = window.setTimeout(() => setSidebarMotion('closed'), SIDEBAR_MOTION_MS);
    return () => window.clearTimeout(timer);
  }, [sidebarVisible]);

  useLayoutEffect(() => {
    const reduceMotion =
      typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (rightPanelVisible) {
      setRightSurfaceMotion((prev) => (prev === 'open' ? 'open' : 'opening'));
      if (reduceMotion) {
        setRightSurfaceMotion('open');
        return;
      }
      const timer = window.setTimeout(() => setRightSurfaceMotion('open'), RIGHT_SURFACE_MOTION_MS);
      return () => window.clearTimeout(timer);
    }

    setRightSurfaceMotion((prev) => (prev === 'closed' ? 'closed' : 'closing'));
    if (reduceMotion) {
      setRightSurfaceMotion('closed');
      return;
    }
    const timer = window.setTimeout(() => setRightSurfaceMotion('closed'), RIGHT_SURFACE_MOTION_MS);
    return () => window.clearTimeout(timer);
  }, [rightPanelVisible]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === 'undefined') return;
    let count = 0;
    let raf = 0;
    const observer = new ResizeObserver((entries) => {
      count += entries.length;
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        if (count > 1) {
          shellPerf.mark('shell-resize-observer-batch', {
            count,
            rightPanelCollapsed,
            sidebarCollapsed,
          });
        }
        count = 0;
      });
    });
    observer.observe(root);
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [rightPanelCollapsed, sidebarCollapsed]);


  /* window resize 时把已保存的列宽 clamp 回合法范围。
   * 关键优化:
   *   1. ref 读最新 width, listener 不因 sidebarW/rightW 变化反复重挂。
   *   2. rAF 合并同帧多个 resize 事件, 一帧最多一次 setState/clamp。
   *   3. resize 进行期间给 .neox-shell 挂 .is-resizing → shell.css 里 `.is-resizing *`
   *      规则瞬间杀掉所有 transition (尤其要命的 `grid-template-columns 320ms`)。
   *      去掉这条动画后, 拖窗口 grid 直接吃新的列宽, 不再每帧插值 → 60fps 拖动。
   *      最后一次 resize 事件后 120ms 清掉 class, 让正常 layout 动画恢复。 */
  useEffect(() => {
    if (typeof window === 'undefined') return;
    let raf = 0;
    let stopTimer: number | null = null;
    let eventCount = 0;
    let resizingClassOn = false;
    let resizeSamplerOn = false;
    const setResizingClass = (on: boolean) => {
      const root = rootRef.current;
      if (!root || on === resizingClassOn) return;
      resizingClassOn = on;
      root.classList.toggle('is-resizing', on);
      root.classList.toggle('is-window-resizing', on);
    };
    const clampWidths = () => {
      const start = performance.now();
      const currentSidebarW = sidebarWRef.current;
      const currentRightW = rightWRef.current;
      const currentRight = showRightResizer ? (currentRightW ?? 600) : 0;
      const currentSidebar = sidebarCollapsed ? 0 : (currentSidebarW ?? 360);
      const sidebarCap = computeSidebarMaxForViewport(currentRight);
      const nextSidebar = currentSidebarW !== null && currentSidebarW > sidebarCap ? sidebarCap : currentSidebarW;
      const rightCap = computeRightMaxForViewport(Math.min(currentSidebar, sidebarCap));
      const nextRight = currentRightW !== null && currentRightW > rightCap ? rightCap : currentRightW;
      if (nextSidebar !== currentSidebarW) setSidebarW(nextSidebar);
      if (nextRight !== currentRightW) setRightW(nextRight);
      const cost = performance.now() - start;
      if (eventCount > 2 || cost > 4 || nextSidebar !== currentSidebarW || nextRight !== currentRightW) {
        shellPerf.mark('shell-window-resize-clamp', {
          events: eventCount,
          cost: Number(cost.toFixed(2)),
          sidebarCap,
          rightCap,
          sidebarChanged: nextSidebar !== currentSidebarW,
          rightChanged: nextRight !== currentRightW,
        });
      }
    };
    const flushResizeClamp = () => {
      raf = 0;
      clampWidths();
      eventCount = 0;
    };
    const scheduleResizingOff = () => {
      if (stopTimer !== null) window.clearTimeout(stopTimer);
      stopTimer = window.setTimeout(() => {
        stopTimer = null;
        setResizingClass(false);
        if (resizeSamplerOn) {
          resizeSamplerOn = false;
          shellPerf.stopSampler('window-resize-settled', {
            rightPanelCollapsed,
            sidebarCollapsed,
          });
        }
      }, 260);
    };
    const onResize = () => {
      eventCount += 1;
      if (!resizeSamplerOn) {
        resizeSamplerOn = true;
        shellPerf.startSampler('window-resize', {
          rightPanelCollapsed,
          sidebarCollapsed,
        });
      }
      if (!resizingClassOn) setResizingClass(true);
      scheduleResizingOff();
      if (raf) return;
      raf = window.requestAnimationFrame(flushResizeClamp);
    };
    window.addEventListener('resize', onResize, { passive: true });
    /* mount 时直接同步 clamp 一次, 不进 resize 流水线 (不挂 .is-resizing). */
    clampWidths();
    return () => {
      window.removeEventListener('resize', onResize);
      if (raf) window.cancelAnimationFrame(raf);
      if (stopTimer !== null) window.clearTimeout(stopTimer);
      if (resizeSamplerOn) shellPerf.stopSampler('window-resize-cleanup');
      setResizingClass(false);
    };
  }, [sidebarCollapsed, showRightResizer]);

  const layoutResetSkipRef = useRef(true);
  useEffect(() => {
    if (layoutResetSkipRef.current) {
      layoutResetSkipRef.current = false;
      return;
    }
    if (
      sidebarMotion === 'opening'
      || sidebarMotion === 'closing'
      || rightSurfaceMotion === 'opening'
      || rightSurfaceMotion === 'closing'
    ) {
      return;
    }
    if (sidebarW !== null) setSidebarW(null);
    if (rightW !== null) setRightW(null);
    try {
      window.localStorage.removeItem(RESIZER_STORAGE_KEY_SIDEBAR);
      window.localStorage.removeItem(RESIZER_STORAGE_KEY_RIGHT);
    } catch { /* ignore */ }
    /* 依赖只看 layout 拓扑与 motion 稳态, 不看 sidebarW/rightW 避免循环。
     * opening/closing 期间不 reset 拖拽宽度, 避免动画中插入额外重排。 */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sidebarLayoutCollapsed, rightPanelLayoutVisible, sidebarMotion, rightSurfaceMotion]);

  /* 布局自适应 hint 已移除 — 不再弹 toast 打扰用户. */

  return (
    <div
      ref={rootRef}
      className={`neox-shell${sidebarLayoutCollapsed ? ' is-sidebar-collapsed' : ''}${rightPanelLayoutVisible ? ' has-surface' : ''}${layoutInstant ? ' is-layout-instant' : ''}${fullPage ? ' is-fullpage' : ''}${hasHoistedTabs ? ' has-hoisted-tabs' : ''}${agentMode === 'pilot' ? ' is-pilot' : ''}`}
      /* 版面 (timeline / Surface 谁在左谁在右, 或者只留一个) —— 交换靠 CSS 改
         grid-column, 组件树一动不动 (见 panelLayoutStore 的说明)。 */
      data-panel-layout={panelLayout}
      data-panel-tab={panelLayout === 'tabs' ? panelTab : undefined}
      data-sidebar-motion={effectiveSidebarMotion}
      style={rootStyle}
    >
      <TopBar
        title={title}
        workTitle={workTitle}
        agentMode={agentMode}
        rightPanelCollapsed={rightPanelCollapsed}
        onToggleRightPanel={onToggleRightPanel}
        onSearch={onSearch}
        onOpenAccount={onOpenAccount}
        onOpenSettings={onOpenSettings}
        onShowWorkspacePanel={onShowWorkspacePanel}
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={onToggleSidebar}
        onGoHome={onManageWorkspaces}
        onNewSession={onNewSession}
      />
      <div className="neox-shell__glass-card">
        <IconRail
          activeKey={activeNav}
          onSelect={onChangeNav}
          onOpenSettings={onOpenSettings}
          onToggleTheme={onToggleTheme}
        />
        {!sidebarContentMounted ? (
          <aside className="neox-sidebar neox-shell__sidebar neox-sidebar--placeholder" data-motion="closed" aria-hidden="true" />
        ) : sidebarOverride
          ? <aside className="neox-sidebar neox-shell__sidebar neox-sidebar--ide" data-motion={effectiveSidebarMotion} style={{ padding: 0, display: 'flex', flexDirection: 'column' }}>{sidebarOverride}</aside>
          : (
          <Sidebar
            motion={effectiveSidebarMotion}
            sessions={sessions}
            sessionsLoading={sessionsLoading}
            activeSessionId={activeSessionId}
            streaming={streaming}
            runningSessionIds={runningSessionIds}
            onNewSession={onNewSession}
            onNewCloudSession={onNewCloudSession}
            onSelectSession={onSelectSession}
            onRenameSession={onRenameSession}
            onDeleteSession={onDeleteSession}
            onExportSession={onExportSession}
            onPushSessionToCloud={onPushSessionToCloud}
            onPullSessionToLocal={onPullSessionToLocal}
            currentAgentMode={currentAgentMode}
            onMoveSessionToWorkspace={onMoveSessionToWorkspace}
            modeHomes={modeHomes}
            onOpenPlugins={onOpenPlugins}
            onOpenTools={onOpenTools}
            onOpenSettings={onOpenSettings}
            currentWorkspace={currentWorkspace}
            recentWorkspaces={recentWorkspaces}
            onSelectWorkspace={onSelectWorkspace}
            onAddWorkspace={onAddWorkspace}
            onRemoveWorkspace={onRemoveWorkspace}
            onRenameWorkspace={onRenameWorkspace}
            onShowWorkspacePanel={onShowWorkspacePanel}
            onCreateSessionInWorkspace={onCreateSessionInWorkspace}
            onManageWorkspaces={onManageWorkspaces}
            onOpenKnowledgeBase={onOpenKnowledgeBase}
            onSearch={onSearch}
            onOpenSkills={onOpenSkills}
            onOpenMcp={onOpenMcp}
            onOpenLibrary={onOpenLibrary}
            onOpenTeam={onOpenTeam}
            onOpenImageStudio={onOpenImageStudio}
            onOpenFileExplorer={onOpenFileExplorer}
            onNewImageSession={onNewImageSession}
            activeUtility={activeUtility}
          />
        )}
        <main className="neox-shell__main">
          {loading ? <ShellLoadingSkeleton /> : children}
        </main>
        {/* 右栏 = Surface 系统(产出物画布/浏览器/图表/...). 外部传 rightPanel 节点 (SurfacePanel);
         *   收起时 grid-template-columns 右列塌缩为 0, 不占空间. */}
        <div
          className="neox-shell__right neox-shell__right--surface-slot"
          data-motion={effectiveRightSurfaceMotion}
        >
          {isRightPanelNode(rightPanel) ? rightPanel : null}
          {panelLayout === 'float' && rightPanelVisible && (
            <SurfaceFloatFrame rootRef={rootRef} zh={getGlobalLanguage() === 'zh'} />
          )}
        </div>

        {/* 列宽 splitter 放进真实白雾卡片内，位置和裁剪都以卡片为准。 */}
        {showSidebarResizer && (
          <ShellResizer
            side="sidebar"
            width={sidebarW ?? SIDEBAR_DEFAULT}
            onChange={setSidebarW}
            getDynamicMax={() => {
              if (!showRightResizer) return computeSidebarMaxForViewport(0);
              const el = rootRef.current?.querySelector('.neox-shell__right');
              const measured = el instanceof HTMLElement ? el.getBoundingClientRect().width : NaN;
              return computeSidebarMaxForViewport(
                Number.isFinite(measured) && measured > 0 ? measured : (rightW ?? 600),
              );
            }}
          />
        )}
        {showRightResizer && (
          <ShellResizer
            side="right"
            width={rightW ?? 600}
            onChange={setRightW}
            inverted={panelLayout === 'swap'}
            getDynamicMax={() => {
              if (sidebarCollapsed) return computeRightMaxForViewport(0);
              const el = rootRef.current?.querySelector('.neox-shell__sidebar');
              const measured = el instanceof HTMLElement ? el.getBoundingClientRect().width : NaN;
              return computeRightMaxForViewport(
                Number.isFinite(measured) && measured > 0 ? measured : (sidebarW ?? SIDEBAR_DEFAULT),
              );
            }}
          />
        )}
      </div>

      <TaskDetailPopover {...(isRightPanelNode(rightPanel) ? {} : ((rightPanel as Partial<RightPanelProps>) ?? {}))} />
    </div>
  );
};

/* ============================================================
 * NeoxShellAuto — 带内置 activeNav state 的懒人包装
 *   调用方只关心 children / session / onNewSession, 不想管左轨
 * ============================================================ */

export const NeoxShell = React.memo(NeoxShellImpl);
NeoxShell.displayName = 'NeoxShell';

export const NeoxShellAuto: React.FC<Omit<NeoxShellProps, 'activeNav' | 'onChangeNav'> & {
  defaultNav?: RailKey;
}> = ({ defaultNav = 'home', ...rest }) => {
  const [activeNav, setActiveNav] = useState<RailKey>(defaultNav);
  const handleChange = useCallback((k: RailKey) => setActiveNav(k), []);
  return (
    <NeoxShell
      {...rest}
      activeNav={activeNav}
      onChangeNav={handleChange}
    />
  );
};

export default NeoxShell;
