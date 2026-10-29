/// <reference path="../global.d.ts" />
import React, { Activity, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../state/appStore';
import NeoxShellHost from './NeoxShellHost';
import '../modules/voice-mode/voice-mode.css';

const SettingsPage = React.lazy(() => import('../pages/settings/SettingsPage'));
const VoiceMode = React.lazy(() =>
  import('../modules/voice-mode/VoiceMode').then((m) => ({ default: m.VoiceMode })),
);
// PluginMarketplace 已集成到 WorkspacePage 的 viewMode 切换中
const OnboardingPage = React.lazy(() => import('../pages/onboarding/OnboardingPage'));
const OnboardingV3 = React.lazy(() => import('../pages/onboarding/OnboardingV3'));
import type { AppInfo, WorkspaceState, MenuAction } from '../../shared/ipc';
import { useEditorLinkReceiver } from './useEditorLinkReceiver';
import { useI18n } from '../hooks/useI18n';
import { UiSlot } from '../modules/shell/uiSlots';
import { getEditionHook, useEditionAppShellEffects } from '../modules/shell/editionHooks';
import { NotifyToastHost, dispatchHint, dispatchOpFailedFromError } from '../components/notifyEvents';
import { ReminderAlertHost } from '../components/ReminderAlertHost';
import { ConfirmDialogHost, PromptDialogHost } from '../components/confirmEvents';
import { UpdateReadyHost } from '../components/UpdateReadyHost';
import { DailyLoginsAskHost } from '../components/DailyLoginsAskHost';
import { SpotlightHost } from '../modules/spotlight/SpotlightHost';
import ErrorBoundary from '../components/ErrorBoundary';
import { usePetWindowSync } from '../modules/pet';
import { usePilotCallController } from '../modules/pilot/usePilotCallController';
import { diagnosticsRecorder } from '../perf/diagnosticsRecorder';
import { installWinTitleBarSync, syncWinTitleBar } from '../utils/winTitleBarSync';
/* Phase E · 一旦 renderer 启动就订阅 IPC heartbeat（只记健康状态，不弹 toast）。 */
import '../state/ipcHealthStore';
import { useDensity } from '../hooks/useDensity';
import { canSkipWelcome, hasByokConfigured, isForceWelcome } from './welcomeGate';
import { FeatureIntroHost, showFeatureIntro } from '../components/featureIntro/FeatureIntro';

/** 工作区路径已从磁盘消失 / 不可访问 — 应静默清记录, 不要 error toast 轰炸. */
function isMissingWorkspaceError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /工作区路径不存在|Workspace path does not exist|ENOENT|no such file or directory/i.test(msg);
}

// ==================== HTML Splash 控制 ====================
// HTML 骨架屏 (#app-skeleton) 在 index.html 已渲染。
// React 完成初始化后再淡出移除，避免双重 splash 闪烁。
function dismissHtmlSplash() {
  const el = document.getElementById('app-skeleton');
  if (!el) return;
  /* 进那份无条件落盘的启动面包屑 —— 有这一行就说明首屏走通了, 卡住的排查可以直接
   * 跳过整条启动链路 (见 electron/bootstrap/startupBreadcrumb.ts)。 */
  try { (window as any).neox?.logDebug?.('STARTUP', 'splash dismissed (first screen ready)'); } catch { /* ignore */ }
  el.classList.add('fading');
  setTimeout(() => el.remove(), 260);
}

function EnterTransitionScreen({ out = false }: { out?: boolean }) {
  return (
    <div
      className={`app-enter-transition${out ? ' app-enter-transition--out' : ''}`}
      aria-hidden="true"
    >
      {/* 跟 index.html 启动骨架同一套 (新标: 白环 + 沿环转的蓝球 + neox 字标) */}
      <div className="sk-mark">
        <img className="sk-mark__ring" src="./brand/motion-ring.webp" alt="" draggable={false} />
        <span className="sk-mark__orbit"><img className="sk-mark__ball" src="./brand/motion-ball.webp" alt="" draggable={false} /></span>
      </div>
      <div className="sk-word" />
      <div className="sk-hint" style={{ visibility: 'hidden', animation: 'none' }}>
        <span className="sk-hint__zh">正在启动</span>
      </div>
    </div>
  );
}

function OverlaySuspenseVeil() {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed', inset: 0, zIndex: 8500,
        display: 'grid', placeItems: 'center',
        background: 'color-mix(in srgb, var(--neox-bg-canvas, #1f1f1f) 55%, transparent)',
        backdropFilter: 'blur(2px)',
        WebkitBackdropFilter: 'blur(2px)',
        pointerEvents: 'none',
      }}
    >
      <div className="sk-dots"><i /><i /><i /></div>
    </div>
  );
}

// ==================== 主 App 组件 ====================
const App = () => {
  /* BYOK/未登录用户不依赖 NeoxCloud. 主工作台不再常驻探活或显示云端不可达横幅;
   * 云端状态只在账户/订阅等主动进入的页面里局部处理。 */
  /* 发行版常驻副作用: 带账号体系的发行版在这里把服务端 plan_model_rates 同步成本地
   * 'neox-cloud' provider, 并把会员档写到 <html data-plan-skin>。公开构建为空。 */
  useEditionAppShellEffects();
  /* 桌宠独立窗口生命周期 — petConfig.enabled toggle → spawn/destroy pet BrowserWindow.
   *   挂在 AppShell 顶层而不是 PetTab 内, 是因为 PetTab 关闭后用户切到 cfg 也得继续 sync. */
  usePetWindowSync();
  /* 高度响应式 density — 监听 window.innerHeight, ≥900px 自动切 roomy 模式.
   *   写 <html data-density / data-density-active> 给 CSS density.css 触发样式切换.
   *   用户可在 settings 强制 'compact' / 'roomy' / 'auto'. */
  useDensity();

  useEffect(() => { diagnosticsRecorder.install(); }, []);

  const [settingsPrewarm, setSettingsPrewarm] = useState(false);
  useEffect(() => {
    const warm = () => setSettingsPrewarm(true);
    const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    if (typeof ric === 'function') {
      const id = ric(warm, { timeout: 6000 });
      return () => {
        const cancel = (window as unknown as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback;
        cancel?.(id);
      };
    }
    const t = window.setTimeout(warm, 3000);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    void import('../state/providerHealthScheduler')
      .then((m) => m.startProviderHealthScheduler())
      .catch(() => { /* noop */ });
  }, []);

  useEffect(() => {
    void import('../services/wakeWordClient').then(m => m.installWakeWordClient()).catch(() => { /* noop */ });
  }, []);

  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const { theme, themePreference, setTheme: setThemePreference, toggleTheme, workspace, setWorkspace } = useAppStore();
  /* 给上面的 workspace-changed 监听器读当前值用 —— 放进依赖会让它每次切换都重订阅 */
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const [recentWorkspaces, setRecentWorkspaces] = useState<WorkspaceState[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  /* 「接模型」浮层 —— 引导里那套选服务商/填 Key, 单独拎出来用 (见 OnboardingPage connectOnly)。
   * 入口: 欢迎页「使用 BYOK 继续」、输入框「去配置」, 统一派 neox:open-model-connect。 */
  const [modelConnect, setModelConnect] = useState<null | 'choose' | 'byok'>(null);
  // Plugins 已集成到 WorkspacePage viewMode，不需要单独状态
  const [providerVersion, setProviderVersion] = useState(0);
  const [showOnboarding, setShowOnboarding] = useState<boolean | null>(null); // null = loading
  const inMainShellRef = useRef(false);
  inMainShellRef.current = showOnboarding === false && !!workspace;
  const { language } = useI18n(); /* language 供 ReminderAlertHost 用; hook 触发语言切换 re-render */
  const workspacePathRef = useRef<string | null>(null);
  const workspaceStateRef = useRef<WorkspaceState | null>(null);

  useEffect(() => {
    workspacePathRef.current = workspace?.path ?? null;
    workspaceStateRef.current = workspace ?? null;
  }, [workspace]);

  /* 启动时同步诊断日志开关 — localStorage 和 main 的 cli-debug pref 是同一个开关
   * 的两面, 老版本只翻 localStorage, 新版要把两边对齐, 否则用户看到 toggle 显示开
   * 但 ~/.neox/logs/neox-app-*.log 没东西. 一次性同步, 以 localStorage 为准
   * (用户在 UI 上点过的最权威). */
  useEffect(() => {
    if (typeof window === 'undefined' || !window.neox) return;
    const localPref = localStorage.getItem('neox-ui-debug') === '1';
    void (async () => {
      try {
        const remotePref = await window.neox.getCliDebugPreference();
        if (localPref !== remotePref) {
          await window.neox.setCliDebugPreference(localPref);
        }
      } catch { /* noop — 老版本 preload 可能没这个 IPC, 忽略 */ }
    })();
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (appInfo?.platform) {
      document.documentElement.setAttribute('data-platform', appInfo.platform);
    } else {
      document.documentElement.removeAttribute('data-platform');
    }
  }, [appInfo?.platform]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const apply = () => {
      document.documentElement.toggleAttribute('data-window-hidden', document.hidden);
    };
    apply();
    document.addEventListener('visibilitychange', apply);
    return () => document.removeEventListener('visibilitychange', apply);
  }, []);

  /* 窗口全屏 → :root[data-fullscreen]。
   * macOS 原生全屏在 renderer 侧完全不可见 (`:fullscreen` 伪类 / fullscreenElement
   * 都是 HTML Fullscreen API 的东西, 跟窗口全屏无关), 只能由主进程推。
   * 顶栏据此撤掉红绿灯安全区 —— 全屏时系统把红绿灯收走了, 那块预留就是纯空白。 */
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const apply = (full: boolean) => {
      if (full) document.documentElement.setAttribute('data-fullscreen', '1');
      else document.documentElement.removeAttribute('data-fullscreen');
    };
    const off = (window as any).neox?.onWindowFullScreenChanged?.(apply);
    return () => { try { off?.(); } catch { /* ignore */ } apply(false); };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const lifeApi = (window as { neox?: { lifeEvents?: {
      onReminderActivated?: (cb: (p: { eventId: string; sessionId: string | null; title: string; context?: string }) => void) => () => void;
      onReminderFired?: (cb: (p: { eventId: string; sessionId: string | null; title: string; context?: string; scheduledAt?: number; firedAt?: number }) => void) => () => void;
    } } }).neox?.lifeEvents;
    if (!lifeApi) return;
    const offs: Array<() => void> = [];
    if (typeof lifeApi.onReminderActivated === 'function') {
      const off = lifeApi.onReminderActivated((payload) => {
        /* 打开原会话 (如果还在): dispatch 全局事件, sessions 层监听后 selectSession */
        if (payload.sessionId) {
          try { window.dispatchEvent(new CustomEvent('neox:select-session', { detail: { sessionId: payload.sessionId } })); }
          catch { /* ignore */ }
        }
        /* 填 composer: 用 title + context 组成续问 hint */
        const hint = payload.context
          ? `[提醒] ${payload.title}\n${payload.context}\n\n要不要现在办?`
          : `[提醒] ${payload.title}\n\n要不要现在办?`;
        /* 稍延一点让 selectSession 生效再填 composer */
        setTimeout(() => {
          try { window.dispatchEvent(new CustomEvent('neox:composer-fill', { detail: { text: hint, focus: true } })); }
          catch { /* ignore */ }
        }, 300);
      });
      offs.push(off);
    }
    if (typeof lifeApi.onReminderFired === 'function') {
      const off = lifeApi.onReminderFired((payload) => {
        try {
          const rawTitle = payload.title || '';
          const hasLeadingClock = /^\s*[⏰⏳⏱\u{1F514}\u{1F556}]/u.test(rawTitle);
          const prefix = hasLeadingClock ? '' : '⏰ ';
          const line = payload.context
            ? `${prefix}${rawTitle} — ${payload.context}`
            : `${prefix}${rawTitle}`;
          window.dispatchEvent(new CustomEvent('neox:hint', { detail: { message: line, tone: 'info' } }));
          /* debug log 仅 DEV — 生产控制台不刷 (审计 P2) */
          if (import.meta.env.DEV) {
            // eslint-disable-next-line no-console
            console.log('🔔 [renderer] life-reminder:fired', payload);
          }
        } catch { /* ignore */ }
      });
      offs.push(off);
    }
    return () => { for (const off of offs) { try { off(); } catch { /* ignore */ } } };
  }, []);

  const [voiceModeOpen, setVoiceModeOpen] = useState(false);
  const { call: pilotCall, end: endPilotCall } = usePilotCallController();
  useEffect(() => {
    const toggle = () => setVoiceModeOpen(v => !v);
    const open = () => setVoiceModeOpen(true);
    window.addEventListener('neox:voice-mode-toggle', toggle);
    window.addEventListener('neox:voice-mode-open', open);
    return () => {
      window.removeEventListener('neox:voice-mode-toggle', toggle);
      window.removeEventListener('neox:voice-mode-open', open);
    };
  }, []);
  /* 第一次进语音对话: 弹一次怎么用 (说完自动发 / 点圆球打断 / Esc 结束) */
  useEffect(() => { if (voiceModeOpen) showFeatureIntro('voice-mode'); }, [voiceModeOpen]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const nextTitle = workspace?.name?.trim() || 'Neox';
    if (document.title !== nextTitle) {
      document.title = nextTitle;
    }
  }, [workspace?.name]);


  const addRecentWorkspace = useCallback((ws: WorkspaceState) => {
    setRecentWorkspaces(prev => {
      const filtered = prev.filter(item => item.path !== ws.path);
      return [ws, ...filtered].slice(0, 5);
    });
  }, []);

  /* 从侧栏 recent 列表移除一个工作区 — 不动磁盘文件,只是把它从最近列表里去掉.
   * 当前打开的工作区不允许从这里移除,UI 层已经隐藏了入口. */
  const handleRemoveWorkspace = useCallback((path: string) => {
    if (workspaceStateRef.current?.path === path) return;
    setRecentWorkspaces(prev => prev.filter(item => item.path !== path));
  }, []);

  /* 切换工作区 — 老的 320ms 假延迟 loading overlay 已撤掉.
   * 用户决定: 现在切换简单走 IPC + setWorkspace, 不再撑骨架; 以后遇到超大项目卡顿,
   * 再单独做精细的加载反馈 (异步预热 ProjectScope / 局部 placeholder 等).
   * 切换体验上, AppShell 的 key={workspace.path} 会触发子树重挂, 中间空白几百 ms 可接受.
   *
   * Wave (4.5): 轻量 transient overlay — IPC 期间 ms 级 + 子树挂载 ~300ms 期间用户感觉
   * "点了没反应". 加一个 switching state 显简单 spinner "切到 X 中...", 真 IPC 跑完 + 一帧
   * 后自动撤. 不假延迟, 不阻断子树挂载. */
  const [switching, setSwitching] = useState<string | null>(null);
  const wsSwitchSeqRef = useRef(0);
  const wsSwitchInflightRef = useRef(0);
  const wsSwitchQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const openWorkspaceWithLoading = useCallback(async (path: string, addToRecent: boolean = true, silent: boolean = false) => {
    const seq = ++wsSwitchSeqRef.current;
    if (wsSwitchInflightRef.current === 0 && workspacePathRef.current === path && workspaceStateRef.current) return workspaceStateRef.current;
    wsSwitchInflightRef.current += 1;
    const run = wsSwitchQueueRef.current.catch(() => undefined).then(() => (
      seq === wsSwitchSeqRef.current ? applyWorkspaceSwitch(path, addToRecent, silent, seq) : null
    ));
    wsSwitchQueueRef.current = run;
    try {
      return await run;
    } finally {
      wsSwitchInflightRef.current -= 1;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- applyWorkspaceSwitch 只依赖下面同一组稳定引用
  }, [addRecentWorkspace, setWorkspace]);
  const applyWorkspaceSwitch = async (path: string, addToRecent: boolean, silent: boolean, seq: number) => {
    /* 快切不闪 overlay: IPC 通常 <100ms, 立刻铺蒙层反而"闪一下".
     * 仅当超过 180ms 仍未完成才显示"正在切换", 慢盘/大项目才需要反馈. */
    let overlayShown = false;
    let overlayTimer: ReturnType<typeof setTimeout> | null = null;
    if (!silent) {
      const targetName = path.split(/[/\\]/).pop() || path;
      overlayTimer = setTimeout(() => {
        overlayShown = true;
        setSwitching(targetName);
      }, 180);
    }
    try {
      const result = await window.neox.setWorkspace(path);
      if (seq !== wsSwitchSeqRef.current) return null;
      setWorkspace(result);
      if (addToRecent) addRecentWorkspace(result);
      return result;
    } finally {
      if (overlayTimer) clearTimeout(overlayTimer);
      if (overlayShown) {
        requestAnimationFrame(() => setSwitching(null));
      } else {
        setSwitching(null);
      }
    }
  };

  useEffect(() => {
    const api = window.neox as unknown as {
      onWorkspaceChanged?: (h: (ws: { path?: string }) => void) => (() => void) | undefined;
    };
    if (typeof api?.onWorkspaceChanged !== 'function') return;
    const unsub = api.onWorkspaceChanged((ws) => {
      if (!ws?.path) return;
      if (ws.path === workspaceRef.current?.path) return;
      /* UI 正在切: 这条是排队里某一次的回声, 落界面由 openWorkspaceWithLoading 按点击顺序来 */
      if (wsSwitchInflightRef.current > 0) return;
      setWorkspace(ws as never);
    });
    return () => { try { unsub?.(); } catch { /* ignore */ } };
  }, [setWorkspace]);


  const [enteringMain, setEnteringMain] = useState(false);
  /* 过渡层淡出: workspace 在 enteringMain 期间就绪时, 把品牌过渡层再叠 300ms
   * 做 opacity 淡出, 让 shell 从它底下"显影"而不是硬切。 */
  const [enterFadeOut, setEnterFadeOut] = useState(false);
  const wasEnteringRef = useRef(false);
  useEffect(() => {
    if (!workspace) {
      wasEnteringRef.current = enteringMain;
      return;
    }
    if (wasEnteringRef.current) {
      wasEnteringRef.current = false;
      setEnterFadeOut(true);
      const t = window.setTimeout(() => setEnterFadeOut(false), 300);
      return () => window.clearTimeout(t);
    }
  }, [workspace, enteringMain]);
  /** 路径已不存在时: 清 lastWorkspace + 从 recent/持久化列表剔除, 防下次启动再炸. */
  const forgetMissingWorkspace = useCallback(async (path: string) => {
    try { await window.neox?.clearLastWorkspace?.(); } catch { /* ignore */ }
    try { await window.neox?.deleteWorkspace?.(path); } catch { /* ignore */ }
    setRecentWorkspaces((prev) => prev.filter((w) => w.path !== path));
  }, []);

  const tryOpenWorkspaceQuiet = useCallback(async (path: string, addToRecent: boolean): Promise<boolean> => {
    try {
      await openWorkspaceWithLoading(path, addToRecent, true);
      return true;
    } catch (err) {
      if (isMissingWorkspaceError(err)) {
        await forgetMissingWorkspace(path);
        return false;
      }
      throw err;
    }
  }, [forgetMissingWorkspace, openWorkspaceWithLoading]);

  const autoEnterMainWorkspace = useCallback(async (): Promise<boolean> => {
    setEnteringMain(true);
    try {
      const api = window.neox as unknown as {
        agentModeGetDefault?: () => Promise<{ defaultAgentMode?: string }>;
        agentModeEnsureHome?: (mode: string) => Promise<{ success?: boolean; path?: string }>;
        listWorkspaces?: () => Promise<Array<{ path?: string }>>;
      };
      let mode = (await api?.agentModeGetDefault?.())?.defaultAgentMode;
      if (mode !== 'assistant' && mode !== 'work' && mode !== 'code' && mode !== 'pilot') {
        mode = 'code';
      }

      /* Code: 优先恢复 recent 真实工程, 跳过已删目录, 再落模式 home 沙箱 */
      if (mode === 'code') {
        const fromState = recentWorkspaces.filter((w) => typeof w?.path === 'string' && w.path.length > 0);
        for (const ws of fromState) {
          if (await tryOpenWorkspaceQuiet(ws.path, true)) return true;
        }
        try {
          const list = await api.listWorkspaces?.();
          const candidates = (Array.isArray(list) ? list : []).filter((w) => typeof w?.path === 'string' && w.path.length > 0);
          for (const ws of candidates) {
            if (ws.path && await tryOpenWorkspaceQuiet(ws.path, true)) return true;
          }
        } catch { /* ignore */ }
      }

      let home = await api?.agentModeEnsureHome?.(mode);
      /* 旧 main 尚未支持 code ensure-home 时, 回退到 Life home, 避免卡在 Welcome */
      if ((!home?.success || !home.path) && mode === 'code') {
        home = await api?.agentModeEnsureHome?.('assistant');
      }
      if (!home?.success || !home.path) return false;
      /* addToRecent=false: 模式 home 是系统目录, 不进"最近项目"列表污染真实工程 */
      await openWorkspaceWithLoading(home.path, false, true);
      return true;
    } catch (e) {
      console.error('[AppShell] autoEnterMainWorkspace failed:', e);
      return false;
    } finally {
      setEnteringMain(false);
    }
  }, [openWorkspaceWithLoading, recentWorkspaces, tryOpenWorkspaceQuiet]);

  /** 可跳过 Welcome 时直进; 否则停在 Welcome。 */
  const enterAppIfAllowed = useCallback(async (force = false): Promise<boolean> => {
    if (!force) {
      const skip = await canSkipWelcome();
      if (!skip) return false;
    }
    return autoEnterMainWorkspace();
  }, [autoEnterMainWorkspace]);

  const focusExistingWorkspace = useCallback(async (path: string) => {
    try {
      return await window.neox.focusWorkspaceWindow?.(path) === true;
    } catch (error) {
      console.error('[AppShell] focusWorkspaceWindow failed:', error);
      return false;
    }
  }, []);

  /* 打开项目 — 永远在当前窗口 in-place 切换. 不再弹 IDEA "新窗口/此窗口" 对话框.
   * 多窗口下若该 workspace 已在另一个窗口打开,聚焦那个窗口而不是在这里重开. */
  const handleOpenProject = useCallback(async (path: string, opts?: { silent?: boolean }) => {
    /* 防御: '__time__*' 时间桶伪键混进来会被注册成工作区 (曾发生) — 一律拒绝 */
    if (path.startsWith('__time__')) return;
    if (await focusExistingWorkspace(path)) {
      return;
    }
    try {
      await openWorkspaceWithLoading(path, true, opts?.silent);
    } catch (err) {
      console.error('[AppShell] openWorkspaceWithLoading failed:', err);
      if (opts?.silent) return;
      if (isMissingWorkspaceError(err)) {
        await forgetMissingWorkspace(path);
        dispatchHint(
          language === 'zh'
            ? '该项目文件夹已不存在，已从列表移除'
            : 'That project folder no longer exists and was removed from recents',
          'warning',
        );
        return;
      }
      dispatchOpFailedFromError('打开项目', err);
    }
  }, [focusExistingWorkspace, forgetMissingWorkspace, language, openWorkspaceWithLoading]);

  /* IDE 资源管理器底部"最近工作区"点击切换入口 — 不能让 IdeFileSidebar 自己 IPC setWorkspace,
   * 那样只切 main 没刷 renderer state. 统一走 handleOpenProject 完整流程. */
  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<{ path?: string; silent?: boolean }>).detail;
      const path = detail?.path;
      if (typeof path === 'string' && path) {
        void handleOpenProject(path, { silent: detail?.silent === true }).then(() => {
          window.dispatchEvent(new CustomEvent('neox:scroll-to-workspace', { detail: { path } }));
        });
      }
    };
    window.addEventListener('neox:open-workspace', onOpen);
    return () => window.removeEventListener('neox:open-workspace', onOpen);
  }, [handleOpenProject]);

  /* VS Code / Cursor 插件发来的代码 / 打开项目 (neox://editor/*, 见 useEditorLinkReceiver) */
  useEditorLinkReceiver({
    workspacePath: workspace?.path,
    openProject: handleOpenProject,
    closeSettings: () => setShowSettings(false),
    zh: language === 'zh',
  });

  /* 在指定项目下新建会话 — 由 sidebar 每个 group 的 "+" 触发.
   *   · 同工作区: 派发自定义事件, NeoxShellHost 监听后调 createNewSession
   *   · 跨工作区: 写一个 localStorage flag 后正常切换工作区,
   *     新工作区下 NeoxShellHost 挂载时检查 flag 并自动创建 */
  const handleCreateSessionInWorkspace = useCallback(async (path: string) => {
    if (workspaceStateRef.current?.path === path) {
      window.dispatchEvent(new CustomEvent('neox:create-new-session'));
      return;
    }
    try { window.localStorage.setItem('neox-pending-new-session', '1'); } catch { /* ignore */ }
    await handleOpenProject(path);
  }, [handleOpenProject]);


  // HTML splash 在第一帧 React 实际渲染内容后才淡出，避免双重 splash
  useEffect(() => {
    if (showOnboarding === null) return;
    // 给一帧时间让 React 完成布局，然后淡出
    const t = requestAnimationFrame(() => dismissHtmlSplash());
    return () => cancelAnimationFrame(t);
  }, [showOnboarding]);

  const handleOnboardingComplete = useCallback(() => {
    setShowOnboarding(false);
    // 保存到后端
    if (window.neox?.setOnboardingCompleted) {
      window.neox.setOnboardingCompleted(true).catch((err: Error) => {
        console.error('[App] Failed to save onboarding completed:', err);
        // 标记没写进盘 → 下次启动会再弹欢迎页, 必须让用户知道
        dispatchOpFailedFromError('保存引导完成标记', err);
      });
    }
    /* 已登录 / 已配 BYOK → 跳过 Welcome 直进主界面; 否则落 Welcome 选 Login/BYOK */
    if (!workspaceStateRef.current) {
      void enterAppIfAllowed();
    }
  }, [enterAppIfAllowed]);

  const handleToggleTheme = useCallback(() => {
    toggleTheme();
  }, [toggleTheme]);

  const handleProvidersChanged = useCallback(() => {
    try {
      window.dispatchEvent(new CustomEvent('neox-providers-changed'));
    } catch { /* ignore */ }
  }, []);

  /* main 进程收到活跃 config.json 变更后, 统一桥接到 renderer 现有 window event 总线.
   * 这样 NeoxRuntimeBridge / SettingsPage / 其他订阅方都不用知道 Electron IPC 细节。 */
  useEffect(() => {
    const providersApi = window.neox as typeof window.neox & {
      onProvidersChanged?: (handler: () => void) => (() => void) | void;
    };
    const unsubscribe = providersApi.onProvidersChanged?.(() => {
      handleProvidersChanged();
    });
    return () => { try { unsubscribe?.(); } catch { /* ignore */ } };
  }, [handleProvidersChanged]);

  /* 任何深层组件触发 'neox-providers-changed' 都会让模型列表重新拉一次 — 例如 neoxCloudProviderSync
   *   在 membership 改了之后写完新 provider 后通知重新加载. */
  useEffect(() => {
    const onChanged = () => setProviderVersion(prev => prev + 1);
    window.addEventListener('neox-providers-changed', onChanged);
    return () => window.removeEventListener('neox-providers-changed', onChanged);
  }, []);

  /* 只跑一次 — openWorkspaceWithLoading / autoEnterMainWorkspace 会因 recentWorkspaces
   * 更新而换 identity, 若挂在 deps 上会反复恢复已删路径 → toast 叠罗汉. */
  const appInitOnceRef = useRef(false);
  const [bootWorkspaceSettled, setBootWorkspaceSettled] = useState(false);
  useEffect(() => {
    if (appInitOnceRef.current) return;
    appInitOnceRef.current = true;

    const initializeApp = async () => {
      // 检查 window.neox 是否可用
      if (!window.neox) {
        console.error('[App] window.neox is not available');
        dismissHtmlSplash();
        return;
      }

      try {
        const [info, lastState] = await Promise.all([
          window.neox.getAppInfo(),
          window.neox.getLastState(),
        ]);
        setAppInfo(info);

        const seen = new Set<string>();
        const recent = (lastState.workspaces || []).filter(ws => {
          if (!ws.path || seen.has(ws.path)) return false;
          /* '__time__*' 是 Life 侧栏时间桶伪键, 曾因点击链路 bug 被注册成工作区 —
           * 加载时过滤, 存量脏数据自然消失 (recents 只留 5 条会自行轮换出去). */
          if (ws.path.startsWith('__time__')) return false;
          seen.add(ws.path);
          return true;
        });
        const recentWithRoots = await Promise.all(
          recent.slice(0, 5).map(async (ws) => {
            let roots: string[] | undefined;
            try { roots = await window.neox.getWorkspaceRoots?.(ws.path); } catch { /* ignore */ }
            return {
              path: ws.path,
              name: ws.name,
              lastOpened: ws.lastOpened,
              status: 'idle' as const,
              roots: roots && roots.length > 1 ? roots : undefined,
            };
          })
        );
        setRecentWorkspaces(recentWithRoots);

        // "在新窗口打开项目" 的场景注入. 如果有, 用它覆盖 lastState.lastWorkspace,
        let targetWorkspace: string | null = null;
        try {
          const qs = new URLSearchParams(window.location.search);
          const fromQuery = qs.get('workspace');
          if (fromQuery && fromQuery.length > 0) {
            targetWorkspace = fromQuery;
          }
        } catch {
          /* ignore */
        }
        if (!targetWorkspace && lastState.lastWorkspace) {
          targetWorkspace = lastState.lastWorkspace;
        }

        setShowOnboarding(!lastState.onboardingCompleted);

        // 恢复 / 打开工作区 — 仅已登录或已配 BYOK 时跳过 Welcome。
        // 首帧只等本地 session 恢复 (纯 IPC); fetchMe 网络复验在后台跑,
        // 真过期会走既有 auth 登出广播把用户送回登录页 (同 session 中途过期)。
        try { await getEditionHook('bootstrapAuthLocal')(); } catch { /* init 失败仍按当前态判定 */ }
        const skipWelcome = await canSkipWelcome();

        if (targetWorkspace && skipWelcome) {
          try {
            await openWorkspaceWithLoading(targetWorkspace, false);
          } catch (error) {
            console.warn('[App] Failed to restore last workspace:', error);
            if (isMissingWorkspaceError(error)) {
              /* 专业路径: 路径已删 → 清持久化 + 剔 recent + 一条轻提示, 再落模式 home.
               * 绝不再 error toast 连发, 也不把用户卡在 Welcome. */
              await forgetMissingWorkspace(targetWorkspace);
              dispatchHint(
                language === 'zh'
                  ? '上次打开的项目已不存在，已从列表移除'
                  : 'Last project no longer exists and was removed from recents',
                'warning',
              );
            } else {
              dispatchOpFailedFromError('恢复上次打开的项目', error);
            }
            await autoEnterMainWorkspace();
          }
        } else if (lastState.onboardingCompleted && skipWelcome) {
          await autoEnterMainWorkspace();
        } else if (targetWorkspace && !skipWelcome) {
          /* 有陈旧 lastWorkspace 但已登出且无 BYOK → 清掉, 落 Welcome。
           * 这条是**窗口真的要离开工作区**, 所以显式 detach; 而 forgetMissingWorkspace
           * 那条只是忘掉一个不存在的路径, 绝不能顺手解绑当前窗口 (会把整个窗口废掉)。 */
          try { (window.neox as any)?.clearLastWorkspace?.({ detach: true }); } catch { /* ignore */ }
        }

        // 恢复主题（支持 auto/light/dark/midnight/high-contrast）
        const validThemes = ['auto', 'light', 'dark', 'midnight', 'high-contrast'] as const;
        const savedTheme = lastState.darkModePreference || lastState.theme;
        if (savedTheme) {
          const themeValue = validThemes.includes(savedTheme as typeof validThemes[number]) ? savedTheme as typeof validThemes[number] : 'auto';
          setThemePreference(themeValue);
        }

      } catch (error) {
        console.error('[App] Failed to initialize app:', error);
        // 出错时默认不显示引导
        setShowOnboarding(false);
      } finally {
        setBootWorkspaceSettled(true);
      }
    };

    void initializeApp();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- boot once; see appInitOnceRef
  }, []);

  /* Windows 标题栏控件 (min/max/close) 跟「当前可见表面」同色。
   * onboarding / welcome / login / 主壳 topbar 全覆盖 — 见 winTitleBarSync.ts。 */
  useEffect(() => {
    return installWinTitleBarSync();
    // 只装一次观察器; 表面切换由下面 effect + DOM MutationObserver 覆盖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 表面切换瞬间再补一枪（lazy 页面 mount 后 #root childList 也会触发，这里双保险） */
  useEffect(() => {
    syncWinTitleBar();
    const t = window.setTimeout(() => syncWinTitleBar(), 80);
    return () => clearTimeout(t);
  }, [theme, themePreference, showOnboarding, workspace, showSettings]);

  // 监听菜单打开项目
  useEffect(() => {
    if (!window.neox) {
      console.error('[App] window.neox is not available for menu actions');
      return;
    }

    const unsubscribe = window.neox.onMenuAction(async (action: MenuAction) => {
      if (action === 'menu:open-project') {
        try {
          const folderPath = await window.neox.openFolderDialog();
          if (folderPath) {
            await handleOpenProject(folderPath);
          }
        } catch (err) {
          dispatchOpFailedFromError('打开项目', err);
        }
      } else if (action === 'menu:go-home') {
        /* 工作台内 Home — 清会话封面, 不拆 workspace, 不进 Welcome 门禁 */
        setShowSettings(false);
        try { window.dispatchEvent(new CustomEvent('neox:go-home')); } catch { /* noop */ }
      } else if (action === 'menu:new-session') {
        window.dispatchEvent(new CustomEvent('neox:menu-new-session'));
      } else if (action === 'menu:search') {
        window.dispatchEvent(new CustomEvent('neox:menu-search'));
      } else if (action === 'menu:voice-mode') {
        window.dispatchEvent(new CustomEvent('neox:voice-mode-toggle'));
      } else if (action === 'menu:open-settings' || action === 'menu:open-account' || action === 'menu:open-about' || action === 'menu:open-settings-providers' || action === 'menu:open-settings-remote') {
        /* 应用菜单和 Windows 托盘共用设置导航; 账户/关于/常用设置用 tab 深链避免复制页面状态。 */
        const tab = action === 'menu:open-account' ? 'account'
          : action === 'menu:open-about' ? 'about'
          : action === 'menu:open-settings-providers' ? 'providers'
          : action === 'menu:open-settings-remote' ? 'remote'
          : undefined;
        if (tab) {
          try { localStorage.setItem('neox-settings-initial-tab', tab); } catch { /* ignore */ }
        }
        if (inMainShellRef.current) {
          try { window.dispatchEvent(new CustomEvent('neox:open-settings', { detail: tab ? { tab } : undefined })); } catch { /* ignore */ }
        } else setShowSettings(true);
      } else if (action === 'menu:close-tab') {
        /* ⌘W: IdeWelcomeTabHost / SurfacePanel 关当前 tab; 无 tab 时 no-op (不关窗口) */
        window.dispatchEvent(new CustomEvent('neox:menu-close-tab'));
      }
    });
    return () => unsubscribe();
  }, [handleOpenProject]);

  /**
   * 工作台内 Home — 清当前会话回到模式封面 / 空态。
   * 不 setWorkspace(null), 不进 Welcome 登录墙。
   * Welcome 只留给冷启动 (canSkipWelcome === false) 与 forceWelcome 调试。
   */
  const handleWorkbenchHome = useCallback(() => {
    setShowSettings(false);
    try { window.dispatchEvent(new CustomEvent('neox:go-home')); } catch { /* noop */ }
  }, []);

  const handleChangeWorkspace = async () => {
    try {
      const folderPath = await window.neox.openFolderDialog();
      if (folderPath) {
        await handleOpenProject(folderPath);
      }
    } catch (err) {
      dispatchOpFailedFromError('切换项目', err);
    }
  };

  /* "+ 文件夹" — 仅把文件夹注册到侧栏 recent 列表, 不切换 workspace, 不弹 IDEA "新窗口/此窗口"
   * 对话框. 切换由用户后续点击具体 group / session 时再触发. */
  const handleAddProjectFolder = useCallback(async () => {
    let folderPath: string | null = null;
    try {
      folderPath = await window.neox.openFolderDialog();
    } catch (err) {
      dispatchOpFailedFromError('添加文件夹', err);
      return;
    }
    if (!folderPath) return;
    if (workspace?.path === folderPath) return; /* 已是当前项目 */
    const name = folderPath.split(/[\\/]/).filter(Boolean).pop() || folderPath;
    addRecentWorkspace({
      path: folderPath,
      name,
      lastOpened: Date.now(),
      status: 'idle',
    });
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent('neox:scroll-to-workspace', { detail: { path: folderPath } }));
      });
    });
  }, [addRecentWorkspace, workspace]);

  const handleOpenSettings = () => {
    setShowSettings(true);
  };

  const handleCloseSettings = () => {
    setShowSettings(false);
    /* 广播"设置关了" —— 登录页去设置时把自己 display:none 了 (它是 z 99999 的满屏层,
     * 不让路的话设置浮层在它下面), 靠这条事件回来。没有监听方时这一句是空转。 */
    try { window.dispatchEvent(new CustomEvent('neox:settings-closed')); }
    catch { /* ignore */ }
  };

  useEffect(() => {
    const onOpen = (e: Event) => {
      if (!inMainShellRef.current) setShowSettings(true);
      const tab = (e as CustomEvent<{ tab?: string }> | undefined)?.detail?.tab;
      if (!tab) return;
      /* 转成正名再派一次, 让 SettingsPage 自己的监听切 tab (它对已 mount 的实例也生效)。
       * 不会成环: 冒号那条链路没有任何人再派回连字符。 */
      try { window.dispatchEvent(new CustomEvent('neox:open-settings', { detail: { tab } })); }
      catch { /* ignore */ }
    };
    window.addEventListener('neox-open-settings', onOpen);
    return () => window.removeEventListener('neox-open-settings', onOpen);
  }, []);

  useEffect(() => {
    const onOpen = () => { if (!inMainShellRef.current) setShowSettings(true); };
    window.addEventListener('neox:open-settings', onOpen);
    return () => window.removeEventListener('neox:open-settings', onOpen);
  }, []);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const mode = (e as CustomEvent<{ mode?: 'choose' | 'byok' }> | undefined)?.detail?.mode;
      setShowSettings(false);
      setModelConnect(mode === 'byok' ? 'byok' : 'choose');
    };
    window.addEventListener('neox:open-model-connect', onOpen);
    return () => window.removeEventListener('neox:open-model-connect', onOpen);
  }, []);

  const modelConnectOverlay = modelConnect && (
    <div className="model-connect-overlay">
      <Suspense fallback={null}>
        <OnboardingPage
          connectOnly={modelConnect}
          onComplete={() => {
            setModelConnect(null);
            handleProvidersChanged();
            if (!workspaceRef.current) void autoEnterMainWorkspace();
          }}
          onCancel={() => setModelConnect(null)}
        />
      </Suspense>
    </div>
  );

  /* Home 事件只关设置浮层; 清会话由 NeoxShellHost 监听 neox:go-home 处理。
   * 禁止在此 setWorkspace(null) — 那会把已配置用户甩进 Welcome 登录墙. */
  useEffect(() => {
    const onGoHome = () => setShowSettings(false);
    window.addEventListener('neox:go-home', onGoHome);
    return () => window.removeEventListener('neox:go-home', onGoHome);
  }, []);

  const welcomeEscapeAttemptedRef = useRef(false);
  useEffect(() => {
    if (workspace) {
      welcomeEscapeAttemptedRef.current = false;
      return;
    }
    if (!bootWorkspaceSettled) return;
    if (enteringMain || showOnboarding !== false) return;
    if (isForceWelcome()) return;
    if (welcomeEscapeAttemptedRef.current) return;
    welcomeEscapeAttemptedRef.current = true;
    let cancelled = false;
    void (async () => {
      const skip = await canSkipWelcome();
      if (cancelled) return;
      if (!skip) {
        welcomeEscapeAttemptedRef.current = false;
        return;
      }
      const ok = await autoEnterMainWorkspace();
      if (!ok && !cancelled) welcomeEscapeAttemptedRef.current = false;
    })();
    return () => { cancelled = true; };
  }, [workspace, bootWorkspaceSettled, enteringMain, showOnboarding, autoEnterMainWorkspace, providerVersion]);


  // 加载中状态 —— HTML splash 仍在 DOM 里显示，React 不渲染任何内容
  if (showOnboarding === null) {
    return null;
  }

  // 首次启动显示引导页 (fallback 用品牌过渡层, 与 HTML splash 无缝衔接不闪空白)
  if (showOnboarding) {
    return (
      <>
        <Suspense fallback={<EnterTransitionScreen />}>
          <OnboardingV3 onComplete={handleOnboardingComplete} onOpenSettings={handleOpenSettings} />
        </Suspense>
        {/* 引导页这一分支原来**只**渲染 OnboardingPage —— 设置浮层根本没被挂进来,
          * 所以冷启动(未登录)时无论从哪儿派事件都开不出设置。跟欢迎页那一分支对齐。 */}
        {showSettings && (
          <ErrorBoundary>
            <Suspense fallback={<OverlaySuspenseVeil />}>
              <SettingsPage onClose={handleCloseSettings} onProvidersUpdated={handleProvidersChanged} />
            </Suspense>
          </ErrorBoundary>
        )}
        {/* 设置里的"重置/删除"会调 confirmAsync/dispatchHint —— 这几个 host 不挂,
          * 点下去就是 Promise 永不 resolve (欢迎页那一分支为此栽过一次)。 */}
        <NotifyToastHost />
        <ReminderAlertHost isZh={language === 'zh'} />
        <ConfirmDialogHost />
        <PromptDialogHost />
      </>
    );
  }

  // 还进不了主界面 (没登录也没配 BYOK) —— 跟首次引导同一套整窗三步 (auto-enter 进行中不闪)。
  // 风格跟 4.0 两样; 登录 / 选用途 / 订阅或自带 Key 都在引导里。
  if (!workspace) {
    if (enteringMain) {
      // 曾经 return null → 空画布黑帧; 现在渲染品牌过渡层 (见 EnterTransitionScreen 注释)
      return <EnterTransitionScreen />;
    }
    return (
      <>
        <Suspense fallback={<EnterTransitionScreen />}>
          <OnboardingV3 onComplete={handleOnboardingComplete} onOpenSettings={handleOpenSettings} />
        </Suspense>
        {/* 设置页面作为覆盖层，不卸载引导页 */}
        {showSettings && (
          <ErrorBoundary>
            <Suspense fallback={<OverlaySuspenseVeil />}>
              <SettingsPage onClose={handleCloseSettings} onProvidersUpdated={handleProvidersChanged} />
            </Suspense>
          </ErrorBoundary>
        )}
        <NotifyToastHost />
        <ReminderAlertHost isZh={language === 'zh'} />
        <ConfirmDialogHost />
        <PromptDialogHost />
        <UpdateReadyHost />
        <DailyLoginsAskHost />
        {modelConnectOverlay}
      </>
    );
  }

  // 已选择项目时显示工作区
  // 使用覆盖层方式显示设置页面，保持Workspace组件不被卸载
  //
  // 导致切 workspace 时整树重建几百 ms 空白, **包括跟 workspace 无关的 sidebar (它显
  //
  // 现在不 remount, 走纯软切换 —
  //   · NeoxRuntimeBridge 内 effects 自带 workspace.path 依赖会自动重跑
  //   · last-session lookup 拆出来成单独 effect 依赖 workspace.path, sessions/models
  //     的 bootstrap 锁继续生效, 只在首次 mount 拉一次
  return (
    <>
      <NeoxShellHost
        workspace={workspace}
        recentWorkspaces={recentWorkspaces}
        onSelectWorkspace={handleOpenProject}
        onChangeWorkspace={handleAddProjectFolder}
        onRemoveWorkspace={handleRemoveWorkspace}
        onCreateSessionInWorkspace={handleCreateSessionInWorkspace}
        onGoHome={handleWorkbenchHome}
        onOpenSettings={handleOpenSettings}
        onToggleTheme={handleToggleTheme}
      />
      {/* enteringMain → workspace 就绪的交接帧: 品牌过渡层叠在 shell 上淡出 (无黑帧) */}
      {enterFadeOut && <EnterTransitionScreen out />}
      {(showSettings || settingsPrewarm) && (
        <Suspense fallback={showSettings ? <OverlaySuspenseVeil /> : null}>
          {/* 预热态: 挂着但 display:none —— 打开时只切 class, 没有首帧渲染代价 */}
          <div className={showSettings ? 'settings-host' : 'settings-host settings-host--prewarm'} aria-hidden={!showSettings}>
            <Activity mode={showSettings ? 'visible' : 'hidden'}>
              <SettingsPage
                onClose={handleCloseSettings}
                onProvidersUpdated={handleProvidersChanged}
                prewarm={!showSettings}
              />
            </Activity>
          </div>
        </Suspense>
      )}
      <FeatureIntroHost />
      {pilotCall && (
        <Suspense fallback={null}>
          <VoiceMode
            key={pilotCall.id}
            call={pilotCall}
            onSubmit={(text) => {
              try { window.dispatchEvent(new CustomEvent('neox:composer-fill', { detail: { text, send: true } })); }
              catch { /* ignore */ }
            }}
            onClose={endPilotCall}
          />
        </Suspense>
      )}
      {voiceModeOpen && !pilotCall && (
        <Suspense fallback={null}>
          <VoiceMode
            onSubmit={(text) => {
              try { window.dispatchEvent(new CustomEvent('neox:composer-fill', { detail: { text, send: true } })); }
              catch { /* ignore */ }
            }}
            onClose={() => setVoiceModeOpen(false)}
          />
        </Suspense>
      )}
      {/* 后台 bash 任务 / context 预算 / wakeup 倒计时 三个浮动 dock 已收归 ServicesSurfaceViewer
       * (Composer 顶部 BackgroundTasksBar 提供概览, 右栏 Services 展开详情), 不再在屏角占位. */}
      {/* Wave (4.5): 切换工作区 overlay — IPC+子树挂载期间 ~300-500ms 用户感觉"点了没反应".
        * 极简浮 spinner, 撤的时机是 IPC 跑完后的一帧 (子树已开始挂载, 背景是新 workspace). */}
      {switching && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: 'fixed', inset: 0, zIndex: 8500,
            display: 'grid', placeItems: 'center',
            background: 'color-mix(in srgb, var(--neox-bg-canvas, #1f1f1f) 60%, transparent)',
            backdropFilter: 'blur(2px)',
            WebkitBackdropFilter: 'blur(2px)',
            pointerEvents: 'none',
            animation: 'neox-ws-switch-fade 120ms ease-out',
          }}
        >
          <div style={{
            padding: '10px 16px',
            background: 'var(--neox-bg-card, #2c2c2c)',
            border: '1px solid var(--neox-line, rgba(255,255,255,.08))',
            borderRadius: 8,
            fontSize: 12,
            color: 'var(--neox-fg-primary, #f5f5f5)',
            boxShadow: '0 4px 14px rgba(0,0,0,.25)',
          }}>
            正在切换到 <strong>{switching}</strong> …
          </div>
        </div>
      )}
      {/* 发行版全局浮层 — 带额度体系的发行版在这里挂额度用尽弹窗 + 阈值提示条; 公开构建为空 */}
      <UiSlot name="app.overlays" props={{}} />
      {/* 全局操作失败 toast — context-level 模块 (NeoxRuntimeBridge / AppShell 等) 调
        * dispatchOpFailed() 触发, 让用户立即看到操作失败原因, 不再仅 console.error 静默 */}
      <NotifyToastHost />
      {/* Life 定时提醒 fired 后持久告警 (不点掉不消失, 免 3s toast 太短用户切窗错过) */}
      <ReminderAlertHost isZh={language === 'zh'} />
      {/* 全局确认对话框 — confirmAsync({...}) Promise API, 替代原生 window.confirm */}
      <ConfirmDialogHost />
      <PromptDialogHost />
      <UpdateReadyHost />
      <DailyLoginsAskHost />
      <SpotlightHost ready={!modelConnect && !showSettings && !switching} />
      {modelConnectOverlay}
      {/* 订阅 / 试用临期前 7 天提示 — 临期才渲染, 平时静默 */}
      {/* 订阅提醒不再画整宽浮层 —— 降维成 DockRail 里的一颗药丸 (billing/useBillingPill),
          说明性的那几条本来就已经在通知中心里发了。 */}
    </>
  );
};

export default App;
