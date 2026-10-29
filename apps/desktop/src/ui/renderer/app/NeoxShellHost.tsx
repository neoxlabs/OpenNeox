import { loadExternalAgentTools } from '../modules/agent-timeline/externalAgentTools';
import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ProfilerOnRenderCallback } from 'react';
import { requireStreamEventSession } from './streamEventSession';
import NeoxShell from '../modules/shell/NeoxShell';
import { type RailKey } from '../modules/shell/IconRail';
import type { SessionItem } from '../modules/shell/Sidebar';
import AgentTimelineView from '../modules/agent-timeline/AgentTimelineView';
import IdeFileSidebar from '../modules/ide-workspace/IdeFileSidebar';
import { directImageTurnCount } from '../modules/agent-timeline/DirectImageTurns';

const KnowledgeBasePage = React.lazy(() => import('../modules/knowledge-base/KnowledgeBasePage'));
const LibraryPage = React.lazy(() => import('../modules/library/LibraryPage'));
const WorkProjectsPage = React.lazy(() => import('../modules/work-projects/WorkProjectsPage'));
const WorkProjectPage = React.lazy(() => import('../modules/work-projects/WorkProjectPage'));
/* 技能 / MCP 页复用 SettingsPage 的 embedded 模式 —— 见下方 agentPage 分支的说明 */
const SettingsPageLazy = React.lazy(() => import('../pages/settings/SettingsPage'));
import { useSettingsPageNav } from './useSettingsPageNav';
import { useStableSessionItems, useSidebarSessionItems } from './stableSessionItems';
import { useEvent } from './useEvent';
import { ToolBackLabelContext, ToolBackButton } from '../components/ToolPage';

if (typeof window !== 'undefined') {
  const prefetch = () => {
    for (const load of [
      () => import('../pages/settings/SettingsPage'),
      () => import('../pages/team/TeamDashboard'),
      () => import('../modules/image-studio/ImageStudioPage'),
      () => import('../pages/plugins/PluginMarketplace'),
      () => import('../modules/knowledge-base/KnowledgeBasePage'),
      () => import('../modules/library/LibraryPage'),
    ]) void load().catch(() => { /* 预取失败无所谓 —— 回到原来的"点开再拉" */ });
  };
  const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
  if (ric) ric(prefetch, { timeout: 8000 });
  else setTimeout(prefetch, 5000);
}
const ImageStudioPage = React.lazy(() =>
  import('../modules/image-studio/ImageStudioPage').then((m) => ({ default: m.ImageStudioPage })),
);
const TeamDashboard = React.lazy(() => import('../pages/team/TeamDashboard'));
const PluginMarketplace = React.lazy(() => import('../pages/plugins/PluginMarketplace'));
const ToolsHome = React.lazy(() => import('../pages/tools/ToolsHome'));

import { AgentGitSidebar } from '../modules/shell/AgentSidePanels';
import TerminalRequestManager from '../modules/terminal/components/TerminalRequestManager';
import DiagnosticsRequestManager from '../modules/editor/DiagnosticsRequestManager';
import NeoxRuntimeBridge from './NeoxRuntimeBridge';
import { displaySessionName } from '../state/sessionDisplayName';
import { getGlobalLanguage } from '../hooks/useI18n';
import { setWorkProjectFilter } from '../modules/shell/workProjects';
import { formatSessionTime, mapSessionToItem, isOrphanSubAgentPlaceholder, isNeverRunCloudShell } from './sessionItemMapping';
import { useNeoxRuntime } from './NeoxRuntimeContext';
import { useAgentModeVariant, isDefaultSessionName } from '../hooks/useAgentModeVariant';
import { useSessionActions } from '../../state/sessionStore';
import { normalizeAgentMode, resolveEffectiveAgentMode, type AgentModeValue } from './modeWorkspaceBinding';
import { usePetAgentForwarder } from '../modules/pet';
import {
  useCloudSessions,
  migrationStateToCloudLocation,
  type CloudSessionSummary,
} from '../modules/shell/useCloudSessions';
import { dispatchHint, dispatchOpFailed, dispatchOpFailedFromError } from '../components/notifyEvents';
import { confirmAsync } from '../components/confirmEvents';
import TourOverlay from '../components/TourOverlay';
import { isKnowledgeCurationEnabled } from '../modules/knowledge-base/curationAvailability';
import { CloudMigrationDialog, type MigrationMode } from '../modules/agent-timeline/CloudMigrationDialog';
import { CloudGitConfigDialog, type GitConfig } from '../modules/agent-timeline/CloudGitConfigDialog';
import type { WorkspaceAnalysisRenderer } from '../modules/shell/useCloudSessions';
/* 云端运行 / 登录走发行版能力钩子与插槽 —— 公开构建里云端能力恒关、没有登录弹窗 */
import { getEditionHook, useCloudAgentAvailable, useCloudCreateEnabled } from '../modules/shell/editionHooks';
import { UiSlot } from '../modules/shell/uiSlots';
import { useApprovalMode } from '../modules/agent-timeline/approvalModeStore';
import { useSurfaces } from '../state/surfaceStore';
import { ensureMainVisible, ensureSurfaceVisible, usePanelLayout, useActivePanelTab } from '../state/panelLayoutStore';
import { SurfacePanel } from '../modules/surface/SurfacePanel';
import SessionSearchPalette from '../modules/session-search/SessionSearchPalette';
import type { WorkspaceState, Session } from '../../shared/ipc';
import { shellPerf } from '../perf/shellPerf';
import { friendlyOpError } from '../components/notifyEvents';
import { pluginViewUrl } from '../modules/pluginViews/openPluginView';
import { usePilotShell } from '../modules/pilot/usePilotShell';
import { pulseShellSwitch } from '../modules/shell/shellSwitchFade';

const PageLoading: React.FC = () => (
  <div className="neox-page-loading" role="status" aria-busy="true" aria-live="polite">
    <div className="sk-dots"><i /><i /><i /></div>
  </div>
);

/* ============================================================
 * NeoxShellHost
 *   外层: NeoxRuntimeBridge 挂齐 4 层 provider + 真实数据管线
 *   内层: ShellInner 消费 runtime context, 装配 NeoxShell + 各区块
 * ============================================================ */
export const NeoxShellHost: React.FC<NeoxShellHostProps> = (props) => {
  return (
    <NeoxRuntimeBridge workspace={props.workspace}>
      <ShellInner {...props} />
    </NeoxRuntimeBridge>
  );
};

interface NeoxShellHostProps {
  workspace: WorkspaceState;
  /** 工作区切换中 — 透传给 NeoxShell 让 main 区出骨架而不是空白 children */
  loading?: boolean;
  /** 最近工作区列表 — 给 sidebar 多项目分组用 */
  recentWorkspaces?: WorkspaceState[];
  /** 切换到指定工作区(被 sidebar 跨 group 点击 / project chip 选择触发) */
  onSelectWorkspace?: (path: string, opts?: { silent?: boolean }) => void;
  /** 打开新工作区文件夹对话框("+ 文件夹") */
  onChangeWorkspace?: () => void;
  /** 从 recent 列表移除工作区(右键 / hover delete 按钮) */
  onRemoveWorkspace?: (path: string) => void;
  /** 在指定工作区下新建会话(若非当前则切换 + 自动创建) */
  onCreateSessionInWorkspace?: (path: string) => void;
  /** 工作台内 Home — 清会话封面 (不是 Welcome 登录墙) */
  onGoHome?: () => void;
  onReady?: () => void;
  onOpenSettings?: () => void;
  onToggleTheme?: () => void;
}

/* ---------- Session → SessionItem (meta + workspace tagging) ---------- */
export interface ModeHomePaths { work?: string; pilot?: string }
let modeHomesCache: ModeHomePaths | null = null;
const pad2 = (n: number) => n.toString().padStart(2, '0');
function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
/* ============================================================
 * ShellInner
 * ============================================================ */
const ShellInner: React.FC<NeoxShellHostProps> = ({
  workspace,
  loading,
  recentWorkspaces,
  onSelectWorkspace,
  onChangeWorkspace,
  onRemoveWorkspace,
  onCreateSessionInWorkspace,
  onGoHome,
  onReady,
  onOpenSettings,
  onToggleTheme,
}) => {
  const runtime = useNeoxRuntime();
  const {
    setSessions: storeSetSessions,
    setActiveSession: storeSetActiveSession,
  } = useSessionActions();

  /* 桌宠 agent 事件转发 — 把 runtime 的 timelineEvents/streaming/lastError 简化成 PetAgentEvent,
   *   通过 IPC 推给独立 pet 窗口. cfg.enabled=false 时整个 hook 啥都不做, 0 开销.
   *   挂在 NeoxRuntimeBridge 树内 (而不是 AppShell), 才能 useNeoxRuntime() 拿到非 null runtime. */
  usePetAgentForwarder();
  useEffect(() => { shellPerf.install(); }, []);
  /* 让 timeline 认得出哪些工具是外部 Agent 委派 —— 认不出就会退回通用工具卡,
   * 用户看到的是一坨 JSON 而不是「Codex 在跑」。拿不到不影响其它功能。 */
  useEffect(() => { void loadExternalAgentTools(); }, []);
  const [activeNav, setActiveNav] = useState<RailKey>('agent');
  const beginShellLayoutInstantRef = useRef<((duration?: number) => void) | null>(null);
  const [agentPage, setAgentPageRaw] = useState<'chat' | 'tools' | 'knowledge' | 'library' | 'image' | 'team' | 'plugins' | 'skills' | 'mcp' | 'settings' | 'projects' | 'project'>('chat');
  /* 这个工具页是从「工具」主页点进来的 —— 返回回主页, 不回任务 */
  const [fromTools, setFromTools] = useState(false);
  /* 停在工具页时用户自己点开了右栏 (默认是收着的); 换页就复位 */
  const [surfaceOnPage, setSurfaceOnPage] = useState(false);
  useEffect(() => { setSurfaceOnPage(false); }, [agentPage]);
  /* Work 项目主页正在看哪个项目 (agentPage === 'project') */
  const [projectPageDir, setProjectPageDir] = useState<string | null>(null);
  const setAgentPage = useCallback<typeof setAgentPageRaw>((next) => {
    ensureMainVisible();
    beginShellLayoutInstantRef.current?.(320);
    setAgentPageRaw(next);
  }, []);
  /* 工具页的返回: 从「工具」主页进来的回主页, 否则回任务。走 ref —— 各页 onClose 在 agentView 的 memo 里 */
  const fromToolsRef = useRef(false);
  fromToolsRef.current = fromTools;
  const closeToolPage = useCallback(() => { setAgentPage(fromToolsRef.current ? 'tools' : 'chat'); }, [setAgentPage]);
  const sessionAgentModeForLayout = (runtime.activeSession as { agentMode?: string } | null)?.agentMode;

  const activeSessionKind = (runtime.activeSession as { kind?: string } | null)?.kind;
  useEffect(() => {
    if (activeSessionKind === 'image') {
      setAgentPage((p) => (p === 'image' ? p : 'image'));
    } else if (activeSessionKind) {
      setAgentPage((p) => (p === 'image' ? 'chat' : p));
    }
  }, [activeSessionKind]);
  /* activeSession 未创建时 (刚切完 mode / 新建会话前), sessionAgentModeForLayout=undefined
   * 会让 hideTabSwitch=false, 顶栏"Agent"按钮闪现. 兜底用 modeVariant.isWork —
   * 那个 hook 走 defaultAgentMode / 用户当前档位, 切模式后立刻反映。 */
  const agentModeVariant = useAgentModeVariant();
  const isWorkSession = sessionAgentModeForLayout === 'work'
    || (!sessionAgentModeForLayout && agentModeVariant.isWork);
  useEffect(() => {
    if (isWorkSession && (activeNav === 'explorer' || activeNav === 'git')) {
      setActiveNav('agent');
    }
  }, [isWorkSession, activeNav]);
  const handleOpenFileExplorer = useCallback(() => setActiveNav('explorer'), []);
  useEffect(() => {
    const onBack = () => setActiveNav('agent');
    window.addEventListener('neox:agent-explorer-back', onBack);
    return () => window.removeEventListener('neox:agent-explorer-back', onBack);
  }, []);
  const [sidebarShowWorkspace, setSidebarShowWorkspace] = useState(false);
  const [sidebarWorkspaceTarget, setSidebarWorkspaceTarget] = useState<string | undefined>(undefined);
  const [sidebarReturnAnim, setSidebarReturnAnim] = useState(false);
  const closeSidebarWorkspace = useCallback(() => {
    setSidebarShowWorkspace(false);
    setSidebarReturnAnim(true);
    window.setTimeout(() => setSidebarReturnAnim(false), 250);
  }, []);
  const pendingShellLayoutSettleRef = useRef<number | null>(null);
  const [shellLayoutInstant, setShellLayoutInstant] = useState(false);
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState(true);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const beginShellLayoutInstant = useCallback((duration = 220) => {
    setShellLayoutInstant(true);
    if (pendingShellLayoutSettleRef.current !== null) {
      window.clearTimeout(pendingShellLayoutSettleRef.current);
      pendingShellLayoutSettleRef.current = null;
    }
    pendingShellLayoutSettleRef.current = window.setTimeout(() => {
      pendingShellLayoutSettleRef.current = null;
      setShellLayoutInstant(false);
    }, duration);
  }, []);
  beginShellLayoutInstantRef.current = beginShellLayoutInstant;
  const setSidebarCollapsedSmooth = useCallback((updater: React.SetStateAction<boolean>) => {
    beginShellLayoutInstant(320);
    setSidebarCollapsed(updater);
  }, [beginShellLayoutInstant]);

  const scheduleSurfaceLayout = useCallback((reason: string) => {
    const emit = (phase: string) => {
      window.dispatchEvent(new CustomEvent('neox:surface-layout', {
        detail: { reason, phase },
      }));
    };

    emit('sync');
    window.requestAnimationFrame(() => {
      emit('raf');
      window.setTimeout(() => emit('settle-80'), 80);
      window.setTimeout(() => emit('settle-260'), 260);
    });
  }, []);


  /* 首次挂载时, 并行拉 2 个偏好 (右栏的键名沿用旧的 agentRightCollapsed, 老用户的偏好不丢) */
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const api = (window as any).neox;
        if (!api?.uiStateGet) return;
        const [rp, sb] = await Promise.all([
          api.uiStateGet('agentRightCollapsed'),
          api.uiStateGet('sidebarCollapsed'),
        ]);
        if (!alive) return;
        if (rp?.value === '0') setRightPanelCollapsed(false);
        if (sb?.value === '1') setSidebarCollapsed(true);
      } catch { /* ignore */ }
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    return () => {
      if (pendingShellLayoutSettleRef.current !== null) {
        window.clearTimeout(pendingShellLayoutSettleRef.current);
        pendingShellLayoutSettleRef.current = null;
      }
    };
  }, []);

  /* 写入: rightPanelCollapsed / sidebarCollapsed 状态变化时同步到 SQLite */
  useEffect(() => {
    void (window as any).neox?.uiStateSet?.('agentRightCollapsed', rightPanelCollapsed ? '1' : '0');
  }, [rightPanelCollapsed]);

  /* 匿名 → 注册迁移 toast 已移除 — 不再弹提示打扰用户. */

  useEffect(() => {
    void (window as any).neox?.uiStateSet?.('sidebarCollapsed', sidebarCollapsed ? '1' : '0');
  }, [sidebarCollapsed]);
  /* 全局"未登录但试图发对话"信号 — runtime.sendPrompt 派发 'neox:login-required' 事件,
   *   这里监听后弹 LoginPage. 这样所有 chat 入口共用同一道闸. */
  const [loginPromptOpen, setLoginPromptOpen] = useState(false);
  useEffect(() => {
    const handler = () => setLoginPromptOpen(true);
    window.addEventListener('neox:login-required', handler);
    return () => window.removeEventListener('neox:login-required', handler);
  }, []);

  /* 设置页入口统一收口 —— 见 useSettingsPageNav 的说明 */
  const handleOpenSettingsPage = useSettingsPageNav(setAgentPage);

  /* 左轨点击路由: 点已 active 的 toggle 折叠; 点别的设新 key + 自动展开. */
  const handleRailSelect = useCallback((key: RailKey) => {
    const currentKey: RailKey = activeNav;
    if (key === 'agent' && agentPage !== 'chat') {
      setAgentPage('chat');
      setActiveNav('agent');
      if (sidebarCollapsed) setSidebarCollapsedSmooth(false);
      return;
    }
    if (key === currentKey) {
      /* 点同一个 icon 第二次 → toggle 折叠 (跟 IDEA Tool Window button 行为一致) */
      setSidebarCollapsedSmooth((v) => !v);
      return;
    }
    /* 切到别的 panel — 收起状态自动展开 */
    setActiveNav(key);
    if (sidebarCollapsed) setSidebarCollapsedSmooth(false);
  }, [activeNav, agentPage, sidebarCollapsed, setSidebarCollapsedSmooth]);

  /* 侧栏内的"折叠"按钮 (IdeFileSidebar / 后续别处) 派 event, 这里 toggle. 持久化已在
   * useEffect uiStateSet 链路里自动跟. */
  useEffect(() => {
    const onToggle = () => setSidebarCollapsedSmooth((v) => !v);
    window.addEventListener('neox:sidebar:toggle-collapse', onToggle);
    return () => window.removeEventListener('neox:sidebar:toggle-collapse', onToggle);
  }, [setSidebarCollapsedSmooth]);

  /* 「工作区」hub 面板点项目的「在资源管理器里看」→ 关掉 hub, 侧栏切成文件树。 */
  useEffect(() => {
    const onOpenExplorer = () => {
      setSidebarShowWorkspace(false);
      setActiveNav('explorer');
      setSidebarCollapsedSmooth(false);
    };
    window.addEventListener('neox:ide:open-explorer', onOpenExplorer);
    return () => window.removeEventListener('neox:ide:open-explorer', onOpenExplorer);
  }, [setSidebarCollapsedSmooth]);

  /* 资源管理器顶部「当前工作区」栏点击 → 打开工作区 hub 面板 (管理/切换)。 */
  useEffect(() => {
    const onOpenHub = () => {
      setSidebarCollapsedSmooth(false);
      setActiveNav((cur) => (cur === 'explorer' ? 'agent' : cur));
      setSidebarWorkspaceTarget(undefined);
      setSidebarShowWorkspace(true);
    };
    window.addEventListener('neox:ide:open-workspace-hub', onOpenHub);
    return () => window.removeEventListener('neox:ide:open-workspace-hub', onOpenHub);
  }, [setSidebarCollapsedSmooth]);

  useEffect(() => {
    const raf = requestAnimationFrame(() => onReady?.());
    return () => cancelAnimationFrame(raf);
  }, [onReady]);

  useEffect(() => getEditionHook('startCloudFeatureFlags')(), []);

  /* Cloud sessions — 提前 destructure 让 handleNewCloudSession 闭包能 access (TDZ).
   * pushToCloud / pullToLocal / terminateCloud / syncSessionConfig 后面其他 hook 用,
   * 共用同一份 useCloudSessions() 实例. */
  const { cloudSessions, pushToCloud, pullToLocal, terminateCloud, syncSessionConfig } = useCloudSessions();

  const handleNewSession = useCallback(async () => {
    pulseShellSwitch(180, 'main');
    await runtime.createNewSession();
    setAgentPage('chat');
    setActiveNav('agent');
  }, [runtime]);

  /* ==================== 知识库整理 (curator) ====================
   * 点按钮/自动触发 → 新会话 + 发 curator 指令。sendPrompt 不能在 createNewSession
   * 同一闭包里调 (runtime.activeSession 还是旧值) — 用 pending state, 等新会话
   * 真正 active 后由 effect 发送。运行记录只存启动信息, token 消耗跟着会话本身走
   * (点记录跳到该会话看用量), 不另建计量系统。 */
  const [pendingKbRun, setPendingKbRun] = useState<{
    sessionId: string;
    prompt: string;
    /** 有值 = 整理运行, 完成时记 curation 日志与 lastCurateAt */
    curationTrigger?: 'manual' | 'auto';
  } | null>(null);

  const startKbSession = useCallback(async (
    name: string,
    prompt: string,
    curationTrigger?: 'manual' | 'auto',
    /* Work 任务各跑各的: 别的任务在跑不挡新任务 (项目主页发任务走这里) */
    parallel?: boolean,
  ) => {
    if (runtime.streaming && !parallel) {
      dispatchHint('当前会话正在运行, 等它结束再操作', 'warning');
      return;
    }
    const session = await runtime.createNewSession();
    if (!session) {
      dispatchHint('无法创建会话 (未选择模型?)', 'warning');
      return;
    }
    try {
      await runtime.renameSession(session.id, name);
    } catch { /* 改名失败不阻塞 */ }
    setAgentPage('chat');
    setActiveNav('agent');
    setPendingKbRun({ sessionId: session.id, prompt, curationTrigger });
  }, [runtime]);

  useEffect(() => {
    const onStartTask = (e: Event) => {
      const d = (e as CustomEvent<{ name?: string; prompt?: string }>).detail;
      if (!d?.prompt?.trim()) return;
      void startKbSession(d.name?.trim() || d.prompt.trim().slice(0, 24), d.prompt);
    };
    window.addEventListener('neox:start-task-session', onStartTask);
    return () => window.removeEventListener('neox:start-task-session', onStartTask);
  }, [startKbSession]);

  /* Work 项目: 侧栏浮层「全部项目 ›」/ 列表顶行「项目主页 ›」打开主区页面 */
  useEffect(() => {
    const onAll = () => { setAgentPage('projects'); setActiveNav('agent'); };
    const onOne = (e: Event) => {
      const dir = (e as CustomEvent<{ dir?: string }>).detail?.dir;
      if (!dir) return;
      setProjectPageDir(dir);
      setAgentPage('project');
      setActiveNav('agent');
    };
    window.addEventListener('neox:open-work-projects', onAll);
    window.addEventListener('neox:open-work-project', onOne);
    return () => {
      window.removeEventListener('neox:open-work-projects', onAll);
      window.removeEventListener('neox:open-work-project', onOne);
    };
  }, []);
  /* 项目主页输入框: 选中这个项目 (新任务因此落进它) 再开新任务发出去 */
  const startWorkProjectTask = useCallback((dir: string, prompt: string) => {
    setWorkProjectFilter(dir);
    void startKbSession(prompt.split(/\r?\n/)[0]!.slice(0, 24), prompt, undefined, true);
  }, [startKbSession]);

  const handleRunKnowledgeCuration = useCallback(async (trigger: 'manual' | 'auto' = 'manual') => {
    const stamp = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date());
    await startKbSession(
      `知识库整理 · ${stamp}`,
      '请整理知识库: 调用 use_skill 工具执行 skill "knowledge-curator", 严格按其规程完成整理并输出报告。',
      trigger,
    );
  }, [startKbSession]);

  /** 资料文件 → 消化成知识条目 (知识库页文档行的 ✦ 按钮) */
  const handleDigestDocument = useCallback(async (docPath: string, docName: string) => {
    await startKbSession(
      `知识消化 · ${docName}`,
      `请把资料文件消化成知识库条目: 调用 use_skill 工具执行 skill "knowledge-ingest", 子命令 add, 目标文件: ${docPath}\n严格按其规程读全原文、提炼为自包含条目 (draft) 落盘到 .neox/knowledge/, 并汇报产出的条目清单。`,
    );
  }, [startKbSession]);

  useEffect(() => {
    if (!pendingKbRun) return;
    if (runtime.activeSession?.id !== pendingKbRun.sessionId) return;
    setPendingKbRun(null);
    if (pendingKbRun.curationTrigger) {
      void window.neox.knowledgeCurationLogAppend({
        sessionId: pendingKbRun.sessionId,
        model: runtime.selectedModel?.id,
        trigger: pendingKbRun.curationTrigger,
      });
      void window.neox.knowledgeCurationConfigSet({ lastCurateAt: Date.now() });
    }
    void runtime.sendPrompt(pendingKbRun.prompt);
  }, [pendingKbRun, runtime]);

  const autoCurateCheckedRef = useRef(false);
  useEffect(() => {
    if (autoCurateCheckedRef.current) return;
    if (runtime.sessionsLoading || !runtime.selectedModel) return;
    autoCurateCheckedRef.current = true;
    const timer = window.setTimeout(async () => {
      try {
        if (!isKnowledgeCurationEnabled()) return;
        const config = await window.neox.knowledgeCurationConfigGet();
        if (!config?.ok || !config.autoCurate) return;
        const AUTO_CURATE_INTERVAL_MS = 7 * 24 * 3600 * 1000;
        if (Date.now() - (config.lastCurateAt || 0) < AUTO_CURATE_INTERVAL_MS) return;
        if (runtime.streaming) return; /* 用户已开工, 别抢 */
        dispatchHint('知识库自动整理已启动 (每 7 天一次, 可在知识库页关闭)', 'info');
        void handleRunKnowledgeCuration('auto');
      } catch { /* 静默 */ }
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [runtime.sessionsLoading, runtime.selectedModel, runtime.streaming, handleRunKnowledgeCuration]);

  const handleOpenCurationSession = useCallback((sessionId: string) => {
    runtime.selectSession(sessionId);
    setAgentPage('chat');
    setActiveNav('agent');
  }, [runtime]);

  const cloudFlags = { createEnabled: useCloudCreateEnabled() };
  /* 云端运行是否对本账号开放 — 与 picker / 右键菜单 / 设置页同一个真相源 */
  const cloudAgentAvailable = useCloudAgentAvailable();
  /* inflight 守卫: 防用户连点两次"在云端新建" 触发两个 create 请求. local cache (cloudSessions list)
   * 30s 才轮询一次, 第一次创建后 30s 内本地看不到, 二次点不会被 existingActive 拦下 — 用 ref 卡同步. */
  const newCloudSessionInflightRef = useRef<boolean>(false);
  const handleNewCloudSession = useCallback(async () => {
    if (!cloudAgentAvailable) {
      dispatchHint('云端运行还没开放 — 所有任务都在你自己的机器上跑', 'info');
      return;
    }
    if (!cloudFlags.createEnabled) {
      dispatchHint('云端会话已被管理员关闭', 'warning');
      return;
    }
    if (newCloudSessionInflightRef.current) {
      dispatchHint('正在创建中, 请稍候…', 'info');
      return;
    }
    const existingActive = cloudSessions.find((s) => s.state !== 'terminated');
    if (existingActive) {
      dispatchHint('你已经有一条云端会话在运行，已切过去', 'info');
      try {
        runtime.selectSession?.(existingActive.sessionId);
        setActiveNav('agent');
      } catch { /* ignore */ }
      return;
    }
    const modelId = (runtime as any).selectedModel?.id ?? (runtime.activeSession as any)?.modelId;
    if (!modelId) {
      dispatchHint('未选默认 model — 先在设置里挑一个', 'warning');
      return;
    }
    newCloudSessionInflightRef.current = true;
    try {
      const api = (window as any).neox?.cloudSession;
      if (!api?.create) {
        dispatchHint('当前 desktop 不支持云端会话 (preload 未暴露)', 'warning');
        return;
      }
      const result = await api.create({ modelId });
      /* main 进程 IPC 兼容 server 409 'CLOUD_SESSION_EXISTS' 自动返 existing — 视为"切到现有" */
      if ((result as any).existed) {
        dispatchHint('已切到正在运行的云端会话', 'info');
      } else {
        if (workspace.path) getEditionHook('bindCloudSessionToWorkspace')(result.sessionId, workspace.path);
        dispatchHint('云端会话已创建', 'success');
      }
      /* 立刻 refresh 本地 cloudSessions 缓存, 不等下次 30s poll. */
      try { window.dispatchEvent(new CustomEvent('neox:cloud-sessions-refresh')); } catch { /* ignore */ }
      try {
        runtime.selectSession?.(result.sessionId);
        setActiveNav('agent');
      } catch { /* ignore */ }
    } catch (err: any) {
      dispatchHint(`新建云端会话失败: ${friendlyOpError(err)}`, 'warning');
    } finally {
      newCloudSessionInflightRef.current = false;
    }
  }, [cloudAgentAvailable, cloudFlags.createEnabled, runtime, workspace.path, cloudSessions]);

  /* 同工作区下"在该项目新建会话" — 由 sidebar 的 "+" 派发 'neox:create-new-session'.
   * 跨工作区的情况由 AppShell 写 localStorage 标记后切换, 切换完成 NeoxShellHost 重新挂载会触发下面那个 mount effect. */
  useEffect(() => {
    const handler = () => { void handleNewSession(); };
    window.addEventListener('neox:create-new-session', handler);
    return () => window.removeEventListener('neox:create-new-session', handler);
  }, [handleNewSession]);

  /* 切回对话页 (不动当前会话) —— 外部编辑器插件发代码过来前用: 人可能正停在技能 / 插件页, 那里没有输入框 */
  useEffect(() => {
    const onShowChat = () => {
      setAgentPage('chat');
      setActiveNav('agent');
    };
    window.addEventListener('neox:show-chat', onShowChat);
    return () => window.removeEventListener('neox:show-chat', onShowChat);
  }, [setAgentPage]);

  useEffect(() => {
    const onGoHome = () => {
      setAgentPage('chat');
      setActiveNav('agent');
      /* 复用 NeoxModePicker 已有的 clear-active-session 通路: NeoxRuntimeBridge 监听后
       * 会 setActiveSession(null), timeline 卸载, Life 会显示 LifeDashboard 空态. */
      try { window.dispatchEvent(new CustomEvent('neox:clear-active-session')); } catch { /* noop */ }
    };
    window.addEventListener('neox:go-home', onGoHome);
    return () => window.removeEventListener('neox:go-home', onGoHome);
  }, []);

  useEffect(() => {
    let pending = false;
    try { pending = window.localStorage.getItem('neox-pending-new-session') === '1'; } catch { /* ignore */ }
    if (!pending) return;
    try { window.localStorage.removeItem('neox-pending-new-session'); } catch { /* ignore */ }
    let attempt = 0;
    let timer: number | null = null;
    const tryCreate = () => {
      attempt++;
      handleNewSession().catch(() => {
        if (attempt < 3) timer = window.setTimeout(tryCreate, attempt * 200);
      });
    };
    /* 一帧后触发 — 让 workspace.path 变化引起的其他 effect 先 flush (avoid createSession
     * 抢在 setWorkspace IPC 还没落地时用错 workspacePath). */
    timer = window.requestAnimationFrame(() => { timer = null; tryCreate(); }) as unknown as number;
    return () => {
      if (timer !== null) {
        try { window.cancelAnimationFrame(timer); } catch { /* was setTimeout */ window.clearTimeout(timer); }
      }
    };
  }, [handleNewSession]);

  const syncAmbientModeForSession = useCallback((id: string) => {
    const sess = runtime.sessions.find((s) => s.id === id) as
      | (Session & { agentMode?: string | null; kind?: string; parentSessionId?: string | null })
      | undefined;
    if (!sess || sess.kind === 'image') return; /* 图片会话跨模式, 不翻池 */
    const modeOf = (s: { agentMode?: string | null; parentSessionId?: string | null } | undefined): AgentModeValue => {
      if (!s) return 'code';
      if (s.agentMode) return normalizeAgentMode(s.agentMode);
      if (s.parentSessionId) {
        const parent = runtime.sessions.find((p) => p.id === s.parentSessionId) as
          | { agentMode?: string | null }
          | undefined;
        if (parent?.agentMode) return normalizeAgentMode(parent.agentMode);
      }
      return 'code';
    };
    const target = modeOf(sess);
    const current = resolveEffectiveAgentMode({
      sessionAgentMode: (runtime.activeSession as { agentMode?: string | null } | null)?.agentMode,
      sessionKind: (runtime.activeSession as { kind?: string } | null)?.kind,
      ambientDefault: typeof window !== 'undefined'
        ? (window as { __neoxDefaultAgentMode?: string }).__neoxDefaultAgentMode
        : null,
    });
    if (target === current) return;
    const api = (window as any).neox;
    try {
      api?.logInfo?.('MODE', `select ${id} switches mode ${current} → ${target}: ${(new Error().stack ?? '').split('\n').slice(2, 6).join(' | ')}`);
    } catch { /* ignore */ }
    /* 清残留 flag — 这不是"进空态门厅"的切换, lastSession 恢复不该被孤儿 flag 误清. */
    try { window.localStorage.removeItem('neox-mode-switch-in-progress'); } catch { /* ignore */ }
    if (typeof api?.agentModeSetDefault === 'function') {
      void api.agentModeSetDefault(target).catch(() => { /* config 落盘失败不阻塞选中 */ });
    }
    try { (window as { __neoxDefaultAgentMode?: string }).__neoxDefaultAgentMode = target; } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent('neox:agent-mode-default-changed', { detail: { defaultAgentMode: target } }));
  }, [runtime]);

  const handleSelectSession = useCallback(
    (id: string) => {
      /* 切会话: 主区淡出 → 新会话落定后淡入 (侧栏不动, 用户正在点它) —— 盖住清空 / 加载 / 补历史那几步 */
      if (id !== runtime.activeSession?.id) pulseShellSwitch(180, 'main');
      const localExists = runtime.sessions.some((s) => s.id === id);
      /* 本地 SQLite 已有、但 React sessions 尚未 refresh (createSession IPC /
       * sessions-changed 竞态) 时, 旧逻辑会误走 cloud ensure 并 return —
       * 点侧栏 / select-session 像没反应, 仍停在旧工作区 (QA 回归踩中).
       * 先让 selectSession 自己 getSession merge, 再按本地会话完成 UI 切换. */
      if (!localExists) {
        void (async () => {
          try {
            const meta = await (window as any).neox?.getSession?.(id);
            if (meta) {
              const owner = (meta as { workspacePath?: string }).workspacePath;
              if (owner && owner !== workspace.path && onSelectWorkspace) {
                onSelectWorkspace(owner, { silent: true });
              }
              runtime.selectSession(id);
              setAgentPage((meta as { kind?: string }).kind === 'image' ? 'image' : 'chat');
              setActiveNav('agent');
              return;
            }
          } catch { /* fall through to cloud ensure */ }

          const api = (window as any).neox?.cloudSession;
          if (api?.ensure) {
            dispatchHint('正在连接云端会话…', 'info');
            void api.ensure(id).then((ok: boolean) => {
              if (!ok) {
                dispatchHint('连不上这条云端会话，可能已被关闭', 'warning');
                try {
                  window.dispatchEvent(new CustomEvent('neox:cloud-ensure-failed', {
                    detail: {
                      sessionId: id,
                      actions: ['retry', 'pull-back', 'delete'],
                    },
                  }));
                } catch { /* ignore */ }
                return;
              }
              runtime.selectSession(id);
              setAgentPage((runtime.sessions.find(s => s.id === id) as { kind?: string } | undefined)?.kind === 'image' ? 'image' : 'chat');
              setActiveNav('agent');
            });
          } else {
            dispatchHint('这条会话只在云端，当前版本不能直接继续', 'info');
          }
        })();
        return;
      }
      const owner = (runtime.sessions.find((s) => s.id === id) as { workspacePath?: string } | undefined)?.workspacePath;
      if (owner && owner !== workspace.path && onSelectWorkspace) {
        onSelectWorkspace(owner, { silent: true });
      }
      /* 跨模式会话: 先切全局默认模式再选中 (镜头跟着会话转, 见 syncAmbientModeForSession). */
      syncAmbientModeForSession(id);
      runtime.selectSession(id);
      setAgentPage((runtime.sessions.find(s => s.id === id) as { kind?: string } | undefined)?.kind === 'image' ? 'image' : 'chat');
      setActiveNav('agent');
    },
    [runtime, syncAmbientModeForSession, workspace.path, onSelectWorkspace],
  );

  /* 主区页面里要「打开某条会话」的 (团队页最近的团队…) 走这条 —— 跟侧栏点一样: 跨模式先切、侧栏选中、主区回任务。
   * 用事件是因为那些页在 agentView 的 memo 里, 而 handleSelectSession 声明在它后面 */
  useEffect(() => {
    const on = (e: Event) => { const id = (e as CustomEvent<string>).detail; if (id) handleSelectSession(id); };
    window.addEventListener('neox:host-select-session', on);
    return () => window.removeEventListener('neox:host-select-session', on);
  }, [handleSelectSession]);


  const handleMoveSessionToWorkspace = useCallback(async (
    id: string,
    target: { path: string },
    opts?: { confirm?: boolean; reason?: string },
  ) => {
    const api = (window as any).neox;
    const sess = runtime.sessions.find((s) => s.id === id);
    if (!sess) return;
    const targetPath: string | null = target.path || null;
    if (!targetPath) {
      dispatchHint('目标文件夹不可用', 'warning');
      return;
    }
    if ((sess.workspacePath ?? '') === targetPath) return;
    /* 跨项目移动: 历史消息里的文件引用仍指旧目录, 明确告知再动手 (不静默). */
    const mvZh = getGlobalLanguage() === 'zh';
    const ok = opts?.confirm === false || await confirmAsync({
      title: mvZh ? '移动会话' : 'Move chat',
      message: mvZh
        ? (<>将「<strong>{sess.name || id}</strong>」移动到 <strong>{targetPath}</strong>?</>)
        : (<>Move <strong>{sess.name || id}</strong> to <strong>{targetPath}</strong>?</>),
      description: mvZh
        ? '只改会话归属, 不搬动文件。历史消息里的文件引用可能失效 (仍指向原目录)。'
        : 'Only the chat moves — files stay put. File references in past messages may break (they still point at the old directory).',
      confirmLabel: mvZh ? '移动' : 'Move',
      cancelLabel: mvZh ? '取消' : 'Cancel',
    });
    if (!ok) return;
    if (typeof api?.setSessionWorkspacePath !== 'function') {
      dispatchHint('当前版本不支持移动会话', 'warning');
      return;
    }
    try {
      const r = await api.setSessionWorkspacePath(id, targetPath);
      if (!r?.ok) throw new Error(r?.error || 'move failed');
      const applied = targetPath;
      storeSetSessions((prev) => prev.map((s) => (s.id === id ? { ...s, workspacePath: applied } : s)));
      const wasActive = runtime.activeSession?.id === id;
      if (wasActive) {
        storeSetActiveSession({ ...(runtime.activeSession as Session), workspacePath: applied });
      }

      if (wasActive) {
        try {
          window.localStorage.setItem(
            'neox-pending-select-session',
            JSON.stringify({ id, ts: Date.now() }),
          );
        } catch { /* localStorage 不可用时退化成"切过去但不自动选中" */ }
        dispatchHint(opts?.reason ? `已移动到 ${applied}（${opts.reason}）` : `已移动到 ${applied}，正在跟随切换…`, 'success');
        window.dispatchEvent(new CustomEvent('neox:open-workspace', { detail: { path: applied } }));
      } else {
        dispatchHint(`已移动到 ${applied}`, 'success');
      }
    } catch (e) {
      console.error('[NeoxShellHost] moveSessionToWorkspace failed:', e);
      dispatchOpFailedFromError('移动会话', e);
    }
  }, [runtime, storeSetSessions, storeSetActiveSession]);

  /* 空会话首屏「在 X 里」换项目: 这条会话还没内容, 直接在目标项目开一条新的 (跟侧栏「新建会话」挑项目同一条路) */
  const handlePickProjectForEmpty = useCallback((path: string) => {
    if (path === workspace.path) return;
    onCreateSessionInWorkspace?.(path);
  }, [workspace.path, onCreateSessionInWorkspace]);

  const moveSessionRef = useRef(handleMoveSessionToWorkspace);
  moveSessionRef.current = handleMoveSessionToWorkspace;
  useEffect(() => {
    const neox = (window as any).neox;
    if (!neox?.onStream) return;
    return neox.onStream((data: any) => {
      if (data?.type !== 'tool_result' || data?.taskAgentId) return;
      const raw = typeof data?.output === 'string' ? data.output : typeof data?.result === 'string' ? data.result : '';
      if (!raw.includes('__neox_session_move__')) return;
      let payload: any;
      try { payload = JSON.parse(raw); } catch { return; }
      const sessionId = requireStreamEventSession(data, 'session_move');
      if (!payload?.__neox_session_move__ || typeof payload.path !== 'string' || !sessionId) return;
      void moveSessionRef.current(sessionId, { path: payload.path }, { confirm: false, reason: payload.reason });
    });
  }, []);

  const PENDING_SELECT_STALE_MS = 5 * 60 * 1000;
  const consumedSelectFlagRef = useRef<string | null>(null);
  useEffect(() => {
    let pending: { id: string; ts: number } | null = null;
    try {
      const raw = window.localStorage.getItem('neox-pending-select-session');
      if (raw) {
        /* 向后兼容: 老格式是裸 id 字符串. 没 ts 视为 stale (无法判断, 不冒险). */
        if (raw.startsWith('{')) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed.id === 'string' && typeof parsed.ts === 'number') {
            pending = { id: parsed.id, ts: parsed.ts };
          }
        }
      }
    } catch { /* ignore */ }
    if (!pending) {
      /* 老格式或损坏 — 强清避免残留 */
      try { window.localStorage.removeItem('neox-pending-select-session'); } catch { /* ignore */ }
      return;
    }
    const flagKey = `${pending.id}@${pending.ts}`;
    if (consumedSelectFlagRef.current === flagKey) return;
    if (Date.now() - pending.ts > PENDING_SELECT_STALE_MS) {
      console.warn('[NeoxShellHost] pending-select-session expired, clearing:', pending.id);
      try { window.localStorage.removeItem('neox-pending-select-session'); } catch { /* ignore */ }
      consumedSelectFlagRef.current = flagKey;
      return;
    }
    /* sessions 还没加载完 — 不消费 flag，等 sessions 更新后 effect 重跑 */
    if (runtime.sessions.length === 0) return;
    if (!runtime.sessions.some((s) => s.id === pending!.id)) return;
    consumedSelectFlagRef.current = flagKey;
    try { window.localStorage.removeItem('neox-pending-select-session'); } catch { /* ignore */ }
    runtime.selectSession(pending.id);
    setAgentPage('chat');
    setActiveNav('agent');
  }, [runtime, runtime.sessions]);

  const handleSubmitPrompt = useCallback(
    async (prompt: string) => {
      setAgentPage('chat');
      setActiveNav('agent');
      await runtime.sendPrompt(prompt);
    },
    [runtime],
  );

  /* 跨会话消息全文搜索的 palette 开关 */
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false);

  /* 顶栏搜索按钮 → SessionSearchPalette 跨会话消息全文搜索。
   *   sidebar 不再常驻标题搜索框; 统一走浮层搜索, 避免占用会话管理空间。 */
  const handleSearch = useCallback(() => setSessionSearchOpen(true), []);

  /* 全局快捷键: ⌘N 新建 · ⌘K 打开搜索浮层. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        void handleNewSession();
      } else if (e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        handleSearch();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleNewSession, handleSearch]);

  useEffect(() => {
    const onMenuNew = () => { void handleNewSession(); };
    const onMenuSearch = () => handleSearch();
    window.addEventListener('neox:menu-new-session', onMenuNew);
    window.addEventListener('neox:menu-search', onMenuSearch);
    return () => {
      window.removeEventListener('neox:menu-new-session', onMenuNew);
      window.removeEventListener('neox:menu-search', onMenuSearch);
    };
  }, [handleNewSession, handleSearch]);

  /* cloudSessions / pushToCloud / pullToLocal / terminateCloud / syncSessionConfig 已经
   * 在前面 destructure 给 handleNewCloudSession 用 (TDZ), 这里复用同一实例. */

  /* CloudMigrationDialog state — confirming / progress / done 三态走完一个完整 flow.
   *   触发: window event 'neox:request-push-current-to-cloud' OR sidebar 右键 onPushSessionToCloud */
  const [migDialog, setMigDialog] = useState<{
    mode: MigrationMode;
    sessionId: string;
    title: string;
    workspacePath?: string;
    modelId?: string;
  } | null>(null);
  const [migProgress, setMigProgress] = useState<{ stage: string; pct?: number; msg?: string } | null>(null);
  const [migOutcome, setMigOutcome] = useState<'success' | 'failed' | null>(null);
  const [migError, setMigError] = useState<string | undefined>();
  const [migNotLoggedIn, setMigNotLoggedIn] = useState(false);

  const openMigDialog = useCallback(async (mode: MigrationMode, sessionId: string) => {
    /* 兼容 sidebar 调 (传 id) 和 picker event (取 active) */
    const sess = runtime.sessions.find((s) => s.id === sessionId) ?? runtime.activeSession;
    if (!sess) {
      dispatchHint('请先打开一个会话', 'warning');
      return;
    }
    if (mode === 'push') {
      const cloudMeta = cloudSessions.find((c) => c.sessionId === sess.id);
      if (cloudMeta && cloudMeta.state !== 'terminated' && cloudMeta.migrationState === 'cloud_active') {
        dispatchHint('这条会话已经在云端运行，已切过去', 'info');
        runtime.selectSession?.(sess.id);
        setActiveNav('agent');
        return;
      }
      /* 另一个 user-level dedupe: user 已有别的 active cloud session 占着 pod → 拒, 引导先 terminate */
      const otherActive = cloudSessions.find((c) =>
        c.sessionId !== sess.id && c.state !== 'terminated' && c.migrationState === 'cloud_active'
      );
      if (otherActive) {
        dispatchHint(
          `每位用户限 1 条云端 session, 您已有 "${otherActive.title || otherActive.sessionId.slice(0, 12)}" 在跑. 先销毁后再推`,
          'warning',
        );
        return;
      }
    }
    /* 检查登录态 — 没登录 confirm 按钮变"去登录" */
    let loggedIn = true;
    try {
      const auth = (window as any).neox?.auth;
      const status = auth?.getSessionStatus ? await auth.getSessionStatus() : null;
      loggedIn = !!status?.loggedIn;
    } catch { loggedIn = false; }
    /* 推送 (push) 模式: 先分析 workspace, 决定走 git 还是 upload */
    if (mode === 'push' && loggedIn && sess.workspacePath) {
      try {
        const api = (window as any).neox?.cloudMigration;
        if (api?.analyze) {
          const analysis: WorkspaceAnalysisRenderer = await api.analyze(sess.workspacePath);
          /* 大项目 + 有 git remote → 弹 git config 让用户选模式 */
          if (analysis.recommended === 'git') {
            setGitDialog({
              sessionId: sess.id,
              title: sess.name || '新会话',
              workspacePath: sess.workspacePath,
              modelId: (sess as any).modelId,
              analysis,
            });
            return;
          }
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[NeoxShellHost] analyze workspace failed, fallback to upload:', err);
      }
    }
    setMigDialog({
      mode,
      sessionId: sess.id,
      title: sess.name || '新会话',
      workspacePath: sess.workspacePath ?? undefined,
      modelId: (sess as any).modelId,
    });
    setMigProgress(null);
    setMigOutcome(null);
    setMigError(undefined);
    setMigNotLoggedIn(!loggedIn);
  }, [runtime.sessions, runtime.activeSession]);

  /* git config dialog state */
  const [gitDialog, setGitDialog] = useState<{
    sessionId: string;
    title: string;
    workspacePath: string;
    modelId?: string;
    analysis: WorkspaceAnalysisRenderer;
  } | null>(null);

  const onGitConfigConfirm = useCallback(async (cfg: GitConfig) => {
    if (!gitDialog) return;
    const api = (window as any).neox?.cloudMigration;
    if (!api?.pushViaGit) {
      dispatchHint('当前 desktop 没接入 git 推送 IPC, 请升级版本', 'warning');
      setGitDialog(null);
      return;
    }
    /* 切回 progress dialog 显示进度 */
    setMigDialog({
      mode: 'push',
      sessionId: gitDialog.sessionId,
      title: gitDialog.title,
      workspacePath: gitDialog.workspacePath,
      modelId: gitDialog.modelId,
    });
    setMigProgress({ stage: 'packing', pct: 5 });
    setMigOutcome(null);
    setMigError(undefined);
    const sessId = gitDialog.sessionId;
    /* 列表瘦身后 runtime.sessions 不带 messages — 云推送按需拉一次完整会话 (用完即弃) */
    const listSess = runtime.sessions.find((s) => s.id === sessId);
    const sess = (await (window as any).neox?.getSession?.(sessId).catch(() => null)) ?? listSess;
    const msgs: Array<{ role: string; content: string; ts?: number; reasoning_content?: string }> = [];
    for (const m of sess?.messages ?? []) {
      const role = (m as any).role;
      const content = typeof (m as any).content === 'string' ? (m as any).content : JSON.stringify((m as any).content ?? '');
      if (role && content) {
        /* reasoning_content (DeepSeek/GLM thinking 模式) 必须带过去, 否则 cloud pod 下一轮 LLM 400. */
        const rc = (m as any).reasoning_content;
        msgs.push({ role, content, ts: (m as any).timestamp, ...(typeof rc === 'string' && rc ? { reasoning_content: rc } : {}) });
      }
    }
    setGitDialog(null);
    try {
      await api.pushViaGit({
        sessionId: sessId,
        workspacePath: gitDialog.workspacePath,
        modelId: gitDialog.modelId ?? 'claude-haiku-4-5-20251001',
        title: gitDialog.title,
        messages: msgs,
        gitUrl: cfg.gitUrl,
        branch: cfg.branch,
        headCommit: cfg.headCommit,
        dirtyMode: cfg.dirtyMode,
        authMode: cfg.authMode,
        authUser: cfg.authUser,
        authToken: cfg.authToken,
      });
      setMigOutcome('success');
    } catch (err: any) {
      setMigOutcome('failed');
      setMigError(err?.message ?? 'git 推送失败');
    }
  }, [gitDialog, runtime.sessions]);

  /* 监听 picker "云端" 项点击 */
  useEffect(() => {
    const handler = () => {
      const sess = runtime.activeSession;
      if (!sess) {
        dispatchHint('请先打开一个会话, 再选择推到云端', 'warning');
        return;
      }
      /* streaming 中切换 transport 不允许 — 会打断当前轮且 server 端状态不一致.
       * 引导用户先停止再切. */
      if (runtime.streaming) {
        dispatchHint('请先停止当前 agent 再切换到云端', 'warning');
        return;
      }
      openMigDialog('push', sess.id);
    };
    window.addEventListener('neox:request-push-current-to-cloud', handler);
    return () => window.removeEventListener('neox:request-push-current-to-cloud', handler);
  }, [runtime.activeSession, runtime.streaming, openMigDialog]);

  /* 监听 Settings → CloudAgentTab "拉回本机" 按钮 */
  useEffect(() => {
    const handler = (evt: Event) => {
      const detail = (evt as CustomEvent<{ sessionId: string }>).detail;
      if (!detail?.sessionId) return;
      openMigDialog('pull', detail.sessionId);
    };
    window.addEventListener('neox:request-pull-cloud-session', handler as EventListener);
    return () => window.removeEventListener('neox:request-pull-cloud-session', handler as EventListener);
  }, [openMigDialog]);

  /* 真触发迁移 (用户点对话框 [推到云端] / [拉回本机] 按钮后) */
  const startMigration = useCallback(async () => {
    if (!migDialog) return;
    const sess = runtime.sessions.find((s) => s.id === migDialog.sessionId);
    /* cloud-only session (mobile 创的) 拉回时 sess 是 undefined — 弹文件夹选择器让用户选目标路径,
     * 不能用当前 workspace.path 默, 万一覆盖错的 project 用户会爆炸. */
    if (!sess && migDialog.mode === 'pull') {
      let target: string | undefined;
      try {
        const result = await (window as any).neox?.openFolderDialog?.();
        if (result && Array.isArray(result.filePaths) && result.filePaths[0]) {
          target = String(result.filePaths[0]);
        } else if (typeof result === 'string') {
          target = result;
        }
      } catch { /* user 取消 */ }
      if (!target) {
        setMigOutcome('failed');
        setMigError('需要选目标文件夹放云端 workspace');
        return;
      }
      setMigProgress({ stage: 'preparing', pct: 0 });
      setMigOutcome(null);
      setMigError(undefined);
      const ok = await pullToLocal(migDialog.sessionId, target);
      setMigOutcome(ok ? 'success' : 'failed');
      if (!ok) setMigError('拉回失败 — 云端 pod 可能已超时');
      return;
    }
    if (!sess) {
      setMigOutcome('failed');
      setMigError('找不到目标会话');
      return;
    }
    setMigProgress({ stage: migDialog.mode === 'push' ? 'packing' : 'preparing', pct: 0 });
    setMigOutcome(null);
    setMigError(undefined);
    if (migDialog.mode === 'push') {
      if (!sess.workspacePath) {
        setMigOutcome('failed');
        setMigError('本地会话无 workspace');
        return;
      }
      /* 列表瘦身后 sess (来自 runtime.sessions) 不带 messages — 推送前按需拉一次完整会话 */
      const fullSess = (await (window as any).neox?.getSession?.(migDialog.sessionId).catch(() => null)) ?? sess;
      const msgs: Array<{ role: string; content: string; ts?: number; reasoning_content?: string }> = [];
      for (const m of fullSess.messages ?? []) {
        const role = (m as any).role;
        const content = typeof (m as any).content === 'string'
          ? (m as any).content
          : JSON.stringify((m as any).content ?? '');
        if (role && content) {
          /* reasoning_content (DeepSeek/GLM thinking 模式) 必须带过去, 否则 cloud pod 下一轮 LLM 400. */
          const rc = (m as any).reasoning_content;
          msgs.push({ role, content, ts: (m as any).timestamp, ...(typeof rc === 'string' && rc ? { reasoning_content: rc } : {}) });
        }
      }
      const res = await pushToCloud({
        sessionId: sess.id,
        workspacePath: sess.workspacePath,
        modelId: migDialog.modelId ?? 'claude-haiku-4-5-20251001',
        title: sess.name,
        messages: msgs,
      });
      setMigOutcome(res.ok ? 'success' : 'failed');
      if (!res.ok) {
        setMigError(res.error ?? '推送失败 — 检查 NeoxCloud 登录 / 网络');
      } else if (sess.workspacePath) {
        /* push 成功后 bind cloud sessionId → 原 workspace, 后续本机 session 即使被
         * 删除变成 cloudOnly, sidebar 仍能归到正确项目组. */
        getEditionHook('bindCloudSessionToWorkspace')(sess.id, sess.workspacePath);
      }
    } else {
      const target = sess.workspacePath || workspace.path;
      if (!target) {
        setMigOutcome('failed');
        setMigError('无目标 workspace 路径');
        return;
      }
      const ok = await pullToLocal(migDialog.sessionId, target);
      setMigOutcome(ok ? 'success' : 'failed');
      if (!ok) setMigError('拉回失败 — 云端 pod 可能已超时');
    }
  }, [migDialog, runtime.sessions, pushToCloud, pullToLocal, workspace.path]);

  /* cloudMigration.onProgress 喂到 dialog state (替代之前 toast 刷屏) */
  useEffect(() => {
    const api = (window as any).neox?.cloudMigration;
    if (!api?.onProgress) return;
    const off = api.onProgress((evt: { sessionId: string; stage: string; pct?: number; msg?: string }) => {
      if (!migDialog || evt.sessionId !== migDialog.sessionId) return;
      if (evt.stage === 'done') {
        setMigOutcome('success');
      } else if (evt.stage === 'failed') {
        setMigOutcome('failed');
        setMigError(evt.msg);
      } else {
        setMigProgress({ stage: evt.stage, pct: evt.pct, msg: evt.msg });
      }
    });
    return off;
  }, [migDialog]);

  const sessionItemsRaw = useMemo<SessionItem[]>(() => {
    /* 1. 本地 session → SessionItem. 标 cloudLocation 用 cloud session 的 migration_state 注. */
    const cloudBySessionId = new Map<string, CloudSessionSummary>();
    for (const c of cloudSessions) cloudBySessionId.set(c.sessionId, c);

    const localItems = runtime.sessions.filter((s) => !isOrphanSubAgentPlaceholder(s as any)).map((s) => {
      const item = mapSessionToItem(s);
      const cloud = cloudBySessionId.get(s.id);
      if (cloud) {
        item.cloudLocation = migrationStateToCloudLocation(cloud.migrationState) ?? undefined;
      }
      return item;
    });

    const cloudWsMap = getEditionHook('readCloudWorkspaceMap')();
    const localIds = new Set(localItems.map((i) => i.id));
    const cloudOnly: SessionItem[] = cloudSessions
      .filter((c) => !localIds.has(c.sessionId) && c.state !== 'terminated' && !isNeverRunCloudShell(c))
      .map<SessionItem>((c) => ({
        id: c.sessionId,
        title: (c.title || '').trim() || '云端会话',
        subtitle: 'cloud-only · 点击进入',
        statusText: '',
        timeText: c.lastActiveAt ? formatSessionTime(c.lastActiveAt) : '',
        ts: c.lastActiveAt ?? c.createdAt ?? Date.now(),
        workspacePath: cloudWsMap[c.sessionId] || undefined,
        cloudLocation: migrationStateToCloudLocation(c.migrationState) ?? 'cloud',
        cloudOnly: true,
      }));

    /* 3. 合并 — *不在这里 sort*. 排序交给 Sidebar 内部的 rankOf 冻结机制, 避免:
     *   (a) NeoxShellHost 按 raw ts 排, Sidebar 再按 rank 排, 两次 sort 不一致 → 顺序乱跳
     *   (b) 每次 cloudSessions poll (30s) 都触发本 memo 重新 sort → 用户感觉"全局刷新一波"
     * Sidebar 自己分组 + 组内 rankOf 排, 顺序 stable 跨 poll. */
    return [...localItems, ...cloudOnly];
    /* 依赖砍掉 activeSession?.id 跟 streaming — 它们是 runtime 状态, 不影响 SessionItem
     * 结构. 切 session / streaming 变化不再触发本 memo 重算, 上游 props 引用稳定,
     * Sidebar 内部 memos 也不重算. */
  }, [runtime.sessions, cloudSessions]);
  const sessionItems = useStableSessionItems(sessionItemsRaw);

  const rawFilterMode = ((runtime.activeSession as { agentMode?: string; kind?: string } | null)?.kind === 'image'
      ? null
      : (runtime.activeSession as { agentMode?: string } | null)?.agentMode)
    ?? (typeof window !== 'undefined' ? (window as { __neoxDefaultAgentMode?: string }).__neoxDefaultAgentMode : null);
  const filterMode: 'work' | 'code' | 'pilot' = rawFilterMode === 'pilot'
    ? 'pilot'
    : rawFilterMode === 'work' || rawFilterMode === 'assistant' ? 'work' : 'code';
  const [modeHomes, setModeHomes] = useState<ModeHomePaths>(() => modeHomesCache ?? {});
  useEffect(() => {
    if (modeHomesCache?.work) return;
    const api = (window as any).neox;
    if (typeof api?.agentModeEnsureHome !== 'function') return;
    let cancelled = false;
    void Promise.all([
      api.agentModeEnsureHome('work').catch(() => null),
      api.agentModeEnsureHome('pilot').catch(() => null),
    ])
      .then(([w, p]: Array<{ success?: boolean; path?: string } | null>) => {
        const next: ModeHomePaths = {
          work: w?.success && w.path ? w.path : undefined,
          pilot: p?.success && p.path ? p.path : undefined,
        };
        modeHomesCache = next;
        if (!cancelled) setModeHomes(next);
      });
    return () => { cancelled = true; };
  }, []);
  /* 注解 + 过滤 + 引用稳定, 逻辑整段搬到 stableSessionItems.ts (那里有单测钉住)。
   * 搬走的原因除了体积, 主要是这层的 `{...it}` 展开是侧栏抖动的第二个源头。 */
  const filteredSessionItems = useSidebarSessionItems(sessionItems, filterMode);
  const pilotShell = usePilotShell({
    active: filterMode === 'pilot',
    sessions: filteredSessionItems,
    runtime: runtime as unknown as Parameters<typeof usePilotShell>[0]['runtime'],
    onSelectSession: handleSelectSession,
  });
  /* 设置 / 插件 / 知识库这些页面在 Pilot 下照旧整页显示, 只有对话页换外壳 */
  const pilotOnChat = pilotShell.active && agentPage === 'chat' && activeNav === 'agent';

  /* 当前 active session 的 cloud meta — header capsule + banner 用 */
  const activeCloudMeta = useMemo(() => {
    const activeId = runtime.activeSession?.id;
    if (!activeId) return null;
    const c = cloudSessions.find((x) => x.sessionId === activeId);
    if (!c) return null;
    return {
      location: migrationStateToCloudLocation(c.migrationState),
      summary: c,
    };
  }, [runtime.activeSession?.id, cloudSessions]);
  const activeCloudLocation = activeCloudMeta?.location;


  /* 广播 cloud state 给 TimelineComposer 的 RunDestinationPicker — picker 据此 disable "云端"项 */
  useEffect(() => {
    const cloudActive = activeCloudLocation === 'cloud';
    window.dispatchEvent(new CustomEvent('neox:active-session-cloud-state', {
      detail: { cloudActive },
    }));
  }, [activeCloudLocation]);

  /* 用户在本地改 approval mode / model — 当前 active session 是 cloud 时同步给云端 pod.
   * Pod 收到后下条 turn 用新值; 不同步会让 cloud agent 还按旧配置跑, 误导用户. */
  const activeSessionId = runtime.activeSession?.id ?? null;
  const activeApprovalMode = useApprovalMode(activeSessionId);
  const activeModelId = (runtime.activeSession as any)?.modelId ?? (runtime as any).selectedModel ?? null;
  const workspaceTitle = (workspace.name || workspace.path.split(/[\\/]/).filter(Boolean).pop() || 'Workspace').trim();
  const sessNameTrim = runtime.activeSession?.name?.trim() ?? '';
  const shouldUseOverride =
    agentModeVariant.workTitleOverride &&
    isDefaultSessionName(sessNameTrim);
  const topTitleZh = getGlobalLanguage() === 'zh';
  const pageTitle = (zh: string, en: string) => (topTitleZh ? zh : en);
  const PAGE_TITLES: Record<string, [string, string]> = {
    knowledge: ['知识库', 'Knowledge'],
    library:   ['文件库', 'Library'],
    plugins:   ['插件',   'Plugins'],
    skills:    ['技能',   'Skills'],
    mcp:       ['MCP',    'MCP'],
    image:     ['图片',   'Images'],
    team:      ['团队',   'Team'],
    tools:     ['工具',   'Tools'],
    settings:  ['设置',   'Settings'],
    projects:  ['项目',   'Projects'],
    project:   ['项目',   'Project'],
  };
  const activeShellWorkTitle = PAGE_TITLES[agentPage as string]
    ? pageTitle(PAGE_TITLES[agentPage as string][0], PAGE_TITLES[agentPage as string][1])
    : (
      shouldUseOverride
        ? agentModeVariant.workTitleOverride!
        /* 库里存的是 "New Chat - 10:18:36 PM" (core 建会话时写死的技术默认名),
         * 中文界面里顶个英文 + 12 小时制一眼出戏。展示时反解, 库里不动。 */
        : displaySessionName(
            sessNameTrim,
            (runtime.activeSession as { createdAt?: number } | null)?.createdAt,
            topTitleZh,
          )
    );
  const lastSyncedRef = useRef<{ sid?: string; mode?: string; model?: string }>({});
  useEffect(() => {
    if (!activeSessionId || activeCloudLocation !== 'cloud') return;
    if (lastSyncedRef.current.sid !== activeSessionId) {
      lastSyncedRef.current = { sid: activeSessionId, mode: activeApprovalMode, model: activeModelId };
      return;
    }
    const last = lastSyncedRef.current;
    const patch: { model_id?: string; approval_mode?: string } = {};
    if (activeApprovalMode && activeApprovalMode !== last.mode) patch.approval_mode = activeApprovalMode;
    /* 占位模型 (default:auto) 不推: 云端拿着它找不到模型 */
    if (activeModelId && !activeModelId.startsWith('default:') && activeModelId !== last.model) patch.model_id = activeModelId;
    if (Object.keys(patch).length === 0) return;
    lastSyncedRef.current = {
      sid: activeSessionId,
      mode: patch.approval_mode ?? last.mode,
      model: patch.model_id ?? last.model,
    };
    void syncSessionConfig(activeSessionId, patch).then((ok) => {
      if (ok) dispatchHint(`已同步到云端: ${patch.model_id ? '模型 ' : ''}${patch.approval_mode ? '审批 ' : ''}`.trim(), 'info');
    });
  }, [activeSessionId, activeCloudLocation, activeApprovalMode, activeModelId, syncSessionConfig]);

  /* picker 挂载时主动 ping — 防止刚挂载错过初始事件 */
  useEffect(() => {
    const handler = () => {
      const cloudActive = activeCloudLocation === 'cloud';
      window.dispatchEvent(new CustomEvent('neox:active-session-cloud-state', {
        detail: { cloudActive },
      }));
    };
    window.addEventListener('neox:request-cloud-state', handler);
    return () => window.removeEventListener('neox:request-cloud-state', handler);
  }, [activeCloudLocation]);

  const agentTimelineCloudMeta = useMemo(() => (
    activeCloudMeta ? {
      fileCount: null,
      lastActiveAt: activeCloudMeta.summary.lastActiveAt,
      podId: null,
      sessionState: activeCloudMeta.summary.state,
    } : undefined
  ), [activeCloudMeta]);

  const handlePullBackActiveCloud = useCallback(() => {
    const id = runtime.activeSession?.id;
    if (id) openMigDialog('pull', id);
  }, [openMigDialog, runtime.activeSession?.id]);

  const handleTerminateActiveCloud = useCallback(async () => {
    const id = runtime.activeSession?.id;
    if (!id) return;
    const confirmed = await confirmAsync({
      title: '销毁云端 session?',
      message: '云端 pod 会立即停止. 本地副本保留, 数据不丢.',
      variant: 'danger',
      confirmLabel: '销毁',
    });
    if (!confirmed) return;
    const ok = await terminateCloud(id);
    if (ok) dispatchHint('云端会话已关闭，本机保留了一份', 'success');
    else dispatchOpFailed({ op: 'cloud-terminate', message: '销毁失败' });
  }, [confirmAsync, dispatchHint, dispatchOpFailed, runtime.activeSession?.id, terminateCloud]);

  /* main 区: 当前页 (默认 AgentTimelineView, rail 不动 main)。
   *  memo 住 —— 父级 Shell 状态 (侧栏/右栏折叠等) 变化时不重渲染整条长 timeline。 */
  const agentView = useMemo(() => (
    agentPage === 'team' ? (
      <Suspense fallback={<PageLoading />}>
        <TeamDashboard
          onLaunched={() => setAgentPage('chat')}
          onClose={closeToolPage}
          onOpenSession={(id) => window.dispatchEvent(new CustomEvent('neox:host-select-session', { detail: id }))}
        />
      </Suspense>
    ) : agentPage === 'plugins' ? (
      <Suspense fallback={<PageLoading />}>
        <PluginMarketplace onClose={closeToolPage} />
      </Suspense>
    ) : agentPage === 'tools' ? (
      <Suspense fallback={<PageLoading />}>
        <ToolsHome onOpen={(id) => window.dispatchEvent(new CustomEvent('neox:open-tool', { detail: id }))} onBack={() => setAgentPage('chat')} hasLibrary />
      </Suspense>
    ) : (agentPage === 'skills' || agentPage === 'mcp') ? (
      /* 技能 / MCP —— 跟隔壁「插件」同级, 在主内容区渲染, 不再弹全屏设置浮层。
       * 复用 SettingsPage 的 embedded 模式: 这两个 tab 的全部逻辑(状态 102 行 +
       * handler 488 行 + 73 个 context 字段)本来就住在 SettingsPage 里,
       * 搬出来会产生双真相源, 让它支持嵌入渲染才是对的。 */
      <Suspense fallback={<PageLoading />}>
        <SettingsPageLazy
          onClose={closeToolPage}
          embedded={{ tab: agentPage }}
        />
      </Suspense>
    ) : agentPage === 'settings' ? (
      /* 整页设置: 同样是 embedded, 区别只在 withNav —— 技能/MCP 是"只看这一页", 设置要能逛 */
      <Suspense fallback={<PageLoading />}>
        <SettingsPageLazy onClose={() => setAgentPage('chat')} embedded={{ withNav: true }} />
      </Suspense>
    ) : agentPage === 'library' ? (
      <Suspense fallback={<PageLoading />}><LibraryPage onClose={closeToolPage} /></Suspense>
    ) : agentPage === 'projects' ? (
      <Suspense fallback={<PageLoading />}>
        <WorkProjectsPage
          zh={getGlobalLanguage() === 'zh'}
          onClose={() => setAgentPage('chat')}
          onOpenProject={(dir) => { setProjectPageDir(dir); setAgentPage('project'); }}
        />
      </Suspense>
    ) : agentPage === 'project' && projectPageDir ? (
      <Suspense fallback={<PageLoading />}>
        <WorkProjectPage
          key={projectPageDir}
          dir={projectPageDir}
          zh={getGlobalLanguage() === 'zh'}
          onBack={() => setAgentPage('chat')}
          onOpenSession={(id) => { handleSelectSession(id); }}
          onNewTask={(p) => startWorkProjectTask(projectPageDir, p)}
        />
      </Suspense>
    ) : agentPage === 'image' ? (
      <Suspense fallback={<PageLoading />}><ImageStudioPage /></Suspense>
    ) : agentPage === 'knowledge' ? (
      <Suspense fallback={<PageLoading />}>
        <KnowledgeBasePage
          onRunCuration={handleRunKnowledgeCuration}
          onOpenSession={handleOpenCurationSession}
          onDigestDocument={handleDigestDocument}
          onClose={closeToolPage}
          onNewNote={() => {
            setAgentPage('chat');
            window.setTimeout(() => {
              window.dispatchEvent(new CustomEvent('neox:composer-fill', { detail: { text: '记到知识库：', focus: true } }));
            }, 80);
          }}
        />
      </Suspense>
    ) : (
      <AgentTimelineView
        onSubmit={handleSubmitPrompt}
        cloudLocation={activeCloudLocation}
        cloudMeta={agentTimelineCloudMeta}
        onPullBackFromCloud={handlePullBackActiveCloud}
        onTerminateCloud={handleTerminateActiveCloud}
        surfacePanelCollapsed={rightPanelCollapsed}
        projectChoices={recentWorkspaces}
        onPickProject={handlePickProjectForEmpty}
        onOpenProjectFolder={onChangeWorkspace}
      />
    )
  ), [
    recentWorkspaces,
    handlePickProjectForEmpty,
    onChangeWorkspace,
    activeCloudLocation,
    agentPage,
    rightPanelCollapsed,
    agentTimelineCloudMeta,
    handlePullBackActiveCloud,
    handleRunKnowledgeCuration,
    handleOpenCurationSession,
    handleDigestDocument,
    handleSubmitPrompt,
    handleTerminateActiveCloud,
    projectPageDir,
    handleSelectSession,
    startWorkProjectTask,
    closeToolPage,
  ]);

  /* 左侧栏: rail 切换的是这里, 不动 main.
   *   · activeNav='explorer' → IdeFileSidebar view='explorer' (聊天时看项目结构, 点文件进右侧面板)
   *   · activeNav='git'      → AgentGitSidebar (复用真版 CommitPanel)
   *   · 其它 (默认 'agent')  → undefined → fallback 到默认 Sidebar (会话列表) */
  const sidebarOverride = useMemo(() => {
    if (activeNav === 'explorer') {
      return <IdeFileSidebar key="file-sidebar" view="explorer" />;
    }
    if (activeNav === 'git') return <AgentGitSidebar workspacePath={workspace.path} />;
    if (sidebarShowWorkspace) {
      return (
        <div className="neox-sidebar__ws-panel" key="ws-panel">
          <IdeFileSidebar
            view="workspace"
            workspaceTarget={sidebarWorkspaceTarget}
            onBack={closeSidebarWorkspace}
          />
        </div>
      );
    }
    return undefined;
  }, [activeNav, closeSidebarWorkspace, sidebarShowWorkspace, sidebarWorkspaceTarget, workspace.path]);

  /* 右栏 = SurfacePanel (有内容展示 surface; 无内容展示 landing page)。
   *   任务详情(RightPanel)已迁出右栏, 改成 TopBar icon 触发的 popover. */
  const surfaceList = useSurfaces(runtime.activeSession?.id);

  /* surface 数量变化不再自动展开右栏 — 用户手动点 TopBar 右栏按钮控制 */

  const prevSurfaceCountRef = useRef(surfaceList.length);
  useEffect(() => {
    const prev = prevSurfaceCountRef.current;
    prevSurfaceCountRef.current = surfaceList.length;
    if (prev > 0 && surfaceList.length === 0 && !rightPanelCollapsed) {
      beginShellLayoutInstant(320);
      setRightPanelCollapsed(true);
      scheduleSurfaceLayout('surface-empty-autocollapse');
    }
  }, [surfaceList.length, rightPanelCollapsed, beginShellLayoutInstant, scheduleSurfaceLayout]);

  useEffect(() => {
    const onSurfacePanelOpenRequested = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const targetSessionId = detail?.sessionId;
      if (targetSessionId && targetSessionId !== runtime.activeSession?.id) return;
      shellPerf.begin('surface-panel-open-requested', { targetSessionId, activeSessionId: runtime.activeSession?.id });
      beginShellLayoutInstant(320);
      setRightPanelCollapsed(false);
      ensureSurfaceVisible();
      scheduleSurfaceLayout('surface-open-requested');
      window.setTimeout(() => shellPerf.end('surface-panel-open-settled'), 360);
    };
    window.addEventListener('neox:surface-panel-open-requested', onSurfacePanelOpenRequested);

    const onRightPanelExpand = () => {
      beginShellLayoutInstant(320);
      setRightPanelCollapsed(false);
      scheduleSurfaceLayout('right-panel-expand');
    };
    window.addEventListener('neox:right-panel:expand', onRightPanelExpand);

    return () => {
      window.removeEventListener('neox:surface-panel-open-requested', onSurfacePanelOpenRequested);
      window.removeEventListener('neox:right-panel:expand', onRightPanelExpand);
    };
  }, [
    beginShellLayoutInstant,
    runtime.activeSession?.id,
    scheduleSurfaceLayout,
  ]);

  useEffect(() => {
    scheduleSurfaceLayout('shell-layout-state');
  }, [rightPanelCollapsed, scheduleSurfaceLayout, sidebarCollapsed]);

  /* layout 现在主要靠 CSS 自动比例:
   *     · sidebar 收 + surface 开 → main : surface = 1:1
   *     · sidebar 开 + surface 开 → sidebar : main : surface = 1:2:2
   *   左侧收起完全由用户手动 toggle, 打开 surface / 展开右栏不再代劳. */
  /* 右栏折叠时只从 layout/paint 树移除 (CSS), 不卸载 SurfacePanel —— 重新展开不重新 mount。 */
  const panelLayoutMode = usePanelLayout();
  const activePanelTab = useActivePanelTab();
  const surfaceTabFront = panelLayoutMode === 'tabs' && activePanelTab === 'surface';
  const rightStackCollapsed = rightPanelCollapsed && !surfaceTabFront;
  const rightPanelOverride = useMemo(() => (
    <div
      className="neox-shell__right-stack"
      data-collapsed={rightStackCollapsed ? 'true' : 'false'}
    >
      <div className="neox-shell__right-mode-pane">
        <SurfacePanel />
      </div>
    </div>
  ), [rightStackCollapsed]);

  const handleRenameSession = useCallback((id: string, name: string) => {
    void runtime.renameSession(id, name);
  }, [runtime]);
  const handleDeleteSession = useCallback((id: string) => {
    void runtime.deleteSession(id);
  }, [runtime]);
  const handleExportSession = useCallback((id: string) => {
    void runtime.exportSession(id, 'md');
  }, [runtime]);
  const handleRenameWorkspace = useCallback(async (path: string, newName: string) => {
    try {
      await (window as any).neox?.setWorkspaceName?.(path, newName);
    } catch { /* ignore */ }
  }, []);
  const handleShowWorkspacePanel = useCallback((workspacePath?: string) => {
    setSidebarWorkspaceTarget(workspacePath);
    setSidebarShowWorkspace(true);
  }, []);
  const handleOpenKnowledgeBase = useEvent(() => {
    if (agentPage === 'knowledge') { setAgentPage('chat'); return; }   // 见 handleOpenSkills 注释
    setAgentPage('knowledge');
    setActiveNav('agent');
    setSidebarShowWorkspace(false);
    if (sidebarCollapsed) setSidebarCollapsedSmooth(false);
  });
  /* 技能 / MCP —— 走 utility page (跟插件同级), 不再 openSettingsTab 弹浮层 */
  const handleOpenSkills = useEvent(() => {
    if (agentPage === 'skills') { setAgentPage('chat'); return; }
    setAgentPage('skills');
    setActiveNav('agent');
    setSidebarShowWorkspace(false);
    if (sidebarCollapsed) setSidebarCollapsedSmooth(false);
  });
  const handleOpenMcp = useEvent(() => {
    if (agentPage === 'mcp') { setAgentPage('chat'); return; }   // 见 handleOpenSkills 注释
    setAgentPage('mcp');
    setActiveNav('agent');
    setSidebarShowWorkspace(false);
    if (sidebarCollapsed) setSidebarCollapsedSmooth(false);
  });
  const handleOpenTeam = useEvent(() => {
    if (agentPage === 'team') { setAgentPage('chat'); return; }   // 见 handleOpenSkills 注释
    if (!agentModeVariant.isCode) {
      pagePendingModeRef.current = 'team';
      setActiveNav('agent');
      window.dispatchEvent(new CustomEvent('neox:switch-mode', { detail: { mode: 'code', quiet: true } }));
      return;
    }
    setAgentPage('team');
    setActiveNav('agent');
    setSidebarShowWorkspace(false);
  });
  const handleOpenLibrary = useEvent(() => {
    if (agentPage === 'library') { setAgentPage('chat'); return; }   // 见 handleOpenSkills 注释
    setAgentPage('library');
    setActiveNav('agent');
    setSidebarShowWorkspace(false);
    if (sidebarCollapsed) setSidebarCollapsedSmooth(false);
  });
  const handleOpenPlugins = useEvent(() => {
    if (agentPage === 'plugins') { setAgentPage('chat'); return; }   // 见 handleOpenSkills 注释
    setAgentPage('plugins');
    setActiveNav('agent');
    setSidebarShowWorkspace(false);
    if (sidebarCollapsed) setSidebarCollapsedSmooth(false);
  });
  const handleOpenTools = useEvent(() => {
    if (agentPage === 'tools') { setAgentPage('chat'); return; }
    setFromTools(false);
    setAgentPage('tools');
    setActiveNav('agent');
    setSidebarShowWorkspace(false);
    if (sidebarCollapsed) setSidebarCollapsedSmooth(false);
  });
  const pagePendingModeRef = useRef<typeof agentPage | null>(null);
  useEffect(() => {
    const onModeChanged = () => {
      const next = pagePendingModeRef.current;
      pagePendingModeRef.current = null;
      /* 切模式是为了开某页的 (从工具主页点团队), 返回照旧回工具主页 */
      if (!next) setFromTools(false);
      setAgentPageRaw((p) => next ?? (p === 'chat' ? p : 'chat'));
    };
    window.addEventListener('neox:agent-mode-default-changed', onModeChanged);
    return () => window.removeEventListener('neox:agent-mode-default-changed', onModeChanged);
  }, []);
  /* 回到任务 / 设置 / 项目页 = 离开了工具这一摞, 下次从侧栏直接开的工具页就该回任务 */
  useEffect(() => {
    if (agentPage === 'chat' || agentPage === 'settings' || agentPage === 'projects' || agentPage === 'project') setFromTools(false);
  }, [agentPage]);

  /* 图片工作台 — 懒创建 (见下).
   *
   * 这个**刻意不做"再点一次退回"** (其余六个入口都做了)。
   * 那六个是**浏览型**页面 (技能/知识库/文件库/插件/MCP/团队): 进去看一眼就出来,
   * 退回去零代价。图片工作台不是 —— 它是个**带草稿的工作面**: 用户可能已经敲了半条
   * prompt、选好了参考图, 而这些在真正发送前不落会话 (见下面懒创建那段)。
   * 给它配一个"手滑点两下就退出去"的行为, 代价是把没保存的东西弄丢。
   * 想退出用左边的会话列表, 那是个需要瞄准的动作, 正合适。 */
  const handleOpenImageStudio = useCallback(() => {
    setAgentPage('image');
    setActiveNav('agent');
    setSidebarShowWorkspace(false);
    if (sidebarCollapsed) setSidebarCollapsedSmooth(false);
  }, [setAgentPage, setSidebarCollapsedSmooth, sidebarCollapsed]);

  const handleNewImageSession = useCallback(() => {
    setAgentPage('image');
    setActiveNav('agent');
    setSidebarShowWorkspace(false);
    if (sidebarCollapsed) setSidebarCollapsedSmooth(false);
    window.dispatchEvent(new CustomEvent('neox:image-new-canvas'));
  }, [setAgentPage, setSidebarCollapsedSmooth, sidebarCollapsed]);

  useEffect(() => {
    const on = (e: Event) => { const id = (e as CustomEvent<string>).detail; if (id) openFromTools(id); };
    window.addEventListener('neox:open-tool', on);
    return () => window.removeEventListener('neox:open-tool', on);
  }, []);
  const openFromTools = useEvent((id: string) => {
    setFromTools(true);
    switch (id) {
      case 'skills': handleOpenSkills(); break;
      case 'mcp': handleOpenMcp(); break;
      case 'knowledge': handleOpenKnowledgeBase(); break;
      case 'image': handleOpenImageStudio(); break;
      case 'plugins': handleOpenPlugins(); break;
      case 'library': handleOpenLibrary(); break;
      case 'team': handleOpenTeam(); break;
      default: break;
    }
  });

  const imgDraftGcRef = useRef(false);
  useEffect(() => {
    if (imgDraftGcRef.current) return;
    const api = (window as any).neox;
    if (!api?.imageListTurns || runtime.sessions.length === 0) return;
    imgDraftGcRef.current = true;
    const activeId = (runtime.activeSession as { id?: string } | null)?.id;
    const drafts = runtime.sessions.filter((s) =>
      (s as { kind?: string }).kind === 'image' && s.id !== activeId && isDefaultSessionName((s as { name?: string }).name));
    void (async () => {
      for (const s of drafts) {
        try { const rows = await api.imageListTurns(s.id); if (Array.isArray(rows) && rows.length === 0) void runtime.deleteSession(s.id); }
        catch { /* skip */ }
      }
    })();
  }, [runtime, runtime.sessions.length]);

  useEffect(() => {
    const onGoto = async (e: Event) => {
      const path = (e as CustomEvent).detail?.path as string | undefined;
      if (!path) return;
      const api = (window as any).neox;
      if (!api?.imageListTurns) return;
      const imgSessions = runtime.sessions.filter((s) => (s as { kind?: string }).kind === 'image');
      for (const s of imgSessions) {
        try {
          const rows = await api.imageListTurns(s.id);
          if (!Array.isArray(rows)) continue;
          const hit = rows.some((r: { payload?: string }) => {
            try {
              const t = JSON.parse(r.payload || '{}');
              const paths: string[] = t?.result?.paths || [];
              return paths.includes(path) || paths.some((pp) => { const fn = pp ? pp.split('/').pop() : ''; return !!fn && path.endsWith(fn); });
            } catch { return false; }
          });
          if (hit) {
            runtime.selectSession(s.id);
            setAgentPage('image');
            setActiveNav('agent');
            return;
          }
        } catch { /* 下一个 */ }
      }
      dispatchHint('没找到这张图对应的会话 (可能会话已删, 但图还在图库)', 'info');
    };
    window.addEventListener('neox:image-goto-session', onGoto as EventListener);
    return () => window.removeEventListener('neox:image-goto-session', onGoto as EventListener);
  }, [runtime]);

  useEffect(() => {
    const onOpenPluginView = async (e: Event) => {
      const v = (e as CustomEvent).detail as { pluginName?: string; id?: string; title?: string; entry?: string } | undefined;
      if (!v?.pluginName || !v.id || !v.entry) return;
      setAgentPage('chat');
      setActiveNav('agent');
      if (!runtime.activeSession?.id) {
        try { await runtime.createNewSession?.(); } catch { /* 建不了会话 (没模型) 就只切页, 不静默卡住 */ }
      }
      window.setTimeout(() => {
        window.dispatchEvent(new CustomEvent('neox:open-surface', {
          detail: {
            kind: 'plugin',
            title: v.title,
            source: { type: 'url', url: pluginViewUrl({ pluginName: v.pluginName!, entry: v.entry! }) },
            metadata: { pluginName: v.pluginName, viewId: v.id },
            byUser: true,
          },
        }));
        window.dispatchEvent(new CustomEvent('neox:surface-panel-open-requested', { detail: {} }));
      }, 300);
    };
    window.addEventListener('neox:open-plugin-view', onOpenPluginView);
    return () => window.removeEventListener('neox:open-plugin-view', onOpenPluginView);
  }, [runtime]);

  /* 成品架: 首页右下角「成品架 N」按钮发这个事件 (UI 3.0) —— 只打开, 不像侧栏入口那样再点一次收起 */
  useEffect(() => {
    const onOpenShelf = () => {
      setAgentPage('library');
      setActiveNav('agent');
    };
    window.addEventListener('neox:open-shelf', onOpenShelf);
    return () => window.removeEventListener('neox:open-shelf', onOpenShelf);
  }, [setAgentPage]);

  /* 对话里点 neox://plugins/<name> (agent 推荐的插件) → 切到插件页; 打开哪个插件由插件页自己取 (pluginFocus) */
  useEffect(() => {
    const onOpenStore = () => {
      setActiveNav('agent');
      setAgentPage('plugins');
    };
    window.addEventListener('neox:open-plugin-store', onOpenStore);
    return () => window.removeEventListener('neox:open-plugin-store', onOpenStore);
  }, [setAgentPage]);

  const handleToggleSidebar = useCallback(() => setSidebarCollapsedSmooth((v) => !v), [setSidebarCollapsedSmooth]);
  const handleToggleRightPanel = useCallback(() => {
    shellPerf.begin('right-panel-toggle', { collapsed: rightPanelCollapsed });
    beginShellLayoutInstant(320);
    /* 展开右栏不再顺便收左侧会话栏 — 布局选择交给用户 */
    if (agentPage !== 'chat') {
      /* 工具页上右栏默认收着 (见下面 rightPanelCollapsed 传参); 用户在这儿点开关 = 明说要看, 就开 */
      const open = !(rightPanelCollapsed || !surfaceOnPage);
      setSurfaceOnPage(!open);
      if (!open) setRightPanelCollapsed(false);
    } else {
      setRightPanelCollapsed((v) => !v);
    }
    scheduleSurfaceLayout('right-panel-toggle');
    window.setTimeout(() => shellPerf.end('right-panel-toggle-settled'), 360);
  }, [beginShellLayoutInstant, scheduleSurfaceLayout, rightPanelCollapsed, agentPage, surfaceOnPage]);

  const onShellProfilerRender = useCallback<ProfilerOnRenderCallback>((id, phase, actualMs, baseMs, startTime, commitTime) => {
    if (actualMs >= 6 || phase === 'mount') {
      shellPerf.mark('react-profiler', {
        id,
        phase,
        actualMs: Math.round(actualMs * 10) / 10,
        baseMs: Math.round(baseMs * 10) / 10,
        startTime: Math.round(startTime * 10) / 10,
        commitTime: Math.round(commitTime * 10) / 10,
        rightPanelCollapsed,
        sidebarCollapsed,
      });
    }
  }, [rightPanelCollapsed, sidebarCollapsed]);

  const handlePushSessionToCloudStable = useEvent((id: string) => openMigDialog('push', id));
  const handlePullSessionToLocalStable = useEvent((id: string) => openMigDialog('pull', id));
  const handleMoveSessionToWorkspaceStable = useEvent((...a: Parameters<typeof handleMoveSessionToWorkspace>) => { void handleMoveSessionToWorkspace(...a); });
  const handleOpenSettingsStable = useEvent(() => handleOpenSettingsPage());
  const currentWorkspaceStable = useMemo(() => ({ path: workspace.path, name: workspace.name, roots: (workspace as any).roots }),
    [workspace.path, workspace.name, (workspace as any).roots]);
  const recentWorkspacesStable = useMemo(() => recentWorkspaces?.map((w) => ({ path: w.path, name: w.name, roots: (w as any).roots })) ?? [],
    [recentWorkspaces]);

  return (
    <>
      <React.Profiler id="ShellInner.NeoxShell" onRender={onShellProfilerRender}>
      <NeoxShell
        loading={loading}
        activeNav={activeNav}
        onChangeNav={handleRailSelect}
        agentMode={sessionAgentModeForLayout === 'work' || sessionAgentModeForLayout === 'code' || sessionAgentModeForLayout === 'pilot' ? sessionAgentModeForLayout : null}
        title="Neox Agent"
        workTitle={activeShellWorkTitle}
        fullPage={agentPage === 'settings'}
        onOpenSettings={handleOpenSettingsStable}
        onToggleTheme={onToggleTheme}
        sessions={filteredSessionItems}
        sessionsLoading={runtime.sessionsLoading}
        activeSessionId={runtime.activeSession?.id ?? null}
        streaming={runtime.streaming}
        runningSessionIds={runtime.runningSessionIds}
        onNewSession={handleNewSession}
        /* admin 关掉云端 → undefined → Sidebar caret 不渲染. */
        onNewCloudSession={cloudFlags.createEnabled ? handleNewCloudSession : undefined}
        onSelectSession={handleSelectSession}
        onRenameSession={handleRenameSession}
        onDeleteSession={handleDeleteSession}
        onExportSession={handleExportSession}
        onPushSessionToCloud={handlePushSessionToCloudStable}
        onPullSessionToLocal={handlePullSessionToLocalStable}
        currentAgentMode={filterMode}
        onMoveSessionToWorkspace={handleMoveSessionToWorkspaceStable}
        modeHomes={modeHomes}
        currentWorkspace={currentWorkspaceStable}
        recentWorkspaces={recentWorkspacesStable}
        onSelectWorkspace={onSelectWorkspace}
        onAddWorkspace={onChangeWorkspace}
        onRemoveWorkspace={onRemoveWorkspace}
        onRenameWorkspace={handleRenameWorkspace}
        onShowWorkspacePanel={handleShowWorkspacePanel}
        onCreateSessionInWorkspace={onCreateSessionInWorkspace}
        onManageWorkspaces={onGoHome}
        onOpenKnowledgeBase={handleOpenKnowledgeBase}
        onOpenSkills={handleOpenSkills}
        onOpenMcp={handleOpenMcp}
        onOpenLibrary={handleOpenLibrary}
        onOpenImageStudio={handleOpenImageStudio}
        onOpenFileExplorer={handleOpenFileExplorer}
        onNewImageSession={handleNewImageSession}
        onOpenTeam={handleOpenTeam}
        onOpenPlugins={handleOpenPlugins}
        onOpenTools={handleOpenTools}
        activeUtility={agentPage === 'skills' ? 'skills' : agentPage === 'mcp' ? 'mcp' : agentPage === 'knowledge' ? 'knowledge' : agentPage === 'library' ? 'library' : agentPage === 'image' ? 'image' : agentPage === 'team' ? 'team' : agentPage === 'plugins' ? 'plugins' : null}
        sidebarOverride={pilotOnChat ? (pilotShell.sidebar ?? sidebarOverride) : sidebarOverride}
        rightPanel={pilotOnChat ? (pilotShell.rightPanel ?? rightPanelOverride) : rightPanelOverride}
        rightPanelCollapsed={pilotOnChat ? (pilotShell.rightPanelCollapsed ?? rightPanelCollapsed) : (rightPanelCollapsed || (agentPage !== 'chat' && !surfaceOnPage))}
        layoutInstant={shellLayoutInstant}
        onToggleRightPanel={handleToggleRightPanel}
        sidebarCollapsed={pilotOnChat ? (pilotShell.sidebarCollapsed ?? sidebarCollapsed) : sidebarCollapsed}
        onToggleSidebar={handleToggleSidebar}
        onSearch={handleSearch}
        onOpenAccount={() => {
          try { localStorage.setItem('neox-settings-initial-tab', 'account'); } catch { /* ignore */ }
          window.dispatchEvent(new CustomEvent('neox:open-settings', {
            detail: { tab: 'account', from: 'avatar-menu' },
          }));
        }}
      >
        <div className="neox-shell__tab-stack">
          <div className="neox-shell__tab-pane">
            {pilotOnChat ? pilotShell.wrapMain(agentView) : fromTools && agentPage !== 'tools' && agentPage !== 'chat' ? (
              /* 从「工具」主页进来的工具页: 返回写「工具」; 自己没有返回按钮的页 (技能 / MCP / 图片) 顶上补一条 (成品架自带返回, 读同一个 context) */
              <ToolBackLabelContext.Provider value={getGlobalLanguage() === 'zh' ? '工具' : 'Tools'}>
                {(agentPage === 'skills' || agentPage === 'mcp' || agentPage === 'image') ? (
                  <div className={`tp-backwrap${agentPage === 'skills' || agentPage === 'mcp' ? ' is-settings' : ''}`}>
                    <div className="tp-backwrap__bar"><ToolBackButton onBack={closeToolPage} zh={getGlobalLanguage() === 'zh'} /></div>
                    <div className="tp-backwrap__page">{agentView}</div>
                  </div>
                ) : agentView}
              </ToolBackLabelContext.Provider>
            ) : agentView}
          </div>
        </div>
      </NeoxShell>
      </React.Profiler>
      {pilotShell.overlays}
      <TerminalRequestManager />
      <DiagnosticsRequestManager />
      {/* 首次进入主界面的 4 步悬浮引导 (锚到真实 UI)。自行按 localStorage 决定弹不弹, 只在对话页 (锚点存在)。 */}
      <TourOverlay enabled={!loading && agentPage === 'chat' && !!workspace.path} />
      {loginPromptOpen && (
        <UiSlot name="auth.login" props={{
          onClose: () => setLoginPromptOpen(false),
          onSuccess: () => setLoginPromptOpen(false),
        }} />
      )}
      <SessionSearchPalette
        open={sessionSearchOpen}
        onClose={() => setSessionSearchOpen(false)}
        sessions={runtime.sessions}
        onSelect={handleSelectSession}
      />
      <CloudGitConfigDialog
        open={!!gitDialog}
        analysis={gitDialog?.analysis ?? null}
        sessionTitle={gitDialog?.title ?? ''}
        onConfirm={onGitConfigConfirm}
        onCancel={() => setGitDialog(null)}
        onUploadInstead={() => {
          /* 用户选 "改走上传 (慢)" — 关 git dialog, 开常规 upload dialog */
          if (!gitDialog) return;
          const g = gitDialog;
          setGitDialog(null);
          setMigDialog({
            mode: 'push',
            sessionId: g.sessionId,
            title: g.title,
            workspacePath: g.workspacePath,
            modelId: g.modelId,
          });
          setMigProgress(null);
          setMigOutcome(null);
          setMigError(undefined);
          setMigNotLoggedIn(false);
        }}
      />
      <CloudMigrationDialog
        open={!!migDialog}
        mode={migDialog?.mode ?? 'push'}
        session={migDialog ? {
          id: migDialog.sessionId,
          title: migDialog.title,
          workspacePath: migDialog.workspacePath,
          modelId: migDialog.modelId,
        } : null}
        progress={migProgress}
        outcome={migOutcome}
        errorMessage={migError}
        notLoggedIn={migNotLoggedIn}
        onConfirm={() => void startMigration()}
        onCancel={() => { setMigDialog(null); setMigProgress(null); setMigOutcome(null); setMigNotLoggedIn(false); }}
        onClose={() => { setMigDialog(null); setMigProgress(null); setMigOutcome(null); setMigNotLoggedIn(false); }}
        onGoLogin={() => {
          setMigDialog(null);
          /* 打开 Settings → Mobile/远程访问 tab — settings page 读 SETTINGS_INITIAL_TAB_KEY */
          handleOpenSettingsPage('mobile');
        }}
      />
    </>
  );
};

export default NeoxShellHost;
