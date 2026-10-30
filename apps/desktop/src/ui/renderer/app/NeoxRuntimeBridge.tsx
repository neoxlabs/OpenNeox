import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/* 4 层真实 provider — 与旧 WorkspacePage 栈一致 */
import {
  SessionStoreProvider,
  useSessionActions,
  useSessionState,
} from '../../state/sessionStore';
import { RuntimeStoreProvider, useRuntimeActions } from '../../state/runtimeStore';
import { useStableCallback } from '../hooks/useStableCallback';
import { registerTimelineStreamingTestHooks } from '../modules/agent-timeline/devTimelineTestHooks';
import { WorkspacePlatformProvider } from '../platform/WorkspacePlatformProvider';
import { RunManagerProvider } from '../modules/run/core/RunManagerContext';
import { SessionSendGuard } from './sessionSendGuard';

/* Timeline store + stream handler (复用旧壳已验证的管线) */
import { flushPendingWrites, loadTimelineFromDB, useTimelineStore } from '../../state/timelineStore';
import { useBlankSessionRecycler } from './blankSessionSweep';
import { userMessageIndexFromEnd } from '../modules/agent-timeline/editResendAnchor';
import { publishTimelineFeed, setTimelineHydrating, getTimelineHydratingSessionId, getTimelineFeed, getTimelineFeedSessionId } from '../state/timelineFeedStore';
import { useStreamHandler } from '../pages/workspace/hooks/useStreamHandler';
import { getContextSnapshot, setActiveContextSession, setContextSnapshot } from '../state/contextSnapshot';
import { initServiceAutoShow } from '../state/serviceAutoShow';
import { wireWorkspaceFsEventLog, registerFsEventTestHook, clearFsEventLog } from '../state/workspaceFsEventLog';
import { clearWriteLedger } from '@neoxlabs/kernel/core/writeLedger.js';
import { clearTerminalKeepalivePool } from '../modules/agent-timeline/terminalKeepalivePool';
import { noteSessionRunState } from '../modules/agent-timeline/sessionRunWindows';
import { isAutoRoutedModelName } from '../modules/agent-timeline/ProviderBrandIcon';

/* 登录态 / 会员 / 订阅模型走发行版能力钩子 —— 公开构建里恒为未登录、无会员、无订阅模型 */
import { getEditionHook, useEditionAuth, useEditionMembership } from '../modules/shell/editionHooks';

import { getTtsPlayer } from '../utils/ttsPlayer';
import { revealInFileManagerLabel } from '../utils/fileManagerLabels';
import { isChatMode, pinChatMode } from './chatModeStore';

if (typeof window !== 'undefined') {
  try {
    (window as unknown as {
      neox?: { onUpdateError?: (cb: (data: { message?: string }) => void) => () => void };
    }).neox?.onUpdateError?.((data) => {
      const message = String(data?.message ?? '').trim();
      if (message) dispatchHint(message, 'warning');
    });
  } catch { /* preload 未暴露 onUpdateError (旧版) — 静默跳过 */ }
}

/* utils */
import { createId, sanitizeSessionData } from '../pages/workspace/utils';
import { createSessionsRefresher } from './sessionsRefresher';


import { normalizeTimeline } from '../utils/workspaceUtils';
import { requireStreamEventSession } from './streamEventSession';
import { useOptimisticInjectBubbles } from '../modules/agent-timeline/injectOptimisticBubble';
import {
  resolveEffectiveAgentMode,
  resolveNewSessionWorkspace,
  shouldKeepActiveSessionOnWorkspaceChange,
  shouldSkipLastSessionRestore, shouldKeepActiveSession,
  shouldApplyWorkspaceSideEffect,
  hasModeHome,
} from './modeWorkspaceBinding';
import { isDefaultSessionName } from '../hooks/useAgentModeVariant';
import type { TimelineEntry } from '../utils/workspaceUtils';
import { isAbsPath, resolveWorkspacePath, workspaceKey, sameWorkspace, splitPathAnchor, sessionCwd } from '../utils/pathUtils';

/* types */
import type {
  Session,
  ChatMessage,
  ModelInfo,
  WorkspaceState,
  Attachment,
  DoubaoThinkingMode,
} from '../../shared/ipc';

import { NeoxRuntimeContext, type NeoxRuntimeContextValue, type PendingApproval } from './NeoxRuntimeContext';
import { isNeoxCloudProviderId } from '../../shared/neoxCloud';
import { useRunningSubAgentIds, abortSubAgent } from '../state/subAgentsStore';

/** Context 占位 — 真实 timeline 走 timelineFeedStore, 此引用永不变以免抬整树 */
/* `as unknown as`: Object.freeze([]) 推成 readonly never[], 跟 TimelineEntry[] 无交集,
 * 单层 as 会被 TS2352 拦。运行时就是一个冻结的空数组, 引用恒定 (这正是它存在的理由)。 */
const EMPTY_TIMELINE_FOR_CONTEXT: import('../utils/workspaceUtils').TimelineEntry[] =
  Object.freeze([]) as unknown as import('../utils/workspaceUtils').TimelineEntry[];

/** 计算当前 neox-cloud namespace 下的合成 ModelInfo 列表.
 *
 *   仅登录态从 membershipStore (现拉缓存) 派生扁平订阅 model。
 *   未登录不再注入匿名 auto 模型; BYOK 模型由 regular provider 另行合并。 */
function computeNeoxCloudModels(): ModelInfo[] {
  if (!getEditionHook('isAuthenticated')()) return [];
  return getEditionHook('getSubscriptionModelsNow')();
}
import { dispatchHint, dispatchOpFailed, dispatchOpFailedFromError } from '../components/notifyEvents';
import { sanitizePrompt } from '../utils/piiFilter';
import {
  isPiiFilterOn, preloadLastModelId, writeLastModelId, readLastModelId,
  preloadEffortPrefs, readEffortPrefs, writeEffortPrefs, findModelInAvailableList, pickDefaultAfterDeadKey,
} from './runtimeBridgePrefs';
import { isSubscriptionModel, pickFallbackModel, pickReconsideredForMode, pickStartupModel, shouldReconsiderAutoPick } from './modelDefaultPick';
import { isChatModelInfo } from '../utils/modelKind';
import { assignTaskToProject, getWorkProjectFilter } from '../modules/shell/workProjects';
import { setStreamingTokensHud } from '../state/streamingHudStore';
import { applyApprovalModeDefaultToSession, preloadApprovalModeDefault } from '../modules/agent-timeline/approvalModeStore';
import {
  applyEffortPick, effectiveEffort, effectiveEffortMap, emptyEffortPrefs,
  parseEffortPrefs, sendableEffortFor, serializeEffortPrefs, withModeDefaultEffort, type EffortPrefs,
} from './effortPrefs';
import { useCloudPilotHistorySync } from './useCloudPilotHistorySync';
import { markUserStopped, clearUserStopMark, wasRecentlyStoppedByUser } from '../state/userStopMarks';
import { requestStreamFreeze } from '../state/streamActivity';
import { recoverLostTimeline } from './lostTimelineRecovery';
import { getAgentTurnEdits } from '../state/agentTurnEditsStore';

/* 时间线里 (工具参数 cwd / 路径 / 命令) 出现过的绝对目录, 新的在前, 最多 24 个 —— 给正文里的裸文件名找家 */
export function dirsSeenInTimeline(entries: readonly unknown[]): string[] {
  const text = JSON.stringify(entries.slice(-300));
  const seen = new Set<string>();
  for (const m of text.matchAll(/\/(?:Users|private|tmp|var|home|Volumes)\/[^\s"'`<>|*?,;，。）)]*/g)) {
    const p = m[0].replace(/[.:\\]+$/, '').replace(/\/+$/, '');
    const dir = /\.[A-Za-z0-9]{1,6}$/.test(p) ? p.replace(/\/[^/]*$/, '') : p;
    seen.delete(dir);
    seen.add(dir);
  }
  return [...seen].reverse().slice(0, 24);
}

/* ============================================================
 * NeoxRuntimeBridge
 *   [外层] 挂齐 4 层 provider
 *   [内层] BridgeInner 做真实数据管线:
 *     - 首屏拉 sessions / models
 *     - 切 activeSession → initializeSessionTimeline
 *     - useStreamHandler 监听全部后端流事件, 写入 timelineStore
 *     - sendPrompt / stopCurrent
 *     - 把核心字段通过 NeoxRuntimeContext 暴露给下层 UI
 * ============================================================ */

interface NeoxRuntimeBridgeProps {
  workspace: WorkspaceState;
  children: ReactNode;
}

function bi(zh: string, en: string): string {
  return (window as any).__NEOX_LANG !== 'en' ? zh : en;
}

const openExternalOrTell = async (target: string): Promise<void> => {
  const shown = target.length > 48 ? `…${target.slice(-45)}` : target;
  let opened = false;
  try {
    const neox = (window as any).neox;
    if (neox?.surfaceOpenExternal) {
      const r = await neox.surfaceOpenExternal(target);
      opened = r?.success === true;
    }
  } catch { opened = false; }
  if (opened) return;
  /* 一行写完是**故意**的: openPathNeverSilent 那条"英文半边不许残留中文"的闸
   * 靠正则一次匹配整个三元, 拆行它就抓不到, 于是漏译能悄悄溜过去。 */
  // eslint-disable-next-line max-len
  dispatchHint(bi(`打不开 ${shown} — 这个位置上没有这个文件, 或系统没有能打开它的程序`, `Can’t open ${shown} — no such file here, or no app can open it`), 'warning');
};

export const NeoxRuntimeBridge: React.FC<NeoxRuntimeBridgeProps> = ({ workspace, children }) => {
  return (
    <SessionStoreProvider>
      <RuntimeStoreProvider>
        <WorkspacePlatformProvider>
          <RunManagerProvider workspacePath={workspace.path}>
            <BridgeInner workspace={workspace}>{children}</BridgeInner>
          </RunManagerProvider>
        </WorkspacePlatformProvider>
      </RuntimeStoreProvider>
    </SessionStoreProvider>
  );
};

/* ------------------------------------------------------------
 * Bridge inner — 必须在 4 层 provider 之内调用各 store hook
 * ------------------------------------------------------------ */
const BridgeInner: React.FC<NeoxRuntimeBridgeProps> = ({ workspace, children }) => {
  /* ---------- Session store ---------- */
  const sessionState = useSessionState();
  const {
    setSessions,
    setActiveSession,
    patchActiveSession,
    setMessages,
    setStatus,
    setStreaming,
    setAvailableModels,
    setSelectedModel,
    setContextUsed,
    setTotalTokens,
    setAttachments,
    setMode,
    resetAll: resetSessionStore,
  } = useSessionActions();
  const setStreamingTokens = setStreamingTokensHud;

  const { setRuntimeLogs } = useRuntimeActions();

  const {
    sessions,
    activeSession,
    streaming,
    status,
    selectedModel,
    availableModels,
    attachments,
    mode,
    contextUsed,
    totalTokens,
  } = sessionState;
  /* dev-only 抖动 harness 注入口 (scripts/timeline-jitter, npm run jitter)。
   * 生产构建里整体被 vite 死代码消除。 */
  registerTimelineStreamingTestHooks({
    setStreaming: (v) => setStreaming(v),
    pickModel: (needle) => {
      const hit = (availableModels || []).find((m: any) =>
        String(m.id).toLowerCase().includes(needle.toLowerCase()));
      if (!hit) return { error: 'not found' };
      setSelectedModelPersisted(hit);
      return { id: hit.id };
    },
    getSelectedModelId: () => selectedModel?.id ?? null,
  });

  const contextUsedRef = useRef(0);
  useEffect(() => {
    contextUsedRef.current = contextUsed;
  }, [contextUsed]);

  /* 【2026-07 WriteLedger】FS log 仅服务 viewer 热重载, 不再决定「本轮改动」membership.
   * 挂 workspace fs 事件 log — 一次性, 幂等. */
  useEffect(() => {
    wireWorkspaceFsEventLog();
    registerFsEventTestHook();
  }, []);

  /* Session 切换: 清 FS ring + WriteLedger, 防止跨会话串台 */
  const prevSessionForLedgerRef = useRef<string | null>(null);
  useEffect(() => {
    const sid = activeSession?.id ?? null;
    const prev = prevSessionForLedgerRef.current;
    if (prev && prev !== sid) {
      clearFsEventLog();
      clearWriteLedger(prev);
      clearTerminalKeepalivePool();
    }
    prevSessionForLedgerRef.current = sid;
  }, [activeSession?.id]);

  /* thinking 模式 (豆包等 supportsThinking 模型可切) */
  const [thinkingMode, setThinkingMode] = useState<DoubaoThinkingMode>('auto');
  const [effortPrefs, setEffortPrefs] = useState<EffortPrefs>(() => readEffortPrefs());
  const setEffortForModel = useCallback((modelId: string, level: string) => {
    setEffortPrefs((prev) => {
      const next = applyEffortPick(prev, modelId, level);
      writeEffortPrefs(next);
      return next;
    });
  }, []);
  /* 摊平给 UI 读的 Map —— 关思考的模型呈现为 'off' */
  const effortByModel = useMemo(() => effectiveEffortMap(effortPrefs), [effortPrefs]);
  /* 该模型 schema 里真实存在的档位 —— 用来保证"界面显示什么就发什么"。
   * 拿不到 (IPC 未绑定 / 非 schema 模型) 就是 undefined, 此时不做过滤。 */
  const [effortLevelsByModel, setEffortLevelsByModel] = useState<Map<string, readonly string[]>>(() => new Map());
  useEffect(() => {
    const id = selectedModel?.id;
    if (!id || effortLevelsByModel.has(id)) return;
    const fn = (window as any).neox?.getSchemaModelInfo;
    if (typeof fn !== 'function') return;
    let cancelled = false;
    void Promise.resolve(fn(id)).then((info: any) => {
      const levels = info?.effectiveLevels;
      if (cancelled || !Array.isArray(levels)) return;
      setEffortLevelsByModel((prev) => (prev.has(id) ? prev : new Map(prev).set(id, levels)));
    }).catch(() => { /* schema 拿不到就不过滤, 保持原值 */ });
    return () => { cancelled = true; };
  }, [selectedModel?.id, effortLevelsByModel]);
  /* selectedModel 可能 null (启动早期); 没选 model 时 effortLevel='standard' (无意义但不崩) */
  const sessionMode = (activeSession as { agentMode?: string | null } | null)?.agentMode;
  const modelLevels = selectedModel?.id ? effortLevelsByModel.get(selectedModel.id) : undefined;
  const effortLevel: string = sessionMode === 'pilot' && modelLevels?.includes('off')
    ? 'off'
    : withModeDefaultEffort(sendableEffortFor(effortPrefs, selectedModel?.id, effortLevelsByModel), sessionMode, modelLevels);

  /* sessions 首次加载是否完成. 初值 true (bootstrap 刚开始就 inflight), 第一次 setSessions
   * 落地后置 false. Sidebar 用它决定显示骨架行 vs 真实"无会话"空状态.
   * 不持续标记后续 getSessions: 那些 refresh 是用户感知不强的后台刷新, 骨架反而是干扰. */
  const [sessionsLoading, setSessionsLoading] = useState(true);

  /* 合并+节流的 sessions 刷新 —— 见文件上方 createSessionsRefresher 的说明。
   * 高频路径 (发完消息 / 子 Agent done / 新建子 session) 一律走它, 不再各自全量拉。 */
  /* sessions 的最新快照 —— 给 refresher 的字段合并用 (它只创建一次, 不能靠闭包捕获) */
  const latestSessionsRef = useRef<any[]>([]);
  latestSessionsRef.current = sessions ?? [];
  const refreshSessionsRef = useRef<(() => void) | null>(null);
  if (!refreshSessionsRef.current) {
    refreshSessionsRef.current = createSessionsRefresher(
      (rows) => setSessions(rows),
      sanitizeSessionData,
      /* lite 列表不带 usage 三件套 —— 把上一份里的补回去, 否则切会话时上下文表盘会闪空 (#109)。
       * 读 ref 而不是闭包里的 sessions: 这个 refresher 只创建一次, 闭包会永远停在首帧的空数组。 */
      () => latestSessionsRef.current,
    );
  }
  const scheduleSessionsRefresh = refreshSessionsRef.current;

  /* 运行子态 */
  const [paused, setPaused] = useState(false);
  const [canRetry, setCanRetry] = useState(false);
  const [lastError, setLastError] = useState<{ code?: string; message: string; suggestion?: string; raw?: string } | null>(null);
  const lastPromptBySessionRef = useRef<Map<string, string>>(new Map());
  const lastUserMsgIdBySessionRef = useRef<Map<string, string>>(new Map());
  /* 手动重试计数, 上限 5. 到顶就停掉重试按钮, 引导切 provider (跟 cloud auto-recover 计数分开)。 */
  const manualRetryCountBySessionRef = useRef<Map<string, number>>(new Map());
  const MAX_MANUAL_RETRY = 5;
  /* ref-level 同步守卫: state 的 streaming 是异步更新, 快速连按 Enter
   * 会穿透 Composer 的 canSend 检查. 这里把同步标记卡住防并发 sendPrompt. */
  const sendGuardsRef = useRef(new SessionSendGuard());
  const pendingStopsRef = useRef(new Map<string, Promise<void>>());
  const stopRuntimeSession = useCallback((sid: string, isChild = false) => {
    const pending = pendingStopsRef.current.get(sid);
    if (pending) return pending;
    sendGuardsRef.current.cancel(sid);
    const operation = Promise.resolve().then(async () => {
      if (isChild) await abortSubAgent(sid);
      else await window.neox.interruptSession(sid);
    });
    pendingStopsRef.current.set(sid, operation);
    void operation.finally(() => {
      if (pendingStopsRef.current.get(sid) === operation) pendingStopsRef.current.delete(sid);
    }).catch(() => undefined);
    return operation;
  }, []);
  /* 云端 session TERMINATED/NOT_FOUND auto-recover 上限计数器.
   *  pod 反复回收会触发 recover → resend → 再 TERMINATED 死循环,
   *  >= MAX_AUTO_RECOVER 后转为手动重试 (展示错误条 + 重试按钮). */
  const cloudAutoRecoverCountRef = useRef<number>(0);
  /* in-flight auto-recover setTimeout 的 timerId — stop 时 clearTimeout 硬中断, 不再
   * 仅靠 cloudRecoverAbortedRef 软标记 (旧逻辑标记后 in-flight setTimeout 仍占内存等触发). */
  const cloudRecoverTimerRef = useRef<number | null>(null);
  /* 发送守卫的取放轨迹, 只留最近 60 条;
   * 出问题时 window.__neoxSendGuardTrace() 直接看谁在什么时候把锁拿走 / 放掉. */
  const sendGuardTraceRef = useRef<Array<{ t: number; op: 'acquire' | 'release'; by: string; heldMs?: number }>>([]);
  const sendGuardSinceRef = useRef<number>(0);
  const markSendGuard = useCallback((op: 'acquire' | 'release', by: string) => {
    const now = Date.now();
    const entry: { t: number; op: 'acquire' | 'release'; by: string; heldMs?: number } = { t: now, op, by };
    if (op === 'acquire') sendGuardSinceRef.current = now;
    else if (sendGuardSinceRef.current) entry.heldMs = now - sendGuardSinceRef.current;
    const buf = sendGuardTraceRef.current;
    buf.push(entry);
    if (buf.length > 60) buf.splice(0, buf.length - 60);
  }, []);
  useEffect(() => {
    (window as any).__neoxSendGuardTrace = () => sendGuardTraceRef.current.map((e) => ({
      ...e, iso: new Date(e.t).toISOString().slice(11, 23),
    }));
    return () => { delete (window as any).__neoxSendGuardTrace; };
  }, []);
  const silentTurnAuditTimersRef = useRef<number[]>([]);
  const pendingTurnAuditsRef = useRef<Map<string, {
    sessionId: string;
    userEntryId: string;
    userMsgId: string;
    assistantMsgId: string;
    userSequence: number | null;
    userTs: number;
    promptPreview: string;
    transport: 'cloud' | 'local';
    modelId?: string;
    reason: string;
    responseSummary?: Record<string, unknown>;
    createdAt: number;
  }>>(new Map());
  /* 用户主动 interrupt 时置 true, 让 in-flight 的 auto-recover setTimeout 派的 retry 事件
   *  不再触发 — 防止用户已经点停止 / 切走会话, 后台还把 retry 派过去. */
  const cloudRecoverAbortedRef = useRef<boolean>(false);
  const clearLastError = useCallback(() => setLastError(null), []);

  const streamingBySessionRef = useRef<Map<string, boolean>>(new Map());
  const [runningSessionIds, setRunningSessionIds] = useState<ReadonlySet<string>>(() => new Set());
  const runningSubAgentIds = useRunningSubAgentIds();
  /* ref 镜像 — 会话切换 effect 里读"子会话是否在跑"用, 不能把集合本身挂进 effect deps
   * (子 agent 启停会误触发整个切换镜像)。 */
  const runningSubAgentIdsRef = useRef(runningSubAgentIds);
  runningSubAgentIdsRef.current = runningSubAgentIds;
  const mergedRunningSessionIds = useMemo<ReadonlySet<string>>(() => {
    if (runningSubAgentIds.size === 0) return runningSessionIds;
    const merged = new Set(runningSessionIds);
    for (const id of runningSubAgentIds) merged.add(id);
    return merged;
  }, [runningSessionIds, runningSubAgentIds]);
  const syncRunningSessionIds = useCallback((sid: string, running: boolean) => {
    /* 运行区间记一笔 —— shell_proc 回收据此判断同文件夹里有没有别的会话在写 */
    noteSessionRunState(
      sid,
      running,
      latestSessionsRef.current.find((s) => s?.id === sid)?.workspacePath,
    );
    setRunningSessionIds((prev) => {
      const has = prev.has(sid);
      if (has === running) return prev;
      const next = new Set(prev);
      if (running) next.add(sid); else next.delete(sid);
      return next;
    });
  }, []);
  const stoppedSessionsRef = useRef<Set<string>>(new Set());
  const pausedBySessionRef = useRef<Map<string, boolean>>(new Map());
  const lastErrorBySessionRef = useRef<Map<string, { code?: string; message: string; suggestion?: string; raw?: string } | null>>(new Map());
  const turnStartedAtBySessionRef = useRef<Map<string, number | null>>(new Map());
  const canRetryBySessionRef = useRef<Map<string, boolean>>(new Map());
  const statusBySessionRef = useRef<Map<string, string>>(new Map());
  const modelBySessionRef = useRef<Map<string, string>>(new Map());
  /* selectedModel 是兜底挑的(true) 还是用户点的 / 会话还原的(false) —— 订阅段迟到时
   * 只有前者能回头改 (规则见 modelDefaultPick)。 */
  const autoPickedModelRef = useRef(false);

  /* dispatchStreaming wrapper — 写 map[sid] (sid 默认 active), 只有 sid === active 才动 global.
   *  useStreamHandler 现有调用大多没传 sid (会默认到 active), 改造完后能传 event.sessionId 区分
   *  后台 session 的事件不污染前台 UI. */
  const dispatchStreamingPerSession = useCallback((value: boolean, sessionId?: string) => {
    const sid = sessionId ?? activeSessionIdRef.current;
    if (value && sid && stoppedSessionsRef.current.has(sid)) return;
    if (sid) {
      streamingBySessionRef.current.set(sid, value);
      syncRunningSessionIds(sid, value);
      if (!value) sendGuardsRef.current.settle(sid);
    }
    if (!sid || sid === activeSessionIdRef.current) setStreaming(value);
  }, [setStreaming, syncRunningSessionIds]);

  const applyAuthoritativeExecutionState = useCallback((sessionId: string, state: 'idle' | 'running' | 'recovering') => {
    if (!sessionId) return;
    /* 子 agent 不在 L0 sessionRunStates。权威说 idle 不能盖掉"子线程还在跑"。 */
    if (state === 'idle' && runningSubAgentIdsRef.current.has(sessionId)) return;
    const running = state === 'running' || state === 'recovering';
    if (!running) {
      stoppedSessionsRef.current.delete(sessionId);
      sendGuardsRef.current.settle(sessionId);
    }
    streamingBySessionRef.current.set(sessionId, running);
    syncRunningSessionIds(sessionId, running);
    if (sessionId === activeSessionIdRef.current) setStreaming(running);
  }, [setStreaming, syncRunningSessionIds]);

  const reconcileExecutionStateFromAuthority = useCallback(async (reason: string) => {
    const api: any = (window as any).neox;
    if (typeof api?.getExecutionStates !== 'function') return;
    let res: { ok?: boolean; states?: Array<{ sessionId: string; running: boolean }> } | null = null;
    const suspects = [...streamingBySessionRef.current.entries()]
      .filter(([, running]) => running === true)
      .map(([sessionId]) => sessionId);
    try {
      res = await api.getExecutionStates(suspects);
    } catch {
      return; // 查不到 → 保持现状
    }
    if (!res?.ok || !Array.isArray(res.states)) return;

    const authoritative = new Map<string, boolean>();
    for (const s of res.states) {
      if (s?.sessionId) authoritative.set(s.sessionId, s.running === true);
    }
    /* 权威列表是"main 侧已知的全部会话", 没被列进来的会话这里不动 —— 例如 cloud
     * transport 会话根本不走 agentBridge 状态机, 不能被这轮对账误收敛掉。 */
    for (const [sessionId, running] of authoritative) {
      const mirrored = streamingBySessionRef.current.get(sessionId) === true;
      if (mirrored === running) continue;
      console.warn(`[RuntimeBridge] 运行态对账(${reason}): ${sessionId.slice(0, 8)} ${mirrored} → ${running}`);
      applyAuthoritativeExecutionState(sessionId, running ? 'running' : 'idle');
    }
  }, [applyAuthoritativeExecutionState]);

  const dispatchStatusPerSession = useCallback((status: string, sessionId?: string) => {
    const sid = sessionId ?? activeSessionIdRef.current;
    if (sid) statusBySessionRef.current.set(sid, status);
    if (!sid || sid === activeSessionIdRef.current) setStatus(status);
  }, [setStatus]);

  const modelSwitchToastRef = useRef<{ origin: string; timer: ReturnType<typeof setTimeout> | null } | null>(null);
  const setSelectedModelPersisted = useCallback(
    (m: ModelInfo) => {
      const prev = selectedModel;
      setSelectedModel(m);
      if (isChatModelInfo(m)) writeLastModelId(m.id);
      autoPickedModelRef.current = false;   /* 用户点的 —— 订阅段再迟到也不许替他改 */
      const sid = activeSessionIdRef.current;
      const bindable = isChatModelInfo(m) || (activeSessionRef.current as { kind?: string } | null)?.kind === 'image';
      if (sid && bindable && !m.id.startsWith('default:')) {
        modelBySessionRef.current.set(sid, m.id);
        setSessions((list) => list.map((s) => (s.id === sid ? { ...s, modelId: m.id } : s)));
        patchActiveSession(sid, { modelId: m.id } as Partial<NonNullable<typeof activeSession>>);
        const api = (window as any).neox;
        if (typeof api?.setSessionModel === 'function') {
          void api.setSessionModel(sid, m.id).catch((err: unknown) => {
            console.warn('[NeoxRuntimeBridge] setSessionModel failed:', err);
          });
        }
      }
      if (prev && prev.id !== m.id) {
        const EFF: Record<string, [string, string]> = {
          off: ['关', 'off'], low: ['低', 'low'], medium: ['中', 'medium'], high: ['高', 'high'], max: ['最高', 'max'], xhigh: ['最高', 'max'],
        };
        const effLabel = (lv: string | undefined) => {
          const pair = lv ? EFF[lv] ?? [lv, lv] : ['默认', 'default'];
          return bi(pair[0], pair[1]);
        };
        const before = effectiveEffort(effortPrefs, prev.id);
        const after = effectiveEffort(effortPrefs, m.id);
        if (before !== after) {
          dispatchHint(bi(
            `思考档跟着换成「${effLabel(after)}」(这个模型上次用的档)`,
            `Thinking is now "${effLabel(after)}" (what you last used with this model)`,
          ), 'info');
        }
      }
      if (!bindable || !(prev && prev.id !== m.id && activeSession && (activeSession.messageCount ?? activeSession.messages.length) > 0)) return;
      const prevName = prev.name || prev.id;
      const nextName = m.name || m.id;
      /* 锁住 streak 起点: 第一次进入时记 origin, 后续切换沿用; streak 结束后 reset. */
      const cur = modelSwitchToastRef.current;
      const origin = cur?.origin ?? prevName;
      if (cur?.timer) clearTimeout(cur.timer);
      const timer = setTimeout(() => {
        modelSwitchToastRef.current = null;
        /* origin === nextName 表示用户绕一圈回到原模型, 不弹打扰. */
        if (origin === nextName) return;
        dispatchHint(
          bi(
            `已切换 ${origin} → ${nextName}, 继续当前对话; 模型切换会重建 prompt cache, 下一轮请求可能略慢`,
            `Switched ${origin} → ${nextName}; the conversation continues. Switching rebuilds the prompt cache, so the next request may be slightly slower.`,
          ),
          'warning',
        );
      }, 1200);
      modelSwitchToastRef.current = { origin, timer };
    },
    [selectedModel, activeSession, setSelectedModel, setSessions, patchActiveSession, effortPrefs],
  );

  const setModelForSession = useCallback(
    (sid: string, m: ModelInfo) => {
      if (!sid || m.id.startsWith('default:')) return;
      if (sid === activeSessionIdRef.current) { setSelectedModelPersisted(m); return; }
      modelBySessionRef.current.set(sid, m.id);
      setSessions((list) => list.map((s) => (s.id === sid ? { ...s, modelId: m.id } : s)));
      const api = (window as any).neox;
      if (typeof api?.setSessionModel === 'function') {
        void api.setSessionModel(sid, m.id).catch((err: unknown) => {
          console.warn('[NeoxRuntimeBridge] setSessionModel failed:', err);
        });
      }
    },
    [setSelectedModelPersisted, setSessions],
  );

  /* ---------- Timeline store ---------- */
  const activeSessionIdRef = useRef<string | null>(null);
  /* 子会话 timeline 重拉的并发闸: in-flight 时新通知只置 queued, 拉完补一次 */
  const subTimelinePullInFlightRef = useRef(false);
  const subTimelinePullQueuedRef = useRef(false);
  const activeSessionWorkspacePathRef = useRef<string | null>(null);
  useEffect(() => {
    activeSessionIdRef.current = activeSession?.id ?? null;
    activeSessionWorkspacePathRef.current = activeSession?.workspacePath ?? null;
    /* 设置页「上下文管理」不带 sessionId 读快照 —— 告诉快照仓库当前是哪个会话, 别拿最后写入的 (可能是子 agent 的) */
    setActiveContextSession(activeSession?.id ?? null);
    /* Phase A · Target 状态单源化 — 切 session 时主动 IPC 拉一次 target snapshot,
     *   立刻更新 banner (不然要等后端 push, 空档期 UI 显示上一个 session 的状态).
     *   动态 import 避免顶层循环依赖. */
    void (async () => {
      try {
        const mod = await import('../modules/agent-timeline/targetIndicatorStore');
        await mod.syncTargetFromSession(activeSession?.id ?? null);
      } catch { /* 无 target 模块 / IPC 不可用无害 */ }
    })();
  }, [activeSession?.id, activeSession?.workspacePath]);

  useEffect(() => {
    void reconcileExecutionStateFromAuthority('renderer-mount');
    const onFocus = () => { void reconcileExecutionStateFromAuthority('window-focus'); };
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void reconcileExecutionStateFromAuthority('visibility-change');
      }
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [reconcileExecutionStateFromAuthority]);


  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { path?: string } | undefined;
      /* 先摘掉行号锚点 (`foo.ts#L10` / `foo.ts:10`): 下面的 searchFiles / stat / 系统打开
       * 全是按真实路径找文件的, 带着锚点一律 ENOENT —— 那正是"带行号的引用点不开"的原因。
       * 锚点本身留着, 最后交给 openSurfaceFromPath 去跳行。 */
      const anchored = splitPathAnchor(detail?.path ?? '');
      const path = anchored.path.trim();
      const focusLine = anchored.line;
      /* handler 里唯一允许的"什么都不做就走人": 压根没给路径 —— 那不是用户点出来的 */
      if (!path) return;
      const sessionId = activeSessionIdRef.current;
      if (!sessionId) {
        void openExternalOrTell(path);
        return;
      }
      const workspacePath = activeSessionWorkspacePathRef.current ?? undefined;
      void (async () => {
      let resolved = path;
      /* 先看这个会话刚改过 / 新建的文件 (改动卡那份): Agent 常把文件写在别的目录 (用户让它在测试目录干活),
       * 正文里只提裸名 —— 只在项目根下搜就会拼出 `<项目>/wordfreq.py` 这种不存在的路径
       * (10-15 QA: 改动卡里点能开, 正文里点同一个名字报「打不开」) */
      if (!path.includes('/') && !path.includes('\\')) {
        const edited = getAgentTurnEdits(sessionId)?.files
          .map((f) => f.path)
          .filter((p) => p.split(/[/\\]/).pop() === path) ?? [];
        if (edited.length > 0) resolved = edited[0];
      }
      if (resolved === path && !path.includes('/') && !path.includes('\\') && getTimelineFeedSessionId() === sessionId) {
        const api = (window as any).neox;
        for (const dir of dirsSeenInTimeline(getTimelineFeed())) {
          const cand = `${dir}/${path}`;
          try {
            const r = await api?.surfaceReadFile?.(cand, workspacePath ? { workspacePath } : undefined);
            if (r && r.success !== false) { resolved = cand; break; }
          } catch { /* 下一个 */ }
        }
      }
      if (resolved === path && !path.includes('/') && !path.includes('\\') && workspacePath) {
        try {
          const api = (window as any).neox;
          const res = await api?.searchFiles?.(path, { maxResults: 50 });
          const files: string[] = Array.isArray(res?.files)
            ? res.files.map((f: any) => (typeof f === 'string' ? f : f?.file)).filter(Boolean)
            : [];
          const exact = files.filter((f) => String(f).split(/[/\\]/).pop() === path);
          if (exact.length >= 1) {
            /* 多个同名时取路径最短的 —— 通常就是最"正统"的那个 (bin 下的优于 node_modules 深处的);
               而且必须给一个结果, 不能像上一版那样直接放弃 (用户点了没反应比开错还难受)。 */
            resolved = exact.sort((a, b) => a.length - b.length)[0];
          }
        } catch { /* 搜不了就按原样试, 下面存在性检查兜底 */ }
      }
      const absResolved = resolved.startsWith('/') ? resolved
        : (workspacePath ? `${workspacePath.replace(/\/$/, '')}/${resolved}` : resolved);
      const okExists = await (async () => {
        try {
          const api = (window as any).neox;
          if (!api?.surfaceReadFile) return true;
          const r = await api.surfaceReadFile(absResolved, workspacePath ? { workspacePath } : undefined);
          return r?.success !== false;
        } catch { return false; }
      })();
      if (!okExists) {
        await openExternalOrTell(absResolved);
        return;
      }
      await import('../state/openSurfaceFromPath').then(async ({ openSurfaceFromPath }) => {
        const ok = openSurfaceFromPath({ sessionId, path: absResolved, workspacePath, line: focusLine });
        /* Surface 不支持这个扩展名 (或路径解析失败) → 交给系统默认程序 */
        if (!ok) await openExternalOrTell(absResolved);
      }).catch(async () => { /* dynamic import 失败, 直接 external */
        await openExternalOrTell(absResolved);
      });
      })();
    };
    window.addEventListener('neox:open-path', handler as EventListener);
    return () => window.removeEventListener('neox:open-path', handler as EventListener);
  }, []);

  /* 组件卸载时清掉所有 in-flight timer, 防"组件没了 timer 还在跑"的无谓 IPC + 误派事件.
   *   覆盖: model 切换 toast / cloud auto-recover / sending 守卫 */
  useEffect(() => () => {
    /* modelSwitchToast 的 setTimeout 也清 — 快速 unmount/remount 时之前的 timer 触发 dispatchHint
     * 会让用户看到已被切走的提示. */
    const ms = modelSwitchToastRef.current;
    if (ms?.timer) {
      clearTimeout(ms.timer);
      modelSwitchToastRef.current = null;
    }
    /* 云端 auto-recover + sendingRef stuck 兜底 timer 也清 — 批次4 已加 stopCurrent 路径
     * 但组件直接 unmount (e.g. workspace 切换 / app 关闭) 不走 stopCurrent. */
    if (cloudRecoverTimerRef.current != null) {
      clearTimeout(cloudRecoverTimerRef.current);
      cloudRecoverTimerRef.current = null;
    }
    sendGuardsRef.current.clear();
    for (const timer of silentTurnAuditTimersRef.current) {
      clearTimeout(timer);
    }
    silentTurnAuditTimersRef.current = [];
    pendingTurnAuditsRef.current.clear();
  }, []);

  const {
    timelineEvents,
    setTimelineEvents,
    timelineMapRef,
    appendTimelineEntry,
    updateTimelineEntry,
    updateTimelineEntryById,
    deleteTimelineEntry,
    truncateTimelineFrom,
    initializeSessionTimeline,
    prependOlderTimelineEntries,
    clearTimeline,
  } = useTimelineStore(activeSessionIdRef);
  /* 云端 Pilot: 本地缺的对话从云端账本补进来 */
  useCloudPilotHistorySync(activeSession?.id, sessionMode === 'pilot', !!activeSession && mergedRunningSessionIds.has(activeSession.id), initializeSessionTimeline);

  const lastPublishedSidRef = useRef<string | null>(null);
  useEffect(() => {
    const sid = activeSession?.id ?? null;
    const switched = lastPublishedSidRef.current !== sid;
    lastPublishedSidRef.current = sid;
    let immediate = !sid || timelineEvents.length === 0;
    if (!immediate && !switched) {
      for (let i = timelineEvents.length - 1; i >= 0; i--) {
        const e = timelineEvents[i] as { type?: string; askUserStatus?: string; interrupted?: boolean };
        if (e?.type === 'ask_user' && e.askUserStatus === 'waiting' && e.interrupted !== true) {
          immediate = true;
          break;
        }
        /* 只扫尾部一小段 — waiting ask 几乎总在最新 */
        if (timelineEvents.length - i > 24) break;
      }
    }
    publishTimelineFeed(sid, timelineEvents, { immediate });
    /* 数据真的到位了 —— 这才是"加载完成"的正确锚点, 比 promise resolve 晚, 也比它准。 */
    if (timelineEvents.length > 0 && getTimelineHydratingSessionId() === sid) {
      setTimelineHydrating(null);
    }
  }, [timelineEvents, activeSession?.id]);

  const hasTimelineEntryAfterUserMessage = useCallback((
    sessionId: string,
    userEntryId: string,
    userSequence: number | null,
    userTs: number,
    assistantMsgId?: string,
  ) => {
    const entries = timelineMapRef.current.get(sessionId) ?? [];
    return entries.some((entry) => {
      if (!entry || entry.id === userEntryId) return false;
      if (entry.type === 'user_message') return false;
      /* 审计自己 append 的诊断卡不算"收到了事件" — 否则重试后残留的旧卡会掩盖新一轮的缺失. */
      if (typeof entry.id === 'string' && entry.id.startsWith('timeline-turn-audit-')) return false;
      /* 最强证据: 本轮预分配的 assistantMsgId 已有对应条目 (stream 路径或兜底路径写的都算). */
      if (assistantMsgId && (entry.messageId === assistantMsgId || entry.id === `msg-${assistantMsgId}`)) {
        return true;
      }
      const entrySequence = typeof entry.sequence === 'number' ? entry.sequence : null;
      if (userSequence != null && entrySequence != null && entrySequence > userSequence) {
        return true;
      }
      const errorLastAt = (entry as { errorLastAt?: number }).errorLastAt;
      if (typeof errorLastAt === 'number' && errorLastAt >= userTs) return true;
      return (entry.timestamp || 0) >= userTs;
    });
  }, [timelineMapRef]);

  const appendMissingTurnDiagnostic = useCallback((audit: {
    sessionId: string;
    userEntryId: string;
    userMsgId: string;
    assistantMsgId: string;
    userSequence: number | null;
    userTs: number;
    promptPreview: string;
    transport: 'cloud' | 'local';
    modelId?: string;
    reason: string;
    responseSummary?: Record<string, unknown>;
  }) => {
    if (hasTimelineEntryAfterUserMessage(audit.sessionId, audit.userEntryId, audit.userSequence, audit.userTs, audit.assistantMsgId)) {
      return false;
    }
    if (wasRecentlyStoppedByUser(audit.sessionId)) {
      return false;
    }
    const running = streamingBySessionRef.current.get(audit.sessionId) === true;
    /* 技术细节只进 console (开发者从 DevTools 看, 也可执行 await window.__neoxTimelineSnapshot()
     * 对比内存和 IndexedDB); 用户可见的卡片文案在下面, 保持人话. */
    console.error('[TimelineTurnAudit] missing entries after user message', {
      sessionId: audit.sessionId,
      userEntryId: audit.userEntryId,
      assistantMsgId: audit.assistantMsgId,
      userSequence: audit.userSequence,
      userTs: audit.userTs,
      transport: audit.transport,
      modelId: audit.modelId,
      reason: audit.reason,
      running,
      responseSummary: audit.responseSummary,
      promptPreview: audit.promptPreview,
      tail: (timelineMapRef.current.get(audit.sessionId) ?? []).slice(-8).map((entry) => ({
        id: entry.id,
        type: entry.type,
        sequence: entry.sequence,
        timestamp: entry.timestamp,
        pending: entry.pending,
        title: entry.title,
      })),
    });
    const message = '消息已发出，但没有收到回复。';
    appendTimelineEntry(audit.sessionId, {
      id: `timeline-turn-audit-${audit.userMsgId}`,
      type: 'runner_error',
      title: bi('未收到回复', 'No reply received'),
      detail: '消息已发出，但助手没有返回任何内容。可能是网络波动或服务暂时异常。',
      timestamp: Date.now(),
      pending: false,
      level: 'error',
      errorCode: 'TIMELINE_TURN_WITHOUT_EVENTS',
      errorMessage: message,
      errorSuggestion: '点「重试」重新发送这条消息；如果多次出现，请检查网络后再试。',
      errorAction: { kind: 'retry', label: '重试' },
    } as TimelineEntry, true);
    void flushPendingWrites();
    return true;
  }, [appendTimelineEntry, hasTimelineEntryAfterUserMessage, timelineMapRef]);

  const processPendingTurnAudits = useCallback((sessionId?: string) => {
    for (const [key, audit] of Array.from(pendingTurnAuditsRef.current.entries())) {
      if (sessionId && audit.sessionId !== sessionId) continue;
      if (hasTimelineEntryAfterUserMessage(audit.sessionId, audit.userEntryId, audit.userSequence, audit.userTs, audit.assistantMsgId)) {
        pendingTurnAuditsRef.current.delete(key);
        continue;
      }
      if (streamingBySessionRef.current.get(audit.sessionId) === true) {
        continue;
      }
      appendMissingTurnDiagnostic(audit);
      pendingTurnAuditsRef.current.delete(key);
    }
  }, [appendMissingTurnDiagnostic, hasTimelineEntryAfterUserMessage]);

  const scheduleSilentTurnAudit = useCallback((audit: {
    sessionId: string;
    userEntryId: string;
    userMsgId: string;
    assistantMsgId: string;
    userSequence: number | null;
    userTs: number;
    promptPreview: string;
    transport: 'cloud' | 'local';
    modelId?: string;
    reason: string;
    responseSummary?: Record<string, unknown>;
  }) => {
    const key = `${audit.sessionId}:${audit.userMsgId}`;
    pendingTurnAuditsRef.current.set(key, { ...audit, createdAt: Date.now() });
    for (const delay of [1800, 8000, 20000]) {
      const timer = window.setTimeout(() => {
        silentTurnAuditTimersRef.current = silentTurnAuditTimersRef.current.filter((id) => id !== timer);
        processPendingTurnAudits(audit.sessionId);
      }, delay);
      silentTurnAuditTimersRef.current.push(timer);
    }
  }, [processPendingTurnAudits]);

  /* ---------- useStreamHandler 必需的 refs ----------
   *  messageMapRef = prealloc inbox: sendPrompt 在这写预分配的 assistant messageId,
   *  useStreamHandler 内 ActiveSlot reducer 拿它当首选 slot id (兼容 write-through 镜像).
   *  原 messageCompletedRef 已废除 — 该状态进了 useStreamHandler 内部 slotsRef 的 phase 字段. */
  const messageMapRef = useRef<Map<string, string>>(new Map());
  const reasoningStreamRef = useRef<Map<string, { entryId: string; content: string; startedAt?: number }>>(new Map());
  const fileStreamEntryMapRef = useRef<Map<string, string>>(new Map());
  const fileStreamLatestContentRef = useRef<Map<string, string>>(new Map());

  /* IDE 侧边视图相关 — agent 视图暂不联动编辑器, 给 noop ref */
  const openOrUpdateFileInEditorRef = useRef<
    (filePath: string, content: string, isComplete: boolean, options?: { updateOnly?: boolean }) => void
  >(() => {});

  /* ---------- stream handler 吃的 local state (暂不展示到 UI) ---------- */
  const [, setMemorySnapshot] = useState<any>(null);
  const [, setLatestRequestUsage] = useState<any>(null);
  const [, setRetryError] = useState<any>(null);
  /* setCanRetry 复用上面 paused/canRetry 块的 setter, 让 useStreamHandler 的
   * classified 错误事件也能触发 UI 上的 retry 按钮 */

  /* ---------- i18n stub — 只填 stream handler 必需字段 ---------- */
  const tRef = useRef({
    timeline: { reasoning: '思考' },
    plan: { title: bi('执行计划', 'Plan'), updated: bi('已更新', 'updated') },
    session: {} as Record<string, string>,
    errors: {
      loopDetected: '检测到循环调用',
      loopDetectedSuggestion: '请调整上下文或重新提问',
      placeholderDetected: '检测到参数占位符',
      placeholderDetectedSuggestion: '请完善工具参数后重试',
      runnerError: '这一轮没跑成',
      runnerErrorSuggestion: '请稍后重试',
    },
  });

  /* ---------- formatWorkspacePath & scrollToBottom ---------- */
  const formatWorkspacePath = useCallback(
    (absPath?: string) => {
      if (!absPath) return '';
      if (absPath.startsWith(workspace.path)) {
        const relative = absPath.slice(workspace.path.length).replace(/^[/\\]/, '');
        return relative || absPath;
      }
      return absPath;
    },
    [workspace.path],
  );
  const scrollToBottom = useCallback(() => {
    /* agent-timeline 视图自己在底部, 不需要 host 侧驱动滚动 */
  }, []);

  /* ---------- 所有真实流事件 → timelineStore ---------- */
  useStreamHandler({
    dispatchMessages: setMessages,
    dispatchStatus: dispatchStatusPerSession,
    dispatchStreaming: dispatchStreamingPerSession,
    applyAuthoritativeExecutionState,
    requestExecutionStateReconcile: (reason: string) => { void reconcileExecutionStateFromAuthority(reason); },
    dispatchTotalTokens: setTotalTokens,
    setStreamingTokens,
    dispatchContextUsed: setContextUsed,
    setMemorySnapshot,
    setLatestRequestUsage,
    setRuntimeLogs,
    setCanRetry,
    setRetryError,
    appendTimelineEntry,
    updateTimelineEntry,
    updateTimelineEntryById,
    deleteTimelineEntry,
    timelineMapRef,
    activeSessionIdRef,
    messageMapRef,
    reasoningStreamRef,
    fileStreamEntryMapRef,
    fileStreamLatestContentRef,
    scrollToBottom,
    formatWorkspacePath,
    openOrUpdateFileInEditorRef,
    tRef,
    workspacePath: workspace.path,
    isSessionStreaming: (sid: string | null) =>
      !!sid && streamingBySessionRef.current.get(sid) === true,
  });

  /* P3+: 每次 activeSession 变化, 写 SQLite app_state.lastSession. 切回这个 workspace
   * 时下面那个 effect 会读取并恢复. 只在 activeSession.id 有值时写, 不清空. */
  /* 记在会话自己所属的工作区下, 不是外壳当前 workspace (跨项目点会话时后者还没换) —— 见 shouldApplyWorkspaceSideEffect */
  const activeSessionOwnerPath = (activeSession as { workspacePath?: string | null } | null)?.workspacePath ?? null;
  useEffect(() => {
    if (!activeSession?.id) return;
    const owner = activeSessionOwnerPath ?? workspace.path;
    if (!owner) return;
    void (window as any).neox?.uiStateSetLastSession?.(owner, activeSession.id);
  }, [workspace.path, activeSession?.id, activeSessionOwnerPath]);

  const hasBootstrappedRef = useRef(false);
  useEffect(() => {
    if (hasBootstrappedRef.current) return;
    hasBootstrappedRef.current = true;

    /* 先把 sessionStore 初始化时塞进去的 DEFAULT_MODELS (含假的 GPT-4o 占位) 清空,
     * 让 UI 一开始就不显假模型名, 等 loadModels 完成再填真实数据. */
    setAvailableModels([]);

    (async () => {
      /* P3+: 先预载 lastModelId / approval 默认值, 再做后续 selectedModel / session 选择 */
      await Promise.all([
        preloadLastModelId(),
        preloadApprovalModeDefault(),
        preloadEffortPrefs(),
      ]);
      /* 预载完把缓存里的偏好落到 state —— 首帧用的是同步 read (可能还是空的) */
      setEffortPrefs(readEffortPrefs());
      try {
        const api = window.neox as any;
        const useLite = typeof api.getSessionsLite === 'function';
        const all = ((useLite ? await api.getSessionsLite() : await window.neox.getSessions()) as any[])
          .map(sanitizeSessionData);
        setSessions(all);
        if (useLite) {
          void (async () => {
            try {
              const heavy = (await window.neox.getSessions()).map(sanitizeSessionData);
              const byId = new Map(heavy.map((r: any) => [r?.id, r]));
              /* 只补重字段, 其余一律以现有行为准 —— 这一发回来时用户可能已经改过东西了 */
              setSessions(prev => prev.map((row: any) => {
                const h = byId.get(row?.id) as any;
                if (!h) return row;
                let next = row;
                for (const f of ['contextBreakdown', 'latestRequestUsage', 'sessionUsage'] as const) {
                  if (row?.[f] == null && h[f] != null) next = { ...next, [f]: h[f] };
                }
                return next;
              }));
            } catch { /* 补不上就等 contextGetUsage 填, 跟 lite 之前的行为一样 */ }
          })();
        }
      } catch (err) {
        console.error('[NeoxRuntimeBridge] getSessions failed', err);
        dispatchOpFailedFromError('加载会话列表', err);
      } finally {
        /* 不管成败, 标记初次加载结束 — Sidebar 该撤骨架了, 错误时显示空状态 + 上方
         * dispatchOpFailed 走 toast 通道告诉用户, 双通道不冲突. */
        setSessionsLoading(false);
      }

      try {
        /* 三路 merge 后给 picker:
         *   1. autoRouted: BYOK 自动路由虚拟模型 (用户在设置里配的)
         *   2. regular: main 配置文件里的 BYOK provider 模型 (configService.getAvailableModels)
         *   3. subscription: membership.models 现拉合成, providerId='neox-cloud'
         *
         *   关键 — main 的 getAvailableModels 不再包含 neox-cloud (因为 provider.models=[]),
         *   订阅模型完全由 client renderer 从 membershipStore 派生, picker 立等可见, admin 改 0 延迟. */
        const [regular, autoRouted] = await Promise.all([
          window.neox.getAvailableModels(),
          window.neox.getAutoRoutedModels?.() ?? Promise.resolve([]),
        ]);
        const subscription = computeNeoxCloudModels();
        const models: ModelInfo[] = [...autoRouted, ...subscription, ...regular];
        setAvailableModels(models);
        if (models.length > 0) {
          /* 没选过时: 聊天模式走低延迟档 (chat:C8-01), 其他模式走通用兜底。
           * 顺序都收在 modelDefaultPick, 跟下面订阅段刷新那条路共用一份。 */
          const startup = pickStartupModel(models, readLastModelId(), isChatMode(activeSessionIdRef.current));
          autoPickedModelRef.current = startup.autoPicked;
          if (startup.model) setSelectedModel(startup.model);
        }
        /* models === 0: availableModels=[], selectedModel 保留 sessionStore 的占位 —
         * Composer 会把它识别为"未配置"状态 (见下 Composer 改动). */
      } catch (err) {
        console.error('[NeoxRuntimeBridge] getAvailableModels failed', err);
        dispatchOpFailedFromError('加载模型列表', err);
      }
    })();
  }, [
    /* 不依赖 workspace.path — bootstrap 跨 workspace 持久, sessions/models 不重拉 */
    setSessions,
    setAvailableModels,
    setSelectedModel,
  ]);

  const lookupTokenRef = useRef(0);
  const lastSideEffectWorkspaceRef = useRef<string | null>(null);
  useEffect(() => {
    if (!workspace.path) return;
    /* 切换空档里 sessions 刷新引起的重跑, 别清掉刚点中的会话 —— 见 shouldApplyWorkspaceSideEffect */
    if (!shouldApplyWorkspaceSideEffect(lastSideEffectWorkspaceRef, workspace.path, activeSessionIdRef.current)) return;
    const myToken = ++lookupTokenRef.current;
    (async () => {
      try {
        let modeSwitch: string | null = null;
        try { modeSwitch = window.localStorage.getItem('neox-mode-switch-in-progress'); } catch { /* ignore */ }
        if (modeSwitch) {
          try { window.localStorage.removeItem('neox-mode-switch-in-progress'); } catch { /* ignore */ }
          if (myToken !== lookupTokenRef.current) return;
          activeSessionIdRef.current = null;
          activeSessionWorkspacePathRef.current = null;
          setActiveSession(null);
          return;
        }
        const r = await (window as any).neox?.uiStateGetLastSession?.(workspace.path);
        if (myToken !== lookupTokenRef.current) return;
        const lastId = r?.id ?? null;
        const currentActiveId = activeSessionIdRef.current;
        if (shouldKeepActiveSessionOnWorkspaceChange({
          activeSessionId: currentActiveId,
          activeSessionWorkspacePath: activeSessionWorkspacePathRef.current,
          nextWorkspacePath: workspace.path,
        })) {
          /* 会话本就属于这个 workspace — 把 ref 对齐, 后续 effect 走幂等早退. */
          activeSessionWorkspacePathRef.current = workspace.path;
          return;
        }

        let lastSession = lastId
          ? sessions.find((s) => s.id === lastId && workspaceKey(s.workspacePath) === workspaceKey(workspace.path))
          : null;
        try {
          const preferred = (window as { __neoxDefaultAgentMode?: string }).__neoxDefaultAgentMode;
          if (lastSession && preferred) {
            const sessMode = (lastSession as { agentMode?: string | null }).agentMode;
            if (sessMode && sessMode !== preferred) {
              lastSession = null;
            }
          }
        } catch { /* 读全局失败不影响主流程 */ }
        if (lastSession) {
          const liveActiveId = activeSessionIdRef.current;
          const liveActive = liveActiveId
            ? sessions.find((s) => s.id === liveActiveId)
            : null;
          if (shouldSkipLastSessionRestore({
            activeSessionId: liveActiveId,
            activeSessionWorkspacePathFromList: liveActive?.workspacePath ?? null,
            nextWorkspacePath: workspace.path,
            restoreSessionId: lastSession.id,
          })) {
            activeSessionWorkspacePathRef.current = liveActive?.workspacePath ?? activeSessionWorkspacePathRef.current;
            return;
          }
          activeSessionIdRef.current = lastSession.id;
          activeSessionWorkspacePathRef.current = lastSession.workspacePath ?? null;
          setActiveSession(lastSession);
          return;
        }
        /* 跨项目 + 建新会话链路 (AppShell.handleCreateSessionInWorkspace):
         *   flag 存在 = 用户马上会新建 session, 无需先把 activeSession 拉成 null
         *   (会让 timeline 走一次 EmptyState → 300ms 后再切到新 session, 感知为闪烁).
         *   保留旧 activeSession, 让 NeoxShellHost 的 pending flag effect 直接切到新 session,
         *   timeline 只 update 一次. pending-select / 活跃会话已属本工作区 同理, 见 shouldKeepActiveSession. */
        if (shouldKeepActiveSession(activeSessionIdRef.current, sessions, workspace.path)) return;
        if (!sessionsLoading) setActiveSession(null);
      } catch {
        if (shouldKeepActiveSession(activeSessionIdRef.current, sessions, workspace.path)) return;
        if (myToken === lookupTokenRef.current) setActiveSession(null);
      }
    })();
  }, [workspace.path, sessions, sessionsLoading, setActiveSession]);

  /* 模型列表重载 — 触发源:
   *   (a) BYOK provider 增删改 (用户在设置页操作) → dispatch 'neox-providers-changed'
   *   (b) 订阅 membership 刷新 (60s 轮询 / 打开 picker / 登录登出) → membership ref 变化
   *
   *   两条路殊途同归: 把 autoRouted + subscription (membershipStore 现拉) + BYOK (configService)
   *   merge 后塞给 picker. 订阅模型 0 延迟随 membership 变, 不依赖 main IPC 重 sync. */
  useEffect(() => {
    const reloadModels = async () => {
      try {
        const [regular, autoRouted] = await Promise.all([
          window.neox.getAvailableModels(),
          window.neox.getAutoRoutedModels?.() ?? Promise.resolve([]),
        ]);
        const subscription = computeNeoxCloudModels();
        const models: ModelInfo[] = [...autoRouted, ...subscription, ...regular];
        setAvailableModels(models);
        if (models.length > 0) {
          /* 兜底顺序 (订阅 auto → 任意订阅 → BYOK 直连 → 首项) 统一在 modelDefaultPick */
          const fallback = pickFallbackModel(models);
          if (fallback) setSelectedModel((prev) => {
            const kept = prev ? models.find((m) => m.id === prev.id) : undefined;
            if (kept) return kept;
            if (prev && isSubscriptionModel(prev) && subscription.length === 0) return prev;
            /* 真换了也记成兜底挑的, 订阅段到了之后 membership effect 会改回订阅 */
            autoPickedModelRef.current = true;
            return fallback;
          });
        }
      } catch (err) {
        console.error('[NeoxRuntimeBridge] reloadModels failed', err);
      }
    };
    const onChanged = () => { void reloadModels(); };
    window.addEventListener('neox-providers-changed', onChanged);
    return () => window.removeEventListener('neox-providers-changed', onChanged);
  }, [setAvailableModels, setSelectedModel]);


  /* 监听 sessions-changed 通知 — auth DB 就绪 / mobile 新建 session 后刷新. */
  useEffect(() => {
    const api = (window as any).neox?.mobileBridge;
    if (!api?.onSessionsChanged) return;
    const unsub = api.onSessionsChanged(() => {
      void (async () => {
        try {
          const all = (await window.neox.getSessions()).map(sanitizeSessionData);
          setSessions(all);
          const cur = activeSessionRef.current;
          if (cur) {
            const fresh = all.find((s) => s.id === cur.id);
            if (fresh && (
              !sameWorkspace(fresh.workspacePath, cur.workspacePath)
              || fresh.modelId !== cur.modelId
              || fresh.name !== cur.name
              || (fresh.taskDir ?? null) !== (cur.taskDir ?? null)
            )) {
              patchActiveSession(cur.id, fresh);
            }
          }
        } catch (err) {
          console.warn('[NeoxRuntimeBridge] sessions-changed refresh failed', err);
        }
      })();
    });
    return () => { try { unsub?.(); } catch { /* ignore */ } };
  }, [setSessions, patchActiveSession]);

  /* 监听 mobile-bridge 联动 — mobile 打开某 session 时, desktop 自动跳到同一 session
   *  (mirrorPolicy='always' 时). 'manual' / 'never' 不联动 — 用户在 mobile 上看自己的,
   *  desktop 端各看各. */
  useEffect(() => {
    const api = (window as any).neox?.mobileBridge;
    if (!api?.onMobileActiveSession) return;
    const unsub = api.onMobileActiveSession((sessionId: string) => {
      if (!sessionId) return;
      void (async () => {
        try {
          /* 读 session metadata 看 mirrorPolicy. 默认 'always' (跟 mobile/server 端默认一致). */
          const meta = await (window.neox as any).getSession?.(sessionId);
          const policy = (meta?.mirrorPolicy ?? 'always') as string;
          if (policy !== 'always') {
            /* 用户显式设 manual/never → 桌面不联动, 跟 mobile mirror policy 语义一致 */
            return;
          }
          const sanitized = sanitizeSessionData(meta);
          const targetMode = (sanitized as { agentMode?: string | null } | null)?.agentMode ?? null;
          const hereMode = (activeSessionRef.current as { agentMode?: string | null } | null)?.agentMode
            ?? (window as { __neoxDefaultAgentMode?: string }).__neoxDefaultAgentMode ?? null;
          if (sanitized && targetMode !== 'pilot' && (!targetMode || !hereMode || targetMode === hereMode)) setActiveSession(sanitized);
        } catch (err) {
          console.warn('[NeoxRuntimeBridge] mobile-active-session jump failed', err);
        }
      })();
    });
    return () => { try { unsub?.(); } catch { /* ignore */ } };
  }, [setActiveSession]);

  /* 监听 membership 数据变化 (订阅 model 列表的真实来源) — admin 改 plan/model 后,
   *   60s 后台轮询会刷 membership ref, 这里 reload 把订阅段重渲. picker 打开时 ETag 又会再
   *   立即拉一次, 双路兜底, 0 stale. */
  const membershipForReload = useEditionMembership();
  useEffect(() => {
    const cloudModels = computeNeoxCloudModels();
    /* 云端段 = 订阅 + 按量 (neox-cloud-payg)。自动挑默认 / 兜底只从**订阅**里挑 ——
     * 按量花的是余额, 不能在用户没点的情况下替他选上 */
    const subscription = cloudModels.filter((m: ModelInfo) => !m.payAsYouGo && isChatModelInfo(m));
    /* 保留非云端段 (BYOK + autoRouted), 只替换云端那一块 — 不重拉 IPC,
     *   省去无意义的 main 进程往返. setAvailableModels 是直传 value 接口, 这里读
     *   sessionState.availableModels 当前 snapshot 算 diff 再传. */
    const prevModels = sessionState.availableModels;
    const nonSubs = prevModels.filter((m: ModelInfo) => !isNeoxCloudProviderId(m.providerId));
    const nextModels = [...nonSubs, ...cloudModels];
    setAvailableModels(nextModels);
	      /* selectedModel 防御性校正 — 如果当前选的云端 model 在新列表里没了 (plan 降级 / model 下架),
	       *   优先切回本机 BYOK, 没有 BYOK 再切云端可用项。如果 id 还在但规格变了, 也替换成新对象, 否则底部
	       *   context popup 会继续拿旧 contextWindow。 */
	      const currentSel = sessionState.selectedModel;
      const selStillValid = currentSel && nextModels.some((m: ModelInfo) => m.id === currentSel.id);
      if (shouldReconsiderAutoPick({
        current: currentSel,
        autoPicked: autoPickedModelRef.current,
        subscriptionCount: subscription.length,
      })) {
        const pick = pickReconsideredForMode(subscription, readLastModelId(), isChatMode(activeSessionIdRef.current));
        if (pick) {
          setSelectedModel(pick);
          const sid = activeSessionIdRef.current;
          if (sid) modelBySessionRef.current.set(sid, pick.id);
        }
      } else if (!selStillValid) {
        const pick = subscription.find((m) => isAutoRoutedModelName(m.name))
          ?? subscription[0]
          ?? nextModels.find((m: ModelInfo) => !isNeoxCloudProviderId(m.providerId) && !m.isAutoRouted && isChatModelInfo(m))
          ?? nextModels.find((m: ModelInfo) => !m.payAsYouGo && isChatModelInfo(m));
        if (pick) {
          setSelectedModel(pick);
          /* 这段也可能是"订阅段还没到"时挑的 BYOK —— 同样记成兜底挑的 */
          autoPickedModelRef.current = !isNeoxCloudProviderId(pick.providerId);
        }
      } else if (currentSel && isNeoxCloudProviderId(currentSel.providerId)) {
	        const refreshed = cloudModels.find((m) => m.id === currentSel.id);
	        if (!refreshed) {
	          const nextByok = nextModels.find((m) => !isNeoxCloudProviderId(m.providerId) && !m.isAutoRouted && isChatModelInfo(m));
	          /* 服务端 auto 入口 id 带档位前缀 (or-free-auto 等), 不能只认裸 'auto' */
          const next = nextByok ?? subscription.find((m) => isAutoRoutedModelName(m.name)) ?? subscription[0];
	          if (next) setSelectedModel(next);
      } else if (
        refreshed.contextWindow !== currentSel.contextWindow ||
        refreshed.maxTokens !== currentSel.maxTokens ||
        refreshed.supportsVision !== currentSel.supportsVision ||
        refreshed.supportsThinking !== currentSel.supportsThinking
      ) {
        setSelectedModel(refreshed);
      }
    }
    /* BYOK 当前选中不受 membership 变化影响, 不处理. */
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [membershipForReload]);

  /* ---------- 防御性 selectedModel 校正 ----------
   *   未登录只挡 Neox Cloud 订阅模型; BYOK 直连/自动路由都是本地能力。 */
  const { isAuthenticated, user } = useEditionAuth();

  /* transport 信号 — 用 NeoxShellHost 已经广播的 'neox:active-session-cloud-state' event
   * 同源 (composer 的 RunDestinationPicker 也是听同一个 event 显"本地/云端").
   * 真相源单一: UI 显云端 → sendPrompt 也走云端. 不再独立计算重复一份. */
  const [activeIsCloud, setActiveIsCloud] = useState(false);
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      setActiveIsCloud(!!detail?.cloudActive);
    };
    window.addEventListener('neox:active-session-cloud-state', handler as EventListener);
    /* mount 时主动 ping 一下 — 防止刚挂载错过初始事件 */
    window.dispatchEvent(new CustomEvent('neox:request-cloud-state'));
    return () => window.removeEventListener('neox:active-session-cloud-state', handler as EventListener);
  }, []);

  /* 切账户 / logout 时拍平 sessionStore — 防 user A 残留的 sessions / messages / streaming
   * 状态在 user B 登录瞬间被看到 (国内共享电脑场景必修).
   *   · prevUserId → null      = logout
   *   · prevUserId → newUserId = 切账户 (A 直接切 B, 不经过 logout)
   * 用 ref 持上一轮 userId, 不触发额外 render. */
  const prevUserIdRef = useRef<string | null>(null);
  const reloadSessionsAfterAuthChange = useCallback(async (reason: string) => {
    try {
      setSessionsLoading(true);
      await new Promise(r => setTimeout(r, 300));
      const all = (await window.neox.getSessions()).map(sanitizeSessionData);
      setSessions(all);
      console.info(`[NeoxRuntimeBridge] sessions reloaded (${reason}): ${all.length} sessions`);

      /* DB 切换后 sessions 变了, workspace restore effect 会因 sessions 更新自动重试 lastSession。 */
    } catch (err) {
      console.error(`[NeoxRuntimeBridge] reload sessions failed (${reason})`, err);
    } finally {
      setSessionsLoading(false);
    }
  }, [setSessions, setSessionsLoading]);

  useEffect(() => {
    const curr = user?.id ?? null;
    const prev = prevUserIdRef.current;
    prevUserIdRef.current = curr;

    if (prev === curr) return;

    if (prev !== curr) {
      console.info('[NeoxRuntimeBridge] auth user changed (BYOK-local)', { from: prev, to: curr });
      void reloadSessionsAfterAuthChange(prev === null ? 'login' : curr === null ? 'logout' : 'user-switch');
    }
  }, [user?.id, reloadSessionsAfterAuthChange]);

  const membership = useEditionMembership();
  useEffect(() => {
    if (!selectedModel) return;
    const isCloud = isNeoxCloudProviderId(selectedModel.providerId);
    if (isCloud && !isAuthenticated) {
      const fallback = availableModels.find(m => !isNeoxCloudProviderId(m.providerId)) ?? null;
      if (fallback && fallback.id !== selectedModel.id) {
        setSelectedModelPersisted(fallback);
      }
    }
  }, [
    isAuthenticated,
    membership?.plan?.id,
    availableModels,
    selectedModel,
    setSelectedModelPersisted,
  ]);

  const activeSessionRef = useRef(activeSession);
  activeSessionRef.current = activeSession;
  useEffect(() => {
    if (!activeSession?.id) {
      activeSessionIdRef.current = null;
      activeSessionWorkspacePathRef.current = null;
      setMessages([]);
      setTimelineEvents([]);
      setStreaming(false);
      setPaused(false);
      setCanRetry(false);
      setLastError(null);
      setTurnStartedAt(null);
      setStatus('Idle');
      setTotalTokens(0);
      setContextUsed(0);
      setStreamingTokens(0);
      return;
    }
    /* id 驱动 + ref 取对象: 读到的是本次切换渲染帧的最新 session 快照, 语义同旧实现 */
    const session = activeSessionRef.current ?? activeSession;
    const sid = activeSession.id;
    activeSessionIdRef.current = sid;
    activeSessionWorkspacePathRef.current = session.workspacePath ?? null;
    setMessages(session.messages ?? []);
    /* 子会话正在跑且内存里已有直播条目 → 不要拿 DB/列表快照去 initialize,
     * 否则 persist 的 sub- id 会被当成新鲜增量, 把正在流的卡片打成静照。 */
    const childLive =
      !!(session as { parentSessionId?: string }).parentSessionId
      && runningSubAgentIdsRef.current.has(sid)
      && (timelineMapRef.current.get(sid)?.length ?? 0) > 0;
    const old = childLive ? undefined : (session.timeline ? normalizeTimeline(session.timeline) : undefined);
    const sessionRunning =
      streamingBySessionRef.current.get(sid) === true || runningSubAgentIdsRef.current.has(sid);
    /* 水合标记 —— 让 AgentTimelineView 在数据到位前显示骨架而不是空状态。
       解除放 finally: 加载失败时不解除的话界面会永远停在骨架上, 比闪一下糟得多。 */
    setTimelineHydrating(sid);
    const hydrateGuard = window.setTimeout(() => {
      if (getTimelineHydratingSessionId() === sid) setTimelineHydrating(null);
    }, 2000);
    const initTimelinePromise = initializeSessionTimeline(sid, old, { settlePending: !sessionRunning })
      .finally(() => {
        if (getTimelineHydratingSessionId() !== sid) window.clearTimeout(hydrateGuard);
      });
    /* 真源被旧 bug 删光的会话 —— 用消息原文重建, 否则永远停在骨架上 (见 lostTimelineRecovery.ts) */
    if (!(session as { parentSessionId?: string }).parentSessionId && !sessionRunning) {
      void initTimelinePromise
        .then((loaded) => recoverLostTimeline(sid, loaded, appendTimelineEntry, () => activeSessionIdRef.current === sid))
        .catch((err) => console.warn('[NeoxRuntimeBridge] lost timeline recovery failed', err));
    }
    void (async () => {
      try {
        const turns = await (window as any).neox?.getSessionTurnUsage?.(sid);
        if (!Array.isArray(turns) || turns.length === 0) return;
        await initTimelinePromise.catch(() => undefined);
        if (activeSessionIdRef.current !== sid) return; /* 期间又切走了 */
        /* ChatMessage 列表: 助手消息与 turn 一一对应且都按时间升序 —— 顺序消费。
         * 多余的 turn (子 agent / 被删消息) 跳过到不晚于本条消息的那一个。 */
        let ti = 0;
        setMessages((prev: ChatMessage[]) => prev.map((m) => {
          if (m.role !== 'assistant') return m;
          /* 已有明细就不覆盖; 只有合计时仍补 turnUsage (点开才有输入/缓存/输出) */
          if ((m as any).turnUsage) return m;
          while (ti + 1 < turns.length && turns[ti].timestamp < (m.timestamp ?? 0) - 1000) ti++;
          const t = turns[ti];
          if (!t) return m;
          ti++;
          const turnUsage = (t.inputTokens || t.outputTokens || t.cacheReadTokens) ? {
            inputTokens: t.inputTokens || 0,
            outputTokens: t.outputTokens || 0,
            cacheReadTokens: t.cacheReadTokens || 0,
          } : undefined;
          return {
            ...m,
            turnTokens: (m as any).turnTokens || t.totalTokens || undefined,
            turnUsage,
            model: (m as any).model || t.model || undefined,
          };
        }));
        const ams = (timelineMapRef.current.get(sid) || [])
          .filter((e) => e.type === 'assistant_message');
        const claimed = new Set<string>();
        for (const t of turns) {
          let best: (typeof ams)[number] | null = null;
          for (const e of ams) {
            if (claimed.has(e.id)) continue;
            if (((e.timestamp as number) ?? 0) <= t.timestamp + 2000
              && (!best || ((e.timestamp as number) ?? 0) >= ((best.timestamp as number) ?? 0))) {
              best = e;
            }
          }
          if (!best) continue;
          claimed.add(best.id);
          if ((best as any).turnUsage) continue;
          updateTimelineEntryById(sid, best.id, {
            turnTokens: (best as any).turnTokens || t.totalTokens || undefined,
            turnUsage: (t.inputTokens || t.outputTokens || t.cacheReadTokens) ? {
              inputTokens: t.inputTokens || 0,
              outputTokens: t.outputTokens || 0,
              cacheReadTokens: t.cacheReadTokens || 0,
            } : undefined,
            model: (best as any).model || t.model || undefined,
          } as any);
        }
      } catch { /* 回填失败不影响会话 */ }
    })();
    if ((session as { parentSessionId?: string }).parentSessionId && window.neox?.timelinePage && !childLive) {
      void window.neox.timelinePage(sid, { limit: 5000 })
        .then((page: any) => {
          const t = page?.ok ? page.entries : undefined;
          if (Array.isArray(t) && t.length > 0 && activeSessionIdRef.current === sid) {
            return initializeSessionTimeline(sid, normalizeTimeline(t));
          }
          return undefined;
        })
        .catch(() => { /* 拉失败保持旧快照, 不影响主流程 */ });
    }
    /* 从 per-session map 恢复 UI 状态.
     *  关键: sendPrompt 用 dispatchStreamingPerSession(true, sid) 写过 map 后,
     *  本 effect 读到 true 不会反向覆盖, 同帧"新建 session + 发送"流程不破坏 streaming=true.
     *  子会话不在 L0, map 里经常没有这个 sid —— 用 runningSubAgentIds 补上,
     *  否则点进正在跑的子线程 composer 是待机「继续补充要求…」。 */
    const childRunning = runningSubAgentIdsRef.current.has(sid);
    const streamingNow = streamingBySessionRef.current.get(sid) ?? childRunning;
    if (streamingNow) streamingBySessionRef.current.set(sid, true);
    setStreaming(!!streamingNow);
    /* 子会话不在 L0, 对账只会把"查不到"当闲置。主会话才问权威。 */
    if (!(session as { parentSessionId?: string }).parentSessionId) {
      void reconcileExecutionStateFromAuthority(`session-switch:${sid.slice(0, 8)}`);
    }
    setPaused(pausedBySessionRef.current.get(sid) ?? false);
    setCanRetry(canRetryBySessionRef.current.get(sid) ?? false);
    setLastError(lastErrorBySessionRef.current.get(sid) ?? null);
    setTurnStartedAt(turnStartedAtBySessionRef.current.get(sid) ?? null);
    const restoredStatus = statusBySessionRef.current.get(sid)
      ?? (childRunning ? 'Running' : 'Idle');
    if (childRunning && restoredStatus === 'Running') {
      statusBySessionRef.current.set(sid, 'Running');
    }
    setStatus(restoredStatus);
    setTotalTokens(session.totalTokens ?? 0);
    setContextUsed(session.contextUsed ?? session.totalTokens ?? 0);
    /* 流式 HUD 计数是"当前活跃会话"的单值 — 切会话清零, 防上一会话的数字残显;
     * 切进正在跑的会话时, 下一个 token 事件会用该会话的累积值整体覆盖回来。 */
    setStreamingTokens(0);
    {
      const sessAny = session as {
        contextWindow?: number;
        contextBreakdown?: unknown;
        latestRequestUsage?: unknown;
        sessionUsage?: unknown;
      };
      const live = getContextSnapshot(sid);
      const liveFresh = !!(live && (
        live.latestRequestUsage || live.sessionCache || (live.tokensUsed ?? 0) > 0
      ));
      if (!liveFresh) {
        setContextSnapshot({
          tokensUsed: session.contextUsed ?? session.totalTokens ?? 0,
          contextWindow: sessAny.contextWindow ?? 0,
          breakdown: sessAny.contextBreakdown as any,
          latestRequestUsage: sessAny.latestRequestUsage as any,
          sessionCache: sessAny.sessionUsage as any,
          sessionId: sid,
          updatedAt: Date.now(),
        });
      }
      const api = (window as any).neox;
      if (typeof api?.contextGetUsage === 'function') {
        void api.contextGetUsage(sid)
          .then((data: any) => {
            if (!data || activeSessionIdRef.current !== sid) return;
            /* 若切过去之后 live metrics 又写了更新, 不要用较旧 IPC 回包盖掉 */
            const current = getContextSnapshot(sid);
            const currentIsLiveStreaming = streamingBySessionRef.current.get(sid) === true
              && current && (Date.now() - (current.updatedAt || 0)) < 5000;
            if (currentIsLiveStreaming) return;
            setContextSnapshot({
              tokensUsed: data.currentTokens ?? session.contextUsed ?? 0,
              contextWindow: data.maxTokens ?? sessAny.contextWindow ?? 0,
              breakdown: data.breakdown ?? sessAny.contextBreakdown,
              latestRequestUsage: data.latestRequestUsage ?? sessAny.latestRequestUsage,
              sessionCache: data.sessionCache ?? sessAny.sessionUsage,
              sessionId: sid,
              updatedAt: Date.now(),
            });
            if (typeof data.currentTokens === 'number' && data.currentTokens > 0) {
              setContextUsed(data.currentTokens);
            }
          })
          .catch(() => { /* hydrate 失败保留上面同步种子 */ });
      }
    }
    /* sendingRef / cloudAutoRecover refs 是 transient 操作守卫, 跟 session 切换无关 — 不动 */
    // eslint-disable-next-line react-hooks/exhaustive-deps -- session 对象经 activeSessionRef 读, 只按 id 触发
  }, [activeSession?.id, initializeSessionTimeline, updateTimelineEntryById, setMessages, setStreaming, setPaused, setStatus, setTotalTokens, setContextUsed, setStreamingTokens]);

  /* 点进子会话 = 跟主会话同一套运行态: streaming / 停止按钮跟着子 sessionId 走。
   * runningSubAgentIds 的成员就是正在跑的子 session id (agentId === sessionId)。 */
  useEffect(() => {
    const sid = activeSession?.id;
    if (!sid) return;
    const isChild = !!(activeSession as { parentSessionId?: string } | null)?.parentSessionId
      || runningSubAgentIds.has(sid);
    if (!isChild) return;
    const running = runningSubAgentIds.has(sid);
    if (running && stoppedSessionsRef.current.has(sid)) return;
    if (!running) stoppedSessionsRef.current.delete(sid);
    dispatchStreamingPerSession(running, sid);
    if (running) {
      const prev = statusBySessionRef.current.get(sid);
      if (!prev || prev === 'Idle') {
        statusBySessionRef.current.set(sid, 'Running');
        setStatus('Running');
      }
    }
  }, [activeSession?.id, runningSubAgentIds, dispatchStreamingPerSession, setStatus]);

  /* 模型选择还原拆成独立 effect — 启动时 models 加载晚于 session 恢复, 到位后要补一次
   * 还原; 但不能因此让上面的切换镜像 effect 挂 models 依赖 (models 刷新会整段重跑)。 */
  useEffect(() => {
    const sid = activeSession?.id;
    if (!sid || availableModels.length === 0) return;
    /* 模型选择: per-session ref → session.modelId.
     *   切 session A → session B 时, B 的模型必须从 B 自己的绑定还原,
     *   绝不能静默保留 A 的 selectedModel (用户报"进老会话还是新模型")。
     *   不做全局 lastModelId fallback — lastModelId 只服务"全新空会话"。 */
    const sessionModelId =
      modelBySessionRef.current.get(sid) ?? (activeSessionRef.current as { modelId?: string } | null)?.modelId ?? null;
    if (sessionModelId) {
      const found = findModelInAvailableList(availableModels, sessionModelId);
      /* 聊天会话以前被绑成了出图模型 (见 setSelectedModelPersisted 的 bindable): 不还原它, 用默认模型 */
      const isImageSession = (activeSessionRef.current as { kind?: string } | null)?.kind === 'image';
      if (found && !isChatModelInfo(found) && !isImageSession) {
        const fallback = (() => { const id = readLastModelId(); return id ? findModelInAvailableList(availableModels, id) : undefined; })();
        const pick = fallback && isChatModelInfo(fallback) ? fallback : pickFallbackModel(availableModels);
        if (pick) { setSelectedModel(pick); modelBySessionRef.current.set(sid, pick.id); }
        return;
      }
      if (found) {
        setSelectedModel(found);
        modelBySessionRef.current.set(sid, found.id);
        autoPickedModelRef.current = false;   /* 会话绑定 = 用户定过的, 订阅段迟到也不许改 */
      }
      return;
    }
    if (selectedModel?.id && !autoPickedModelRef.current) {
      modelBySessionRef.current.set(sid, selectedModel.id);
    }
  }, [activeSession?.id, availableModels, selectedModel?.id, setSelectedModel]);

  useEffect(() => {
    if (!activeSession?.id) return;
    const mode = (activeSession as { agentMode?: string } | null)?.agentMode;
    if (mode !== 'work' && mode !== 'pilot') return; /* Code 模式不管 */

    const api = (window as any).neox;
    if (typeof api?.agentModeEnsureHome !== 'function') return;

    let cancelled = false;
    void (async () => {
      const home = await api.agentModeEnsureHome(mode).catch(() => null);
      if (cancelled) return;
      if (!home?.success || !home.path) return;
      /* 当前 workspace 已经匹配就 no-op */
      if (workspace.path && workspace.path === home.path) return;
      /* 静默切 workspace — 走 open-workspace 事件让 AppShell 走标准链路,
       * 同步 renderer state + workspace roots. */
      window.dispatchEvent(new CustomEvent('neox:open-workspace', { detail: { path: home.path, silent: true } }));
    })();

    return () => { cancelled = true; };
  }, [activeSession, workspace.path]);

  /* ---------- Turn 计时 ---------- */
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);
  /* 上一帧是不是 streaming, 用来检测 true→false 边沿 (一次完整对话结束) */
  const wasStreamingRef = useRef<boolean>(false);
  useEffect(() => {
    if (streaming) {
      wasStreamingRef.current = true;
      setTurnStartedAt((prev) => prev ?? Date.now());
      setPaused(false);
      setCanRetry(false);
      setLastError(null);
    } else {
      setTurnStartedAt(null);
      /* streaming 归位 (由 useStreamHandler 在响应完成时触发) —
       * 同步释放当前会话的发送守卫, 允许下一轮发送 */
      const owner = sendGuardsRef.current.get(activeSessionIdRef.current);
      if (owner && !owner.pending) markSendGuard('release', 'streaming-false-effect');
      sendGuardsRef.current.settle(activeSessionIdRef.current);
      /* 一次完整对话刚结束 → 主动刷新 membership, 让积分徽章秒级看到扣减.
       *   只在 true→false 这个边沿触发 (初次挂载 streaming=false 时不要乱发).
       *   membershipStore 内部 inflight 去重, 多个 send 紧密串行也只会发一次. */
      if (wasStreamingRef.current) {
        wasStreamingRef.current = false;
        void flushPendingWrites();
        processPendingTurnAudits(activeSessionIdRef.current ?? undefined);
        void getEditionHook('refreshMembership')();
      }
    }
  }, [processPendingTurnAudits, streaming]);

  /* ---------- per-session map sync — cold state (paused/canRetry/lastError/turnStartedAt) ---------- */
  useEffect(() => {
    const sid = activeSessionIdRef.current;
    if (!sid) return;
    pausedBySessionRef.current.set(sid, paused);
  }, [paused]);
  useEffect(() => {
    const sid = activeSessionIdRef.current;
    if (!sid) return;
    canRetryBySessionRef.current.set(sid, canRetry);
  }, [canRetry]);
  useEffect(() => {
    const sid = activeSessionIdRef.current;
    if (!sid) return;
    lastErrorBySessionRef.current.set(sid, lastError);
  }, [lastError]);
  useEffect(() => {
    const sid = activeSessionIdRef.current;
    if (!sid) return;
    turnStartedAtBySessionRef.current.set(sid, turnStartedAt);
  }, [turnStartedAt]);

  /* ---------- Actions: createNewSession / selectSession / sendPrompt / pause / stop ---------- */
  /* createNewSession / selectSession / continueLast 走 useStableCallback: 它们互相引用、又被几十个
   * 回调和 context value 引用, 用 useCallback 会串成一条攥着每次渲染状态的闭包链 (见 hooks/useStableCallback.ts) */
  const createNewSession = useStableCallback(async (opts?: { kind?: 'chat' | 'image'; name?: string }): Promise<Session | null> => {
    /* 图片会话不依赖聊天 selectedModel — 否则图片页未选聊天模型时 create 失败,
     * turn 落到 'image-studio' 空槽后会话一切换就对不上, 用户只能在图库里看到图. */
    const lastId = opts?.kind === 'image' ? null : readLastModelId();
    const lastFound = lastId ? findModelInAvailableList(availableModels, lastId) : undefined;
    const defaultModel = lastFound && isChatModelInfo(lastFound) ? lastFound : undefined;
    const modelForSession = defaultModel
      ?? (opts?.kind === 'image' || !selectedModel || isChatModelInfo(selectedModel) ? selectedModel : pickFallbackModel(availableModels))
      ?? (opts?.kind === 'image'
        ? (availableModels.find((m) => /image|gpt-image|dall-e|flux|seedream|cogview/i.test(String(m.id) + String((m as { name?: string }).name || '')))
          || availableModels[0])
        : null);
    if (!modelForSession) {
      console.warn('[NeoxRuntimeBridge] createNewSession: no selected model');
      return null;
    }
    const subscriptionLoaded = availableModels.some((m) => isNeoxCloudProviderId(m.providerId));
    const pendingDefaultId = !defaultModel && lastId && isNeoxCloudProviderId(lastId.split(':')[0]) && !subscriptionLoaded
      ? lastId
      : null;
    const sessionModelId = pendingDefaultId ?? modelForSession.id;
    try {
      const effectiveMode = resolveEffectiveAgentMode({
        sessionAgentMode: (activeSession as { agentMode?: string | null } | null)?.agentMode,
        sessionKind: (activeSession as { kind?: string } | null)?.kind,
        ambientDefault: (window as { __neoxDefaultAgentMode?: string }).__neoxDefaultAgentMode,
      });
      const modeHomePath = hasModeHome(effectiveMode) && opts?.kind !== 'image'
        ? (await (window as any).neox?.agentModeEnsureHome?.(effectiveMode))?.path ?? null
        : null;
      const wsPath = resolveNewSessionWorkspace({
        effectiveMode,
        kind: opts?.kind,
        currentWorkspacePath: workspace.path,
        modeHomePath,
      });
      /* 决定 workspace 的 mode 必须同时写进会话 —— 否则 store 退回全局 defaultAgentMode,
       * 会话被绑进「工作」目录却盖上 code 的章 (见 chatSessionHandlers session:create 注释)。
       * 图片会话跟模式正交, 不盖章 (resolveEffectiveAgentMode 也不拿它当模式依据)。 */
      const createOpts = opts?.kind === 'image' ? opts : { ...(opts ?? {}), agentMode: effectiveMode };
      const s = await window.neox.createSession(wsPath, sessionModelId, createOpts);
      const sanitized = sanitizeSessionData(s);
      if (opts?.kind === 'image') {
        const now = new Date();
        const zh = (window as any).__NEOX_LANG !== 'en';
        const name = opts.name ?? (zh ? `图片·${now.getMonth() + 1}月${now.getDate()}日` : `Images · ${now.toLocaleDateString([], { month: 'short', day: 'numeric' })}`);
        void window.neox.renameSession(sanitized.id, name).catch(() => { /* 不阻塞 */ });
        sanitized.name = name;
        (sanitized as { kind?: string }).kind = 'image';
      }
      const mode = (sanitized as { agentMode?: string | null }).agentMode;
      if (opts?.kind !== 'image' && mode === 'work') {
        const now = new Date();
        const zh = (window as any).__NEOX_LANG !== 'en';
        const name = zh ? `工作·${now.getMonth() + 1}月${now.getDate()}日`
          : `Work · ${now.toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
        void window.neox.renameSession(sanitized.id, name).catch(() => { /* 不阻塞 */ });
        sanitized.name = name;
        /* 侧栏选着 Work 项目: 新任务进这个项目 (任务文件夹首条消息时建在项目文件夹里) */
        const projectDir = getWorkProjectFilter();
        if (projectDir) {
          const taskDir = await assignTaskToProject(sanitized.id, projectDir).catch(() => null);
          if (taskDir) sanitized.taskDir = taskDir;
        }
      }
      setSessions((prev) => [sanitized, ...prev.filter((x) => x.id !== sanitized.id)]);
      setActiveSession(sanitized);
      setMessages([]);
      activeSessionIdRef.current = sanitized.id;
      activeSessionWorkspacePathRef.current = sanitized.workspacePath ?? null;
      modelBySessionRef.current.set(sanitized.id, sessionModelId);
      if (!pendingDefaultId && selectedModel?.id !== modelForSession.id) setSelectedModel(modelForSession);
      await applyApprovalModeDefaultToSession(sanitized.id).catch((err) => {
        console.warn('[NeoxRuntimeBridge] apply approval default failed:', err?.message);
      });
      return sanitized;
    } catch (err) {
      console.error('[NeoxRuntimeBridge] createSession failed', err);
      dispatchOpFailedFromError('创建会话', err);
      return null;
    }
  });

  const selectSession = useStableCallback(
    (id: string) => {
      void (async () => {
        const fromStore = sessions.find((x) => x.id === id);
        if (fromStore) {
          activeSessionIdRef.current = fromStore.id;
          activeSessionWorkspacePathRef.current = fromStore.workspacePath ?? null;
          setActiveSession(fromStore);
          return;
        }

        /* IPC / 外部 createSession 已写 SQLite, 但 React sessions 尚未刷新时会 miss.
         * 先 getSession 拉真实元数据 (name/model/workspace), 再 merge 进 store —
         * 避免误标「云端会话」(QA: 73/73 探针命中). */
        try {
          const meta = await window.neox.getSession?.(id);
          if (meta) {
            const sanitized = sanitizeSessionData(meta);
            setSessions((prev) => {
              if (prev.some((x) => x.id === sanitized.id)) {
                return prev.map((x) => (x.id === sanitized.id ? { ...x, ...sanitized } : x));
              }
              return [sanitized, ...prev];
            });
            activeSessionIdRef.current = sanitized.id;
            activeSessionWorkspacePathRef.current = sanitized.workspacePath ?? null;
            setActiveSession(sanitized);
            return;
          }
        } catch (err) {
          console.warn('[NeoxRuntimeBridge] selectSession getSession failed', err);
        }

        /* 真·云端-only (本机 SQLite 无条目) — minimal stub 让 timeline 能 mount.
         * 标题用短 id, 不再硬编码「云端会话」误导本地会话. */
        const minimal: Session = {
          id,
          name: `会话 ${id.slice(-6)}`,
          messages: [],
          modelId: (selectedModel?.id ?? undefined) as any,
          totalTokens: 0,
          contextUsed: 0,
          updatedAt: Date.now(),
          createdAt: Date.now(),
          workspacePath: workspace.path,
        } as any;
        activeSessionIdRef.current = minimal.id;
        activeSessionWorkspacePathRef.current = minimal.workspacePath ?? null;
        setActiveSession(minimal);
      })();
    },
  );

  const renameSession = useCallback(
    async (id: string, name: string, options?: { silent?: boolean }) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      try {
        const updated = await window.neox.renameSession(id, trimmed);
        const sanitized = sanitizeSessionData(updated);
        setSessions((prev) => prev.map((x) => (x.id === id ? sanitized : x)));
        patchActiveSession(id, sanitized);
        /* 用户主动改名才弹 toast — sendPrompt 自动改名 (用首句派生 title) 不打扰. */
        if (!options?.silent) dispatchHint(`已重命名为「${trimmed}」`, 'success');
      } catch (err) {
        console.error('[NeoxRuntimeBridge] renameSession failed', err);
        dispatchOpFailedFromError('重命名会话', err);
      }
    },
    [setSessions, patchActiveSession],
  );

  const deleteSession = useCallback(
    async (id: string) => {
      /* 删除前先记下当前 workspace, 用于后面选邻近 session 的过滤 — 删除的可能就是 active 的,
       * 用 activeSession.workspacePath 而不是当前的 workspace.path (后者是 host shell 的 active 项目). */
      const targetWorkspace = activeSession?.id === id
        ? (activeSession as any).workspacePath ?? workspace.path
        : workspace.path;
      let cloudOk = true;
      let cloudError: string | undefined;
      try {
        const result = await window.neox.deleteSession(id) as any;
        /* main 进程返 { ok, cloudOk, cloudError } — 老版本 preload 返 void 时按成功处理. */
        if (result && typeof result === 'object') {
          cloudOk = result.cloudOk !== false;
          cloudError = result.cloudError;
        }
      } catch (err) {
        console.error('[NeoxRuntimeBridge] deleteSession failed', err);
        dispatchOpFailedFromError('删除会话', err);
        return;
      }
      /* cloud cleanup 失败 — 本地已删但服务端 row 还在. 提示用户但不阻塞 UI 删除 (sidebar 还是消失).
       *  跨设备登录看到这条 session 残留的话用户可以再删. */
      if (!cloudOk) {
        dispatchHint(`已删除本地, 云端清理失败 (${cloudError ?? '未知'}), 稍后会自动重试`, 'warning');
      }
      const remaining = sessions.filter((x) => x.id !== id);
      setSessions(remaining);
      if (activeSession?.id === id) {
        const sameWorkspace = remaining
          .filter((x) => ((x as any).workspacePath ?? null) === targetWorkspace)
          .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
        const next = sameWorkspace[0] ?? null;
        setActiveSession(next);
        if (next) {
          activeSessionIdRef.current = next.id;
          setMessages(next.messages ?? []);
        } else {
          activeSessionIdRef.current = null;
          setMessages([]);
        }
      }
      clearTimeline(id).catch((err) => {
        console.warn('[NeoxRuntimeBridge] clearTimeline after deleteSession failed:', err);
      });
      /* graph 快照残留同理清一下. neox-graph-state 库已被 SQLite app_state 方案替代
       *  (见 electron/ipc/graphHandlers.ts), 当前无写入方 — 这里清的是老版本遗留的快照.
       *  dynamic import 跟下方 surfaceStore 同款, 失败同样不阻塞. */
      void import('../services/graphStateDB')
        .then(({ deleteSnapshot }) => deleteSnapshot(id))
        .catch((err) => {
          console.warn('[NeoxRuntimeBridge] graph snapshot cleanup after deleteSession failed:', err);
        });
      /* 清理 per-session UI 状态 map — 删的 session 不该残留在 streaming/paused/error 等 ref 里. */
      streamingBySessionRef.current.delete(id);
      syncRunningSessionIds(id, false);
      pausedBySessionRef.current.delete(id);
      canRetryBySessionRef.current.delete(id);
      lastErrorBySessionRef.current.delete(id);
      turnStartedAtBySessionRef.current.delete(id);
      statusBySessionRef.current.delete(id);
      void import('../state/surfaceStore').then(({ cleanupSurfaceSession }) => cleanupSurfaceSession(id));
      /* 触发 cloud sessions 刷新 — cloud-only session 不在 local sessions array 里,
       *  得让 useCloudSessions 重拉 server 列表才能从 sidebar 消失 (state=terminated 会被过滤). */
      try { window.dispatchEvent(new CustomEvent('neox:cloud-sessions-refresh')); } catch { /* ignore */ }
    },
    [sessions, activeSession, workspace.path, setSessions, setActiveSession, setMessages, clearTimeline],
  );

  /* 空会话自动回收: 从空会话切走就删, 启动时再扫一遍 (判空和理由见 blankSessionSweep.ts) */
  useBlankSessionRecycler({
    activeSessionId: activeSession?.id ?? null,
    sessionsLoaded: !sessionsLoading,
    sessions,
    activeIdRef: activeSessionIdRef,
    deps: {
      getSession: async (id) => (await window.neox.getSession?.(id)) as any,
      memoryTimelineLength: (id) => timelineMapRef.current.get(id)?.length ?? 0,
      loadTimelineLength: async (id) => (await loadTimelineFromDB(id)).length,
      isBusy: (id) => streamingBySessionRef.current.get(id) === true,
    },
    remove: async (id) => {
      try {
        await window.neox.deleteSession(id);
      } catch (e) {
        /* 删除失败不能悄悄当成功 —— 会话还在, 用户会以为删了。 */
        dispatchOpFailedFromError('删除会话', e);
        throw e;
      }
      setSessions((prev) => prev.filter((x) => x.id !== id));
      await clearTimeline(id).catch(() => { /* SQLite 侧已删, 缓存清不掉下次启动也不会再列出来 */ });
    },
  });

  const exportSession = useCallback(
    async (id: string, format: 'md' | 'json' = 'md') => {
      try {
        const filePath = await window.neox.exportSession(id, format);
        if (!filePath) return; /* 用户在 save dialog 里点 cancel */
        const baseName = String(filePath).split('/').pop() ?? String(filePath);
        /* 用 hint event 派一个带 reveal action 的 toast — UI 层捕获后给用户"打开所在文件夹"按钮.
         *  没接 action 的旧 UI 至少能看见"已导出"提示. */
        dispatchHint(`已导出: ${baseName}`, 'success');
        try {
          window.dispatchEvent(new CustomEvent('neox:export-done', { detail: { filePath } }));
        } catch { /* ignore */ }
      } catch (err) {
        console.error('[NeoxRuntimeBridge] exportSession failed', err);
        dispatchOpFailedFromError('导出会话', err);
      }
    },
    [],
  );

  /* ---------- Attachments ---------- */
  const addAttachment = useCallback(
    (a: Attachment) => {
      setAttachments((prev) => {
        const idx = prev.findIndex((x) => x.id === a.id);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = a;
          return next;
        }
        if (prev.length >= 8) return prev;
        return [...prev, a];
      });
    },
    [setAttachments],
  );
  const removeAttachment = useCallback(
    (id: string) => setAttachments((prev) => prev.filter((x) => x.id !== id)),
    [setAttachments],
  );
  const clearAttachments = useCallback(() => setAttachments([]), [setAttachments]);

  const sendPrompt = useCallback(
    async (
      prompt: string,
      opts?: {
        isRetry?: boolean;
        /** 错误卡"继续": 从断点接着写, 不重来 (见函数体里 isContinue 的说明)。 */
        isContinue?: boolean;
        images?: Array<{ mediaType: string; data: string; name?: string }>;
      },
    ) => {
      const trimmed = prompt.trim();
      const isContinue = opts?.isContinue === true;
      /* isRetry = 错误卡"重试"触发的重跑这一轮 (复用原 user 消息, 不冒新气泡)。 */
      const isRetry = opts?.isRetry === true || isContinue;
      if (!trimmed && !isRetry) return;
      if (isRetry && !activeSession?.id) return;
      const targetSessionId = activeSession?.id ?? null;
      const stopping = targetSessionId ? pendingStopsRef.current.get(targetSessionId) : undefined;
      if (stopping) {
        try { await stopping; }
        catch (error) {
          dispatchOpFailedFromError('等待上一轮停止', error);
          if (!isRetry) window.dispatchEvent(new CustomEvent('neox:queued-message-rejected', {
            detail: { sessionId: targetSessionId, text: trimmed, images: opts?.images },
          }));
          return;
        }
      }
      if (targetSessionId !== activeSessionIdRef.current) {
        if (!isRetry) window.dispatchEvent(new CustomEvent('neox:queued-message-rejected', {
          detail: { sessionId: targetSessionId, text: trimmed, images: opts?.images },
        }));
        return;
      }
      const transport: 'cloud' | 'local' = activeIsCloud ? 'cloud' : 'local';
      const selectedIsCloud = isNeoxCloudProviderId(selectedModel?.providerId);
      const selectedUsesLocalProvider = !!selectedModel && !selectedIsCloud;
      const canUseByokWithoutLogin = selectedUsesLocalProvider && transport === 'local';

	      if (transport === 'cloud' && selectedUsesLocalProvider) {
	        dispatchOpFailed({
	          op: '云端运行',
	          message: bi('BYOK / 自动路由模型使用本机 API Key，只支持本地运行。云端运行请切换到 Neox Cloud 模型。', 'BYOK and auto-routed models use the API key on this machine, so they only run locally. Switch to a Neox Cloud model to run in the cloud.'),
	        });
	        return;
	      }

	      /* 对话权限闸 — 所有 chat 入口的根. 两种状态:
	       *   1. 已登录 → 直接放行
       *   2. 未登录 + BYOK 直连/自动路由 + 本地运行 → 放行, 不消耗订阅 quota
       *   3. 其他未登录场景 (订阅 cloud model / 云端运行 / 无模型)
	       *      → 明确提示配置 BYOK; Neox Cloud 登录/付费是可选路径。 */
	      if (!getEditionHook('isAuthenticated')() && !canUseByokWithoutLogin) {
	        dispatchOpFailed({
	          op: '发送消息',
	          message: getEditionHook('hasAccount')
            ? bi('请先在 API 服务商里配置 BYOK 模型并选择它后再发送；如果要使用 Neox Cloud 模型，请登录后再发送。', 'Configure a BYOK model under API providers and select it before sending. To use a Neox Cloud model, sign in first.')
            : bi('还没有可用的模型：去 设置 → 模型服务 添加你自己的 API Key，选好模型再发送。', 'No model yet: add your own API key in Settings → Model services, pick a model, then send.'),
	        });
	        return;
	      }

      /* 同一会话串行发送, 不阻塞后台运行中的其他会话。
       * IPC 未返回或流仍在运行时保留守卫; 正常完成或用户停止时释放。
       * 看门狗只收回 IPC 已返回但没有流的遗留守卫, 不打断慢请求。 */
      if (sendGuardsRef.current.get(targetSessionId)) {
        const engineRunning = !!targetSessionId && streamingBySessionRef.current.get(targetSessionId) === true;
        const waitUntil = Date.now() + (engineRunning ? 0 : 3000);
        while (sendGuardsRef.current.get(targetSessionId) && Date.now() < waitUntil) {
          await new Promise<void>((res) => window.setTimeout(res, 60));
        }
        if (sendGuardsRef.current.get(targetSessionId)) {
          if (isRetry) return;
          console.warn('[NeoxRuntimeBridge] 发送守卫未释放, 放弃本次发送 —— 把消息还回输入框', { engineRunning });
          dispatchOpFailed({
            op: '发送消息',
            message: engineRunning
              ? bi('Agent 还在运行这一轮，这条消息没有发出，已退回输入框。再按一次回车会排到本轮结束后发送。', 'The agent is still running this turn, so the message was not sent and is back in the input. Press Enter again to queue it after this turn.')
              : bi('上一轮还没收尾，这条消息没有发出，已退回输入框，请稍后再发。', 'The previous turn has not finished wrapping up. The message was not sent and is back in the input — try again in a moment.'),
          });
          /* 既有的"消息还回去"通道 (composer 监听它回填文字 + 附件)。绝不静默丢。 */
          try {
            window.dispatchEvent(new CustomEvent('neox:queued-message-rejected', {
              detail: { sessionId: targetSessionId, text: trimmed, images: opts?.images },
            }));
          } catch { /* ignore */ }
          return;
        }
      }
      if (targetSessionId !== activeSessionIdRef.current) {
        if (!isRetry) window.dispatchEvent(new CustomEvent('neox:queued-message-rejected', {
          detail: { sessionId: targetSessionId, text: trimmed, images: opts?.images },
        }));
        return;
      }
      const owner = sendGuardsRef.current.acquire(targetSessionId)!;
      const ownsSend = () => sendGuardsRef.current.owns(owner);
      markSendGuard('acquire', 'sendPrompt');
      /* 新一轮开始 —— 上一轮"用户停过"的标记作废, 否则这轮真出错会被误判成中断 */
      if (activeSession?.id) clearUserStopMark(activeSession.id);
      owner.timer = setTimeout(() => {
        owner.timer = undefined;
        if (!ownsSend() || owner.pending) return;
        if (owner.sessionId && streamingBySessionRef.current.get(owner.sessionId)) {
          /* 流已经在跑 = 守卫是被正当持有的, 不能碰。 */
          return;
        }
        console.warn('[NeoxRuntimeBridge] 发送 8s 内没有起流, 判定上游 hang, 释放发送守卫', {
          heldMs: Date.now() - sendGuardSinceRef.current,
          trace: sendGuardTraceRef.current.slice(-6),
        });
        markSendGuard('release', 'watchdog-no-stream-8s');
        sendGuardsRef.current.release(owner);
      }, 8000);
      const sidForDraft = activeSession?.id ?? null;
      const prevPromptHere = sidForDraft
        ? (lastPromptBySessionRef.current.get(sidForDraft) ?? '')
        : '';
      if (!isRetry && trimmed !== prevPromptHere) {
        cloudAutoRecoverCountRef.current = 0;
        if (sidForDraft) manualRetryCountBySessionRef.current.delete(sidForDraft); // 新内容 = fresh 重试额度
      }
      if (sidForDraft && !isRetry) lastPromptBySessionRef.current.set(sidForDraft, trimmed);
      setCanRetry(false);

      let session: Session | null = activeSession;
      if (!session) {
        session = await createNewSession();
        if (!session) {
          sendGuardsRef.current.release(owner);
          return;
        }
      }
      if (!ownsSend()) return;
      if (!sendGuardsRef.current.bind(owner, session.id)) {
        sendGuardsRef.current.release(owner);
        return;
      }
      /* 会话是刚建出来的 → 上面那步 sidForDraft 还是 null, 底稿没处落。补记一次,
       * 否则新会话的第一条消息在 lastPrompt 里是空的 (云端 pod 回收后重试就没话可发)。 */
      if (!sidForDraft) lastPromptBySessionRef.current.set(session.id, trimmed);

      if (!isRetry && isDefaultSessionName(session.name)) {
        const cleaned = trimmed
          .replace(/^<voice-turn>\s*/, '')
          .replace(/\s*<\/voice-turn>\s*$/, '')
          .replace(/^<[a-z-]+>\s*/, '')
          .replace(/\s+/g, ' ')
          .trim();
        const cjkCount = (cleaned.match(/[一-鿿぀-ヿ가-힯]/g) || []).length;
        const budget = cjkCount * 2 >= cleaned.length ? 20 : 44;
        let title = cleaned;
        if (cleaned.length > budget) {
          let cut = cleaned.slice(0, budget);
          if (budget > 20) {
            /* 只在切点附近找空格 —— 找太远会把标题砍得比预算短很多 */
            const sp = cut.lastIndexOf(' ');
            if (sp >= budget - 14) cut = cut.slice(0, sp);
          }
          title = cut.trimEnd() + '…';
        }
        if (title) void renameSession(session.id, title, { silent: true });
      }

      const assistantMsgId = createId('assistant');
      messageMapRef.current.set(session.id, assistantMsgId);

      stoppedSessionsRef.current.delete(session.id);
      dispatchStreamingPerSession(true, session.id);
      dispatchStatusPerSession('Thinking…', session.id);
      setTurnStartedAt(Date.now());
      setStreamingTokens(0);

      /* 立即把用户消息加入 messages + timeline (与旧 WorkspacePage 一致)
       * - messages 驱动 session.messages 持久化
       * - timeline 驱动 feed row 的即时渲染 (user_message 有 detail 才会被 mapTimeline 收录)
       */
      /* 重试复用原 user 消息 id → server 端 dedup 原地更新、renderer 不再追加 = 无重复气泡。 */
      const rememberedUserMsgId = lastUserMsgIdBySessionRef.current.get(session.id);
      const userMsgId = isRetry && rememberedUserMsgId ? rememberedUserMsgId : createId('user');
      if (!isRetry) lastUserMsgIdBySessionRef.current.set(session.id, userMsgId);
      const userTs = Date.now();
      /* 显式传进来的图片优先 —— 排队消息重发时 runtime 里的附件已被 composer 清掉,
       * 只有调用方手里还有 (见上面 opts.images 的说明)。 */
      const promptAttachments = isRetry ? [] : (opts?.images && opts.images.length > 0)
        ? opts.images.map((img, i) => ({
            id: `queued-img-${userTs}-${i}`,
            type: 'image' as const,
            name: img.name,
            mediaType: img.mediaType,
            data: img.data.startsWith('data:')
              ? img.data
              : `data:${img.mediaType || 'image/png'};base64,${img.data}`,
          })) as unknown as typeof attachments
        : attachments.slice();

      let userEntryId = `msg-${userMsgId}`;
      let userSequence: number | null = null;
      if (isRetry && !isContinue) {
        const beforeRetry = timelineMapRef.current.get(session.id) || [];
        const lastUserIdx = beforeRetry.map((e) => e.type).lastIndexOf('user_message');
        const staleAssistants = (lastUserIdx >= 0 ? beforeRetry.slice(lastUserIdx + 1) : [])
          .filter((e) => e.type === 'assistant_message' && !e.pending);
        for (const e of staleAssistants) {
          if (deleteTimelineEntry) void deleteTimelineEntry(session.id, e.id);
        }
        if (staleAssistants.length > 0) {
          const staleMsgIds = new Set(
            staleAssistants
              .map((e) => (e as { messageId?: string }).messageId || String(e.id).replace(/^msg-/, ''))
              .filter(Boolean),
          );
          setMessages((prev: ChatMessage[]) => prev.filter((m) => !(m.role === 'assistant' && staleMsgIds.has(m.id))));
        }
      }
      if (isRetry) {
        const existingEntries = timelineMapRef.current.get(session.id) || [];
        const maxSequence = existingEntries.reduce((acc: number | null, e: TimelineEntry) => {
          const seq = typeof (e as { sequence?: number }).sequence === 'number'
            ? (e as { sequence?: number }).sequence!
            : null;
          if (seq == null) return acc;
          return acc == null || seq > acc ? seq : acc;
        }, null as number | null);
        userSequence = maxSequence;
      } else {
        setMessages((prev: ChatMessage[]) => [
          ...prev,
          {
            id: userMsgId,
            role: 'user',
            text: trimmed,
            pending: false,
            timestamp: userTs,
          } as ChatMessage,
        ]);

        const userTimelineEntry = appendTimelineEntry(
          session.id,
          {
            id: `msg-${userMsgId}`,
            type: 'user_message' as const,
            title: 'User',
            detail: trimmed,
            timestamp: userTs,
            pending: false,
            messageId: userMsgId,
            attachments: promptAttachments.length > 0 ? promptAttachments : undefined,
          },
          true,
        );
        userEntryId = userTimelineEntry.id;
        userSequence = typeof userTimelineEntry.sequence === 'number' ? userTimelineEntry.sequence : null;
      }

      try {
        /* cloud routing — 跟 composer RunDestinationPicker 的 "本地/云端" 显示同源
         * (activeIsCloud 来自 NeoxShellHost 广播的 cloud-state event). 用户看到 picker
         * 显啥, sendPrompt 就发啥. main 进程纯听 flag, 不独立判. */
        /* 新一轮发言 = 解除"停止朗读"的本轮静音 (muted 语义只管到下一轮) */
        try { getTtsPlayer().setMuted(false); } catch { /* noop */ }
        let outgoingPrompt = isRetry ? '' : trimmed;
        if (!isRetry && await isPiiFilterOn()) {
          const { output, redactions } = sanitizePrompt(trimmed);
          if (redactions.length > 0) {
            outgoingPrompt = output;
            dispatchHint(
              `已按「发送前抹掉密码和密钥」抹掉 ${redactions.length} 处凭据再发送（${redactions.join('、')}）。要原样发送可在 设置 → Agent 权限 → 发出去的内容 里关掉。`,
              'warning',
            );
          }
        }
        if (!ownsSend()) {
          // Stopped before IPC submission: return the unsent draft, not a retry.
          if (!isRetry) {
            if (userEntryId && deleteTimelineEntry) void deleteTimelineEntry(session.id, userEntryId);
            if (activeSessionIdRef.current === session.id) {
              setMessages(previous => previous.filter(message => message.id !== userMsgId));
            }
            window.dispatchEvent(new CustomEvent('neox:queued-message-rejected', {
              detail: { sessionId: session.id, text: trimmed, images: opts?.images },
            }));
          }
          return;
        }
        pinChatMode(session.id, session.chatMode ?? null);
        const chatModeOn = isChatMode(session.id, session.chatMode ?? null);
        const response = await window.neox.sendMessage({
          prompt: outgoingPrompt,
          workspacePath: (session as { workspacePath?: string }).workspacePath || workspace.path,
          /* 多根工作区: 带上本工作区全部根 → server 让 agent 在 env 段感知其它项目根。
           *   单根时为 undefined, server 自动忽略 (零影响)。 */
          workspaceRoots: workspace.roots,
          sessionId: session.id,
          modelId: selectedModel?.id ?? '',
          agentMode: session.agentMode ?? undefined,
          /* 聊天模式 (+ 菜单切): 精简 prompt、只带搜索和画图。显式带 true/false —— 运行时靠它区分「刚切到 Agent」和「不报这个字段」。 */
          chatMode: chatModeOn,
          stream: true,     /* 开启流式 — useStreamHandler 会接收 delta 并写 timeline */
          metadata: {
            mode,
            attachments: promptAttachments.length > 0 ? promptAttachments : undefined,
            thinkingMode: selectedModel?.supportsThinking ? thinkingMode : undefined,
            isAutoRouted: selectedModel?.isAutoRouted === true,
            routeConfig: selectedModel?.routeConfig,
            effortLevel: effortLevel !== 'standard' ? effortLevel : undefined,
          },
          /* M1 单源化 — userMessageId + userMessageSource 透传到 server, server publish
           * user_message bus event 时带相同 id, useStreamHandler 处理时按 messageId dedup,
           * self-push 已存在则原地更新, mobile 那边新建一条 (它没 self-push 过). */
          userMessageId: userMsgId,
          userMessageSource: 'desktop',
          isRetry: isRetry || undefined,
          isContinue: isContinue || undefined,
          /* renderer → main routing 信号 — main 据此走 cloud-relay consumer 而不是本机 agent. */
          transport,
        } as any);
        owner.pending = false;
        if (!ownsSend()) return;
        if (activeSessionIdRef.current !== session.id) {
          if (streamingBySessionRef.current.get(session.id) !== true) sendGuardsRef.current.release(owner);
          return;
        }
        /* 发送成功后清附件 (保留到 API 确认上去再清, 避免失败丢失) */
        if (promptAttachments.length > 0 && !opts?.images) {
          const sentIds = new Set(promptAttachments.map(attachment => attachment.id));
          setAttachments(previous => previous.filter(attachment => !sentIds.has(attachment.id)));
        }

        const assistantFinalText = typeof response.finalText === 'string' ? response.finalText : '';
        const hasAssistantFinalText = assistantFinalText.trim().length > 0;
        const responseSummary = {
          hasFinalText: hasAssistantFinalText,
          finalTextLength: assistantFinalText.length,
          tokens: response.tokens ?? null,
          finishedAt: response.finishedAt ?? null,
          contextUsed: response.contextUsed ?? null,
        };

        setMessages((prev: ChatMessage[]) => {
          const exists = prev.find((m) => m.id === assistantMsgId);
          if (!exists) {
            if (!hasAssistantFinalText) return prev;
            return [
              ...prev,
              {
                id: assistantMsgId,
                role: 'assistant',
                text: assistantFinalText,
                pending: false,
                tokens: response.tokens,
                timestamp: response.finishedAt || Date.now(),
              } as ChatMessage,
            ];
          }
          let changed = false;
          const next = prev.flatMap((m) => {
            if (m.id !== assistantMsgId) return [m];
            const text = m.text || assistantFinalText;
            if (!text.trim() && !hasAssistantFinalText) {
              changed = true;
              return [];
            }
            changed = true;
            return [{
              ...m,
              text,
              pending: false,
              tokens: response.tokens,
              timestamp: response.finishedAt || Date.now(),
            }];
          });
          return changed ? next : prev;
        });

        /* 兜底: 若 useStreamHandler 没收到 stream 事件 (非流式模型 / 流失败),
         * 手动把 assistant 结果写到 timeline, 保证 UI 一定能看到回复.
         * 使用相同的 entryId `msg-${assistantMsgId}` —— 若 stream 路径已经 append 过,
         * 这里只是更新; 否则就是新建. */
        const assistantTs = response.finishedAt || Date.now();
        const assistantEntryId = `msg-${assistantMsgId}`;
        const existingList = timelineMapRef.current.get(session.id) ?? [];
        const existingAssistant = existingList.find((e) => e.id === assistantEntryId);
        if (existingAssistant) {
          const existingText = [existingAssistant.detail, existingAssistant.content]
            .filter((value): value is string => typeof value === 'string' && value.length > 0)
            .join('')
            .trim();
          if (hasAssistantFinalText || existingText) {
            updateTimelineEntryById(
              session.id,
              assistantEntryId,
              (entry) => ({
                ...entry,
                detail: hasAssistantFinalText ? assistantFinalText : (entry.detail || ''),
                pending: false,
                timestamp: assistantTs,
              }),
              true,
            );
          } else if (deleteTimelineEntry) {
            void deleteTimelineEntry(session.id, assistantEntryId);
          } else {
            updateTimelineEntryById(
              session.id,
              assistantEntryId,
              (entry) => ({ ...entry, pending: false, hidden: true } as any),
              true,
            );
          }
        } else if (hasAssistantFinalText) {
          appendTimelineEntry(
            session.id,
            {
              id: assistantEntryId,
              type: 'assistant_message' as const,
              title: 'Assistant',
              detail: assistantFinalText,
              timestamp: assistantTs,
              pending: false,
              messageId: assistantMsgId,
            },
            true,
          );
        }

        setTotalTokens((prev) => prev + (response.tokens || 0));
        if (response.contextUsed && response.contextUsed > 0) {
          setContextUsed(response.contextUsed);
        }
        if (!(response as any).accepted) setStatus('Ready');
        if (streamingBySessionRef.current.get(session.id) !== true && ownsSend()) {
          markSendGuard('release', 'sendMessage-resolved');
          sendGuardsRef.current.release(owner);
        }
        scheduleSilentTurnAudit({
          sessionId: session.id,
          userEntryId,
          userMsgId,
          assistantMsgId,
          userSequence,
          userTs,
          promptPreview: trimmed.slice(0, 240),
          transport,
          modelId: selectedModel?.id,
          reason: 'sendMessage-resolved',
          responseSummary,
        });
      } catch (err: any) {
        owner.pending = false;
        if (!ownsSend()) return;
        if (activeSessionIdRef.current !== session.id) {
          dispatchStreamingPerSession(false, session.id);
          sendGuardsRef.current.release(owner);
          return;
        }
        console.error('[NeoxRuntimeBridge] sendMessage error', err);
        setStatus('Error');
        setCanRetry(true);
        /* 抽 error 三字段: code / message / suggestion */
        const message =
          (err?.message && String(err.message)) ||
          (typeof err === 'string' ? err : '') ||
          '请求失败';
        const code =
          err?.code ||
          err?.errorCode ||
          (err?.status ? String(err.status) : undefined);
        /* cloud session 失败码 — main 把 code 编进 message: "[CLOUD_FAIL:<CODE>] ...".
         *  Electron IPC 会把 throw 包成 "Error invoking remote method 'chat:send': Error: <orig>",
         *  所以这里不能 anchor 到字符串开头, 全文 scan. */
        const cloudFailMatch = String(message).match(/\[CLOUD_FAIL:([A-Z_]+)\]\s*(.*)/);
        const cloudFailCode = cloudFailMatch?.[1] ?? null;
        const cleanMessage = cloudFailMatch?.[2] ?? message;
        /* cloud 错误码翻译表 — 给用户中文提示 + 推荐 action.
         * 比"[CLOUD_FAIL:TERMINATED] 云端 session 已 terminate" 这种 raw 字符串清楚很多. */
        const cloudFailTranslate: Record<string, { message: string; suggestion: string }> = {
          TERMINATED: { message: bi('云端 session 已结束', 'Cloud session has ended'), suggestion: bi('点重试自动新建并继续, 或新建会话', 'Retry to start a fresh one and carry on, or open a new session') },
          NOT_FOUND: { message: bi('云端找不到这条 session', 'Cloud can’t find this session'), suggestion: bi('可能已被清理, 重试会自动新建', 'It may have been cleaned up — retry creates a new one') },
          FORBIDDEN: { message: bi('无权访问这条云端 session', 'No access to this cloud session'), suggestion: bi('检查是否登错账号', 'Check whether you’re signed in with the right account') },
          AUTH_EXPIRED: { message: bi('登录已过期', 'Your sign-in expired'), suggestion: bi('请在设置里重新登录 NeoxCloud', 'Sign in to Neox Cloud again under Settings') },
          POD_BUSY: { message: bi('云端 agent pod 暂不足', 'No cloud agent capacity right now'), suggestion: bi('稍后重试; 高峰时段可能等待', 'Try again shortly — peak hours can mean a wait') },
          NO_JWT: { message: bi('未登录 NeoxCloud', 'Not signed in to Neox Cloud'), suggestion: bi('在设置里登录', 'Sign in under Settings') },
          NETWORK: { message: bi('云端网络异常', 'Network problem reaching the cloud'), suggestion: bi('检查网络后重试', 'Check your connection, then retry') },
          UNKNOWN: { message: bi('云端调用失败', 'Cloud request failed'), suggestion: bi('稍后重试; 持续报错请反馈', 'Try again later; if it keeps happening, send us a report') },
        };
        const providerFailTranslate: Record<string, { message: string; suggestion: string }> = {
          /* ── 网络/流 ── */
          STREAM_INCOMPLETE: { message: bi('响应流被中断', 'Response stream was cut off'), suggestion: bi('多为网络抖动或代理断连 · 点重试通常就好; 反复出现看下 VPN/代理', 'Usually a network blip or a dropped proxy — Retry normally fixes it; if it keeps happening, check your VPN/proxy') },
          STREAM_ERROR: { message: bi('响应流出错', 'Response stream errored'), suggestion: bi('点重试; 持续失败换个模型或检查网络', 'Hit Retry; if it keeps failing, switch model or check your network') },
          STREAM_TIMEOUT: { message: bi('上游响应超时', 'Upstream response timed out'), suggestion: bi('供应商这会儿慢 · 稍候重试, 或临时换一个模型', 'This provider is slow right now — retry shortly, or switch model for a bit') },
          STREAM_IDLE_TIMEOUT: { message: bi('上游长时间没有新内容', 'Upstream went quiet for a long time'), suggestion: bi('多半是上游卡住了 · 点重试; 长任务可先拆小', 'The upstream most likely stalled — hit Retry; consider splitting long tasks up') },
          CONNECT_TIMEOUT: { message: bi('连不上供应商', 'Can’t reach the provider'), suggestion: bi('检查网络/代理是否可达该供应商域名', 'Check that your network/proxy can reach that provider’s domain') },
          TIMEOUT: { message: bi('请求超时', 'Request timed out'), suggestion: bi('点重试; 网络慢时可换更轻的模型', 'Hit Retry; on a slow connection a lighter model helps') },
          EMPTY_STREAM: { message: bi('上游返回了空响应', 'Upstream returned an empty response'), suggestion: bi('常见于上游限流或模型不可用 · 换个模型试试', 'Common when the upstream is rate-limiting or the model is unavailable — try another model') },
          PROXY_UPSTREAM_FAILED: { message: bi('代理的上游失败了', 'The proxy’s upstream failed'), suggestion: bi('不是你的配置问题 · 稍候重试; 持续失败换供应商', 'Not your configuration — retry shortly; if it persists, switch provider') },
          /* ── 鉴权/额度 ── */
          UNAUTHORIZED: { message: bi('API key 无效或已过期', 'API key is invalid or expired'), suggestion: bi('去设置里检查这个供应商的 key', 'Check this provider’s key under Settings') },
          MODEL_NOT_SUPPORTED: { message: bi('这个模型在当前供应商上用不了', 'That model isn’t available on this provider'), suggestion: bi('换一个模型; 同一家网关里不同模型支持的接口格式可能不一样', 'Pick another model — models on the same gateway often support different API formats') },
          FORBIDDEN: { message: bi('这个 key 没有权限用该模型', 'This key isn’t allowed to use that model'), suggestion: bi('换个模型, 或在供应商后台开通该模型权限', 'Switch model, or enable that model in the provider’s console') },
          QUOTA_EXCEEDED: { message: bi('供应商额度用完了', 'Provider quota exhausted'), suggestion: bi('去供应商后台充值/提额, 或换一个供应商', 'Top up or raise the limit in the provider’s console, or switch provider') },
          INSUFFICIENT_BALANCE: { message: bi('供应商账户余额不足', 'Provider account is out of balance'), suggestion: bi('去供应商后台充值后重试', 'Top up in the provider’s console, then retry') },
          USAGE_LIMIT_REACHED: { message: bi('已达用量上限', 'Usage limit reached'), suggestion: bi('等额度重置, 或换一个供应商', 'Wait for the quota to reset, or switch provider') },
          /* ── 请求本身 ── */
          CONTEXT_WINDOW_EXCEEDED: { message: bi('上下文超出模型窗口', 'Context exceeds the model’s window'), suggestion: bi('开新会话继续, 或换一个窗口更大的模型', 'Start a new session, or switch to a model with a larger window') },
          INVALID_REQUEST: { message: bi('供应商拒绝了这个请求', 'The provider rejected this request'), suggestion: bi('常见于参数/模型名不被支持 · 换个模型试试', 'Usually an unsupported parameter or model name — try another model') },
          /* ── 工具参数被截断 (流没传完) ── */
          TOOL_ARGS_TRUNCATED: { message: bi('工具参数在传输中被截断', 'Tool arguments were truncated in transit'), suggestion: bi('点重试即可 · 反复出现说明上游不稳, 换个模型', 'Just hit Retry — if it repeats, the upstream is flaky; switch model') },
          TOOL_MISSING_CONTENT: { message: bi('工具参数不完整 (content 缺失)', 'Tool arguments incomplete (content missing)'), suggestion: bi('同上, 点重试', 'Same as above — hit Retry') },
          TOOL_MISSING_EDIT_PAYLOAD: { message: bi('编辑内容不完整', 'Edit payload is incomplete'), suggestion: bi('点重试; 一直不行就把改动拆小一点', 'Hit Retry; if it keeps failing, break the change into smaller pieces') },
          JSON_PARSE_ERROR: { message: bi('工具参数不是合法 JSON', 'Tool arguments aren’t valid JSON'), suggestion: bi('多为流被截断 · 点重试', 'Usually a truncated stream — hit Retry') },
        };

        const provFail = !cloudFailCode && code ? providerFailTranslate[String(code)] : undefined;
        const suggestion = (() => {
          if (cloudFailCode && cloudFailTranslate[cloudFailCode]) return cloudFailTranslate[cloudFailCode].suggestion;
          /* 上游/SDK 自己带了建议就用它的 (更贴近具体原因), 否则用我们的翻译表 */
          return err?.suggestion
            || err?.errorSuggestion
            || provFail?.suggestion
            || (code === '429'
              ? bi('被限流了 · 等几秒再重试; 高频调用可换一个供应商', 'Rate limited — wait a few seconds and retry; for heavy use, switch provider')
              : undefined)
            || (/^5\d\d$/.test(String(code ?? ''))
              ? bi('供应商服务端出错 · 不是你的问题, 稍候重试', 'The provider’s server errored — not your fault; retry shortly')
              : undefined);
        })();
        const translatedMessage = cloudFailCode && cloudFailTranslate[cloudFailCode]
          ? cloudFailTranslate[cloudFailCode].message
          /* 供应商错误: 用人话替掉技术原文, 但**保留原文到 rawMessage** 供排查 (title 里仍能看到) */
          : (provFail?.message ?? cleanMessage);
        const trimmedMessage = String(translatedMessage).split('\n')[0]!.slice(0, 200);
        /* raw 保留技术原文 —— message 已被翻译成人话, 但排查时还得看得到上游到底说了什么。
           行内只显示人话 + 建议, 原文放 tooltip。 */
        const rawDetail = String(cleanMessage).split('\n')[0]!.slice(0, 300);
        setLastError({
          code: cloudFailCode ?? code,
          message: trimmedMessage,
          suggestion,
          raw: rawDetail !== trimmedMessage ? rawDetail : undefined,
        });
        /* BYOK key 失效 / 没额度: 它别再当新任务的默认模型 (见 pickDefaultAfterDeadKey) */
        if (!cloudFailCode) {
          const nextDefault = pickDefaultAfterDeadKey({
            code: code != null ? String(code) : undefined,
            failedModelId: modelBySessionRef.current.get(session.id) ?? selectedModel?.id,
            lastModelId: readLastModelId(),
            subscription: computeNeoxCloudModels(),
          });
          if (nextDefault) writeLastModelId(nextDefault.id);
        }

        /* TERMINATED / NOT_FOUND → 自动恢复: server 端用同 session_id 复活 (删 terminated 旧 row + 重建),
         *  UI active session 不变, 历史消息全部保留, 用户体感"原会话继续".
         *  上限 2 次 — pod 反复回收时不能无限自动重试, 第 3 次直接转成"手动重试"状态. */
        const MAX_AUTO_RECOVER = 2;
        if ((cloudFailCode === 'TERMINATED' || cloudFailCode === 'NOT_FOUND') && activeIsCloud && activeSession?.id) {
          if (cloudAutoRecoverCountRef.current >= MAX_AUTO_RECOVER) {
            /* 达到上限 — 停止 auto-recover, 展示错误条 + 重试按钮让用户决定. */
            cloudAutoRecoverCountRef.current = 0;
            /* per-session 收口: 裸 setStreaming 只动全局, map 里残留 true, 切走再切回转圈复活 */
            dispatchStreamingPerSession(false, session.id);
            markSendGuard('release', 'cloud-recover-exhausted');
            sendGuardsRef.current.release(owner);
            setCanRetry(true);
            scheduleSilentTurnAudit({
              sessionId: session.id,
              userEntryId,
              userMsgId,
              assistantMsgId,
              userSequence,
              userTs,
              promptPreview: trimmed.slice(0, 240),
              transport,
              modelId: selectedModel?.id,
              reason: 'cloud-auto-recover-exhausted',
              responseSummary: {
                code: cloudFailCode,
                message: 'cloud auto recover exhausted',
                attempts: MAX_AUTO_RECOVER,
              },
            });
            dispatchOpFailed({
              op: '云端会话恢复',
              message: bi(`云端 pod 反复回收 (已重试 ${MAX_AUTO_RECOVER} 次), 请手动重试或新建会话`, `The cloud pod keeps getting recycled (retried ${MAX_AUTO_RECOVER}×) — retry manually or start a new session`),
            });
            return;
          }
          cloudAutoRecoverCountRef.current += 1;
          cloudRecoverAbortedRef.current = false;
          dispatchStreamingPerSession(false, session.id);
          markSendGuard('release', 'cloud-auto-recover');
          sendGuardsRef.current.release(owner);
          const reuseSid = activeSession.id;
          const recoverAttempt = cloudAutoRecoverCountRef.current;
          void (async () => {
            try {
              const api = (window as any).neox?.cloudSession;
              if (!api?.create) {
                dispatchOpFailed({ op: bi('云端会话恢复', 'Cloud session recovery'), message: bi('当前 desktop 不支持云端会话', 'This desktop build doesn’t support cloud sessions') });
                return;
              }
              const modelId = selectedModel?.id ?? (activeSession as any)?.modelId;
              if (!modelId) {
                dispatchOpFailed({ op: bi('云端会话恢复', 'Cloud session recovery'), message: bi('未选 model — 先在设置里挑一个', 'No model selected — pick one in Settings first') });
                return;
              }
              dispatchHint(`云端连接断了，正在重新连接…（第 ${recoverAttempt}/${MAX_AUTO_RECOVER} 次）`, 'info');
              /* 关键: sessionId 传同一个 — server 端 createCloudSession 看到 terminated 旧 row
               * 会删后用同 id 重建, 返回的 sessionId 不变, 不需要 selectSession 切换. */
              await api.create({ modelId, sessionId: reuseSid });
              if (!ownsSend() || cloudRecoverAbortedRef.current || activeSessionIdRef.current !== reuseSid) return;
              try { window.dispatchEvent(new CustomEvent('neox:cloud-sessions-refresh')); } catch { /* ignore */ }
              /* 同 sessionId 重建完成 → 直接 retry (这个会话的底稿还在, 见 lastPromptBySessionRef).
               *  setTimeout 用 timerId ref 记着, stop 时硬 clearTimeout (双保险: aborted ref + clear). */
              if (cloudRecoverTimerRef.current != null) {
                clearTimeout(cloudRecoverTimerRef.current);
              }
              cloudRecoverTimerRef.current = window.setTimeout(() => {
                cloudRecoverTimerRef.current = null;
                if (!ownsSend() || cloudRecoverAbortedRef.current || activeSessionIdRef.current !== reuseSid) return;
                try { window.dispatchEvent(new CustomEvent('neox:retry-last-prompt', { detail: { from: 'cloud-recover' } })); } catch { /* ignore */ }
              }, 400);
            } catch (e: any) {
              dispatchOpFailed({ op: '云端会话恢复', message: e?.message ?? '新建失败' });
            }
          })();
          return;
        }
        scheduleSilentTurnAudit({
          sessionId: session.id,
          userEntryId,
          userMsgId,
          assistantMsgId,
          userSequence,
          userTs,
          promptPreview: trimmed.slice(0, 240),
          transport,
          modelId: selectedModel?.id,
          reason: 'sendMessage-error',
          responseSummary: {
            code: cloudFailCode ?? code ?? null,
            message: trimmedMessage,
            suggestion: suggestion ?? null,
          },
        });
        if (code !== '402' && String(code ?? '').indexOf('quota') < 0) {
          dispatchOpFailed({
            op: '发送消息',
            message: suggestion ? `${trimmedMessage} · ${suggestion}` : trimmedMessage,
            code: code ? String(code) : undefined,
          });
        }
        /* 仅错误路径立即结束 streaming — 否则 stream 事件的最终完成信号永远不会来。
         * per-session 版: 裸 setStreaming 不写 map, 切走再切回会从 map 读回 true 复活转圈。 */
        dispatchStreamingPerSession(false, session.id);
        markSendGuard('release', 'send-error');
        sendGuardsRef.current.release(owner);
      } finally {
        /* 注意: 不在此处 setStreaming(false).
         * 因为 window.neox.sendMessage() 可能在流结束前就 resolve (后端通过 onStream 独立通道推送).
         * streaming 的真正关闭由 useStreamHandler.settleStatusToReadyIfIdle 驱动
         * (它收到 stream 的 responseCompleted 事件). sendingRef 同理靠下面 useEffect 释放. */

        /* 发送完成后刷新 sessions 列表 (拿到最新 updatedAt).
         * 全量刷新 — 让 Sidebar 跨 workspace 分组保持准确. */
        /* 只是为了让 sidebar 那一行的 updatedAt 变新 —— 走节流器,
           跟同期到达的子 Agent 事件合并成一次。 */
        scheduleSessionsRefresh();
      }
    },
    [
      activeSession,
      createNewSession,
      renameSession,
      selectedModel,
      attachments,
      clearAttachments,
      setAttachments,
      setStreaming,
      dispatchStreamingPerSession,
      setStatus,
      setMessages,
      setTotalTokens,
      setContextUsed,
      setSessions,
      workspace.path,
      appendTimelineEntry,
      scheduleSilentTurnAudit,
      mode,
      thinkingMode,
      effortLevel,
      activeIsCloud,
      deleteTimelineEntry,
      timelineMapRef,
    ],
  );

  /* 用户主动停止时, 清理残留的 "重试中" timeline entry.
   * 避免停止后卡片还显示 "运行中" 转圈. */
  const cleanupPendingRetries = useCallback((sessionId: string) => {
    const timeline = timelineMapRef.current.get(sessionId) || [];
    const pendingRetry = timeline.find(
      (e: TimelineEntry) => e.type === 'log' && e.level === 'warning' &&
        e.pending && e.reconnectAttempt !== undefined
    );
    if (pendingRetry) {
      updateTimelineEntryById(sessionId, pendingRetry.id, (prev) => ({
        ...prev,
        pending: false,
        level: 'info',
        title: bi('已停止', 'Stopped'),
      } as any), true);
    }
  }, [timelineMapRef, updateTimelineEntryById]);

  const sweepInterruptedEntries = useCallback((sessionId: string) => {
    const timeline = timelineMapRef.current.get(sessionId) || [];
    for (const entry of timeline) {
      const e = entry as any;
      if (e.commandStatus === 'running') {
        updateTimelineEntryById(sessionId, entry.id, (prev) => ({
          ...prev, pending: false, commandStatus: 'error',
          errorReason: 'interrupted', interrupted: true,
        } as any));
        continue;
      }
      if (!entry.pending && !e.editStreaming) continue;
      if (entry.type === 'tool_call') {
        updateTimelineEntryById(sessionId, entry.id, (prev) => ({
          ...prev, type: 'tool_error' as any, pending: false, success: false, level: 'error',
          errorReason: 'interrupted', interrupted: true, errorMessage: bi('你点了停止', 'You pressed Stop'),
        } as any));
      } else if (entry.type === 'edit_file') {
        updateTimelineEntryById(sessionId, entry.id, (prev) => ({
          ...prev, pending: false, editStreaming: false, editIsComplete: true,
          errorReason: 'interrupted', interrupted: true,
          errorMessage: (prev as any).errorMessage || '你点了停止',
        } as any));
      } else if (entry.type === 'explore_status' || entry.type === 'agent_delegation') {
        updateTimelineEntryById(sessionId, entry.id, (prev) => ({
          ...prev, pending: false, exploreStatus: 'failed', delegationStatus: 'error',
          errorReason: 'interrupted', interrupted: true,
        } as any));
      } else if (entry.type === 'ask_user') {
        updateTimelineEntryById(sessionId, entry.id, (prev) => ({
          ...prev, pending: false,
          askUserStatus: (prev as any).askUserStatus === 'waiting' ? 'timeout' : (prev as any).askUserStatus,
          errorReason: 'interrupted', interrupted: true,
        } as any));
      } else {
        updateTimelineEntryById(sessionId, entry.id, (prev) => ({
          ...prev, pending: false, errorReason: 'interrupted', interrupted: true,
        } as any));
      }
    }
  }, [timelineMapRef, updateTimelineEntryById]);

  const interruptCurrent = useCallback(async () => {
    if (!activeSession) return;
    const sid = activeSession.id;
    /* 用户点停止 → 同时打断云端 auto-recover loop: 置 aborted, 清计数器, clearTimeout 硬中断
     *  in-flight retry; sendingTimeout 也清掉避免它后续误清 sending state. */
    cloudRecoverAbortedRef.current = true;
    cloudAutoRecoverCountRef.current = 0;
    if (cloudRecoverTimerRef.current != null) {
      clearTimeout(cloudRecoverTimerRef.current);
      cloudRecoverTimerRef.current = null;
    }
    markSendGuard('release', 'interrupt');
    const stopping = stopRuntimeSession(sid,
      !!(activeSession as { parentSessionId?: string }).parentSessionId || runningSubAgentIdsRef.current.has(sid));
    markUserStopped(sid);
    requestStreamFreeze(sid);
    stoppedSessionsRef.current.add(sid);
    streamingBySessionRef.current.set(sid, false);
    syncRunningSessionIds(sid, false);
    setPaused(false);
    setStreaming(false);
    setStatus('Stopped');
    cleanupPendingRetries(sid);
    sweepInterruptedEntries(sid);
    try {
      await stopping;
    } catch (err) {
      console.error('[NeoxRuntimeBridge] interruptSession failed', err);
      dispatchOpFailedFromError('停止会话', err);
    }
  }, [activeSession, setStreaming, setStatus, setPaused, syncRunningSessionIds, cleanupPendingRetries, sweepInterruptedEntries, stopRuntimeSession]);

  const retryLast = useCallback(async () => {
    const sidForPrompt = activeSession?.id;
    const tlForPrompt = sidForPrompt ? (timelineMapRef.current.get(sidForPrompt) ?? []) : [];
    const lastUser = [...tlForPrompt].reverse().find((e) => e.type === 'user_message');
    const promptFromTimeline = typeof lastUser?.detail === 'string' ? lastUser.detail.trim() : '';
    /* 底稿兜底也必须是**这个会话**的 —— 拿进程里最后发的那条, 正是"在会话 B 点重试
     * 把会话 A 的话发出去"这个 bug 本身 (上面这段注释早就写明了, 只是当时没改数据结构)。 */
    const draftHere = sidForPrompt ? (lastPromptBySessionRef.current.get(sidForPrompt) ?? '') : '';
    const prompt = promptFromTimeline || draftHere;
    if (!prompt) return;
    /* 上限 5 次: 到顶不再重试, 引导切 provider (上游持续 5xx 再重试也是白试)。
     * 计数按会话算 —— 共用一个的话, 会话 A 重试 3 次会吃掉会话 B 的额度。 */
    const retriedHere = sidForPrompt ? (manualRetryCountBySessionRef.current.get(sidForPrompt) ?? 0) : 0;
    if (retriedHere >= MAX_MANUAL_RETRY) {
      setCanRetry(false);
      dispatchHint(`已重试 ${MAX_MANUAL_RETRY} 次仍失败，建议在模型选择器里切换到其它 provider 再试。`, 'warning');
      return;
    }
    if (sidForPrompt) manualRetryCountBySessionRef.current.set(sidForPrompt, retriedHere + 1);
    setCanRetry(false);
    setLastError(null);

    const sid = activeSession?.id;
    if (sid) {
      const tl = timelineMapRef.current.get(sid) ?? [];
      const anchorIdx = tl.map((e) => e.type).lastIndexOf('user_message');
      const inTurn = anchorIdx >= 0 ? tl.slice(anchorIdx + 1) : tl;

      const oldRunAlive = streamingBySessionRef.current.get(sid) === true
        || inTurn.some((e) => e.pending === true
          || (e.type === 'ask_user' && (e as { askUserStatus?: string }).askUserStatus === 'waiting'));
      if (oldRunAlive) {
        cleanupPendingRetries(sid);
        sweepInterruptedEntries(sid);
        try {
          const isChild = !!(activeSession as { parentSessionId?: string } | null)?.parentSessionId
            || runningSubAgentIdsRef.current.has(sid);
          await stopRuntimeSession(sid, isChild);
        } catch (err) {
          console.error('[NeoxRuntimeBridge] retryLast: interrupt previous run failed', err);
          dispatchOpFailedFromError('停止上一轮后重试', err);
          return;
        }
      }

      for (const e of inTurn) {
        if (e.type !== 'runner_error') continue;
        if (deleteTimelineEntry) void deleteTimelineEntry(sid, e.id);
        else updateTimelineEntryById(sid, e.id, (prev) => ({ ...prev, hidden: true } as any), true);
      }
    }

    /* isRetry: 重跑这一轮 (复用原 user 消息), 不是发新会话。 */
    await sendPrompt('', { isRetry: true });
  }, [sendPrompt, activeSession, timelineMapRef, deleteTimelineEntry, updateTimelineEntryById,
    cleanupPendingRetries, sweepInterruptedEntries, stopRuntimeSession]);

  const continueLast = useStableCallback(async () => {
    const sid = activeSession?.id;
    if (!sid) return;
    const tl = timelineMapRef.current.get(sid) ?? [];
    if (!tl.some((e) => e.type === 'user_message')) return;
    if (sendGuardsRef.current.get(sid) || streamingBySessionRef.current.get(sid) === true) return;

    /* 错误卡收走: 这一轮要接着跑了, 上一张终态卡留着就是噪音 (跟重试同款处理) */
    const anchorIdx = tl.map((e) => e.type).lastIndexOf('user_message');
    const inTurn = anchorIdx >= 0 ? tl.slice(anchorIdx + 1) : tl;
    for (const e of inTurn) {
      if (e.type !== 'runner_error') continue;
      if (deleteTimelineEntry) void deleteTimelineEntry(sid, e.id);
      else updateTimelineEntryById(sid, e.id, (prev) => ({ ...prev, hidden: true } as any), true);
    }

    await sendPrompt('', { isContinue: true });
  });

  useEffect(() => {
    const handler = () => { void continueLast(); };
    window.addEventListener('neox:continue-last-prompt', handler);
    return () => window.removeEventListener('neox:continue-last-prompt', handler);
  }, [continueLast]);

  /* 错误卡片上"重试"按钮派的事件 — TimelineStep ErrorView 派, 这里全局监听.
   *  detail.from === 'cloud-recover' 是 sendPrompt 内部 auto-recover 触发的 (保留计数器);
   *  其它情况一律视为用户手动触发, 清零计数器给用户 fresh retry 额度. */
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent | undefined)?.detail;
      if (detail?.from !== 'cloud-recover') {
        cloudAutoRecoverCountRef.current = 0;
      }
      void retryLast();
    };
    window.addEventListener('neox:retry-last-prompt', handler);
    return () => window.removeEventListener('neox:retry-last-prompt', handler);
  }, [retryLast]);

  const rewindToUserMessage = useCallback(async (sid: string, entryId: string, what: string): Promise<boolean> => {
    const entries = timelineMapRef.current.get(sid) ?? [];
    const k = userMessageIndexFromEnd(entries, entryId);
    if (k < 1) { dispatchHint(`这条消息已经不在当前时间线里，无法${what}。`, 'warning'); return false; }

    const api = window.neox as unknown as {
      truncateFromUserMessage?: (sessionId: string, k: number) => Promise<{ ok?: boolean; reason?: string }>;
    };
    if (!api?.truncateFromUserMessage) {
      dispatchHint(`当前版本不支持${what}。`, 'warning');
      return false;
    }
    let r: { ok?: boolean; reason?: string } | null = null;
    try { r = await api.truncateFromUserMessage(sid, k); }
    catch (err: any) { console.error(`[${what}] truncate failed:`, err?.message ?? err); }
    if (!r?.ok) {
      dispatchHint(
        r?.reason === 'cloud-session'
          ? `云端会话暂不支持${what}，历史在服务端。`
          : `没能回到这条消息之前，已中止${what}（不会留下改了一半的对话）。`,
        'warning',
      );
      return false;
    }
    /* 存档已经裁了, 界面这一刀必须跟上; 失败也只能继续往下走 —— 回不去了,
     * 但下次进这个会话会从已裁过的真源重读, 最终仍是一致的。 */
    await truncateTimelineFrom(sid, entryId);
    return true;
  }, [truncateTimelineFrom]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ entryId?: string; text?: string }> | undefined)?.detail;
      const entryId = detail?.entryId;
      const text = (detail?.text ?? '').trim();
      const sid = activeSessionIdRef.current;
      if (!entryId || !text || !sid) return;
      void (async () => {
        if (await rewindToUserMessage(sid, entryId, '重发')) await sendPrompt(text);
      })();
    };
    window.addEventListener('neox:message:edit-resend', handler);
    return () => window.removeEventListener('neox:message:edit-resend', handler);
  }, [sendPrompt, rewindToUserMessage]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ entryId?: string; text?: string; images?: Array<{ name?: string; data: string }> }> | undefined)?.detail;
      const entryId = detail?.entryId;
      const sid = activeSessionIdRef.current;
      if (!entryId || !sid) return;
      void (async () => {
        if (streamingBySessionRef.current.get(sid)) await interruptCurrent();
        if (!(await rewindToUserMessage(sid, entryId, '退回'))) return;
        const text = (detail?.text ?? '').trim();
        const images = detail?.images ?? [];
        if (text || images.length > 0) {
          try { window.dispatchEvent(new CustomEvent('neox:composer-fill', { detail: { text, focus: true, images } })); } catch { /* 输入框不在也无妨 */ }
        }
        dispatchHint(images.length > 0
          ? '已退回到这条消息之前；它的文字和图片在输入框里，改一改再发或直接发。'
          : '已退回到这条消息之前；它的文字在输入框里，改一改再发或直接发。', 'info');
      })();
    };
    window.addEventListener('neox:message:rewind', handler);
    return () => window.removeEventListener('neox:message:rewind', handler);
  }, [rewindToUserMessage, interruptCurrent]);

  useEffect(() => {
    const onClear = () => { setActiveSession(null); };
    const onSelect = (e: Event) => {
      const detail = (e as CustomEvent<{ sessionId?: string }>).detail;
      if (detail?.sessionId) selectSession(detail.sessionId);
    };
    window.addEventListener('neox:clear-active-session', onClear);
    window.addEventListener('neox:select-session', onSelect);
    return () => {
      window.removeEventListener('neox:clear-active-session', onClear);
      window.removeEventListener('neox:select-session', onSelect);
    };
  }, [setActiveSession, selectSession]);

  useEffect(() => {
    const onTitle = (e: Event) => {
      const detail = (e as CustomEvent<{ sessionId?: string; title?: string }>).detail;
      const sid = detail?.sessionId;
      const title = (detail?.title ?? '').trim();
      if (!sid || !title) return;
      setSessions((prev) => {
        const idx = prev.findIndex((s) => s.id === sid);
        if (idx < 0 || prev[idx]!.name === title) return prev;
        const next = prev.slice();
        next[idx] = { ...next[idx]!, name: title };
        return next;
      });
      /* 顶部标题读的是 activeSession, 不跟着改就会出现"侧栏改了、标题栏没改" */
      const cur = activeSessionRef.current;
      if (cur && cur.id === sid && cur.name !== title) patchActiveSession(sid, { name: title });
    };
    window.addEventListener('neox:session-title-changed', onTitle as EventListener);
    return () => window.removeEventListener('neox:session-title-changed', onTitle as EventListener);
  }, [setSessions, patchActiveSession]);

  /* ---------- Sub-Agents: 订阅 sub_agent + sub_agent_session_created SSE
   * - sub_agent → subAgentsStore (UI bar 实时增删)
   * - sub_agent_session_created → 刷新 sessions 列表, sidebar 立刻显出新子节点 */
  useEffect(() => {
    if (!window.neox?.onStream) return;
    const unsub = window.neox.onStream((data: any) => {
      if (data?.type === 'sub_agent') {
        const sessionId = requireStreamEventSession(data, 'sub_agent');
        if (!sessionId) return;
        void import('../state/subAgentsStore').then(({ ingestSubAgentEvent }) => {
          ingestSubAgentEvent(sessionId, {
            action: data.action,
            agentId: data.agentId,
            name: data.name,
            description: data.description,
            status: data.status,
            elapsed: data.elapsed,
            toolUseCount: data.toolUseCount,
            outputTokens: data.outputTokens,
            model: data.model,
            modelInherited: data.modelInherited,
          });
        });
        /* sub-agent 完成/失败/终止时, 顺手刷一次 sessions — sub-agent session 末尾 append
         *  了一条 assistant message, 拉新数据让 sidebar/子 session 详情立刻看到结果. */
        if (data.action === 'done' || data.action === 'aborted') {
          scheduleSessionsRefresh();
        }
        return;
      }
      if (data?.type === 'sub_agent_timeline_updated') {
        /* 子会话还在跑时直播走 SSE, 不许用 DB 快照整表覆盖 (会把 file_stream 打成静照)。
         * 这条低频提示只给「已经停了」时补一次冷快照。 */
        const childSid = typeof data.childSessionId === 'string' ? data.childSessionId : undefined;
        if (!childSid || activeSessionIdRef.current !== childSid || !window.neox?.getSession) return;
        if (runningSubAgentIdsRef.current.has(childSid)) return;
        if (subTimelinePullInFlightRef.current) { subTimelinePullQueuedRef.current = true; return; }
        const pull = async (): Promise<void> => {
          subTimelinePullInFlightRef.current = true;
          try {
            if (runningSubAgentIdsRef.current.has(childSid)) return;
            const page: any = await window.neox.timelinePage(childSid, { limit: 5000 });
            if (runningSubAgentIdsRef.current.has(childSid)) return;
            const t = page?.ok ? page.entries : undefined;
            if (Array.isArray(t) && t.length > 0 && activeSessionIdRef.current === childSid) {
              await initializeSessionTimeline(childSid, normalizeTimeline(t));
            }
          } catch { /* 拉失败保持旧快照 */ }
          subTimelinePullInFlightRef.current = false;
          if (subTimelinePullQueuedRef.current) {
            subTimelinePullQueuedRef.current = false;
            if (activeSessionIdRef.current === childSid) void pull();
          }
        };
        void pull();
        return;
      }
      if (data?.type === 'sub_agent_session_created') {
        /* server 刚为 sub-agent 建了独立 session — 让 sidebar 列表跟上。
           走节流器: 一次派 N 个子 Agent 时这个事件会连着来 N 条, 合并成一次。 */
        scheduleSessionsRefresh();
      }
    });
    return () => { try { unsub?.(); } catch { /* ignore */ } };
  }, [activeSession?.id, setSessions, initializeSessionTimeline]);

  /* 切 session 时, 拉一次快照 — 万一漏 SSE 帧 (例如 server 重启后) 也能立刻显出 */
  useEffect(() => {
    const sid = activeSession?.id;
    if (!sid) return;
    void import('../state/subAgentsStore').then(({ refreshSubAgents }) => {
      void refreshSubAgents(sid);
    });
  }, [activeSession?.id]);

  useEffect(() => {
    let cancelled = false;
    const timer = setInterval(() => {
      void import('../state/subAgentsStore').then(({ refreshSubAgents, sessionsWithRunningSubAgents }) => {
        if (cancelled) return;
        for (const sid of sessionsWithRunningSubAgents()) void refreshSubAgents(sid);
      });
    }, 20_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  /* ---------- Background Tasks: 订阅 background_task SSE → 灌进 store
   * Composer 上方的 BackgroundTasksBar 用 useBackgroundTasks(activeSession.id) 渲染.
   *
   * 顺带: task 退出/失败/被杀时, 把对应 timeline shell 卡片的状态 (commandStatus +
   * commandExitCode) 也同步更新. 否则 instant-ack 路径下 "Started in background" 那条
   * entry 永远 'running', UI 上看着进程还在跑, 按 stop 按钮没反应 (pid 已死). */
  useEffect(() => {
    if (!window.neox?.onStream) return;
    const unsub = window.neox.onStream((data: any) => {
      if (data?.type !== 'background_task') return;
      const sessionId = requireStreamEventSession(data, 'background_task');
      if (!sessionId) return;
      if (data.action === 'monitors') {
        void import('../state/monitorsStore').then((m) => m.ingestMonitors(sessionId, data.monitors));
        return;
      }
      void import('../state/backgroundTasksStore').then((store) => {
        if (data.action === 'snapshot') {
          store.ingestServiceSnapshot({ generatedAt: data.generatedAt, processes: data.processes });
        } else if (data.action === 'add' && typeof data.pid === 'number') {
          store.addOptimisticTask(data.pid, String(data.command ?? ''));
        }
      });
      const status = data.updates?.status;
      const pid = typeof data.pid === 'number' ? data.pid : undefined;
      const isExit = typeof status === 'string'
        && (status === 'completed' || status === 'done' || status === 'failed' || status === 'killed');
      if (isExit && pid !== undefined && pid > 0) {
        const entries = timelineMapRef.current.get(sessionId) || [];
        const entry = entries.find(e => (e as any).commandPid === pid && e.commandStatus === 'running');
        if (entry) {
          const exitCode = typeof data.updates?.exitCode === 'number' ? data.updates.exitCode : undefined;
          const isOk = status === 'completed' || status === 'done';
          updateTimelineEntryById(sessionId, entry.id, (e: TimelineEntry) => ({
            ...e,
            pending: false,
            commandStatus: (isOk ? 'completed' : 'error') as 'completed' | 'error',
            commandExitCode: exitCode ?? (isOk ? 0 : (status === 'killed' ? 130 : 1)),
          }));
        }
      }
    });
    return () => { unsub?.(); };
  }, [activeSession?.id, timelineMapRef, updateTimelineEntryById]);

  /* ---------- Timeline shell 状态 reconcile 兜底 ----------
   * SSE event 不总能送达 (free shell 没经 onAdd 注册 / helper 崩了不发 exit / 应用
   * 重启时进程被外部杀掉等), 导致 timeline 卡片永远卡在"运行中". 主动每 10s 调
   * process:list 拿真实 manager 状态, 跟所有 running entry 比对, 不在列表 / 已退出
   * 就把卡片翻成 completed (or error). 视为兜底, SSE 仍是主路径. */
  useEffect(() => {
    const sessionId = activeSession?.id;
    if (!sessionId) return;
    let cancelled = false;
    const reconcile = async () => {
      if (cancelled) return;
      let tasks: any[] = [];
      try {
        tasks = (await (window as any).neox?.processList?.()) || [];
      } catch { return; }
      if (cancelled) return;
      const byPid = new Map<number, any>();
      for (const t of tasks) {
        if (typeof t?.pid === 'number') byPid.set(t.pid, t);
      }
      /* 同一份 process:list 也喂给 store —— 它现在就是 server 快照本身 (listBackgroundTasks
       * 直接返回 buildSnapshot().processes)。这条是 SSE 丢帧时的兜底拉取路径:
       * pull 和 push 是同一个函数的产物, 灌进同一个整体替换入口, 不可能互相打架。 */
      void import('../state/backgroundTasksStore').then(({ ingestServiceSnapshot }) => {
        ingestServiceSnapshot({ generatedAt: Date.now(), processes: tasks });
      }).catch(() => undefined);
      const entries = timelineMapRef.current.get(sessionId) || [];
      for (const entry of entries) {
        const pid = (entry as any).commandPid;
        if (entry.commandStatus !== 'running') continue;
        if (typeof pid !== 'number' || pid <= 0) continue;
        const t = byPid.get(pid);
        if (!t) {
          /* manager 不 track 了 → 进程肯定不在了 (跨进程 / 跨重启). 标 completed exit unknown. */
          updateTimelineEntryById(sessionId, entry.id, (e: TimelineEntry) => ({
            ...e,
            pending: false,
            commandStatus: 'completed' as const,
            commandExitCode: (e as any).commandExitCode ?? 0,
          }));
          continue;
        }
        if (t.status && t.status !== 'running') {
          const isOk = t.status === 'completed' || t.status === 'done';
          updateTimelineEntryById(sessionId, entry.id, (e: TimelineEntry) => ({
            ...e,
            pending: false,
            commandStatus: (isOk ? 'completed' : 'error') as 'completed' | 'error',
            commandExitCode: typeof t.exitCode === 'number' ? t.exitCode : (isOk ? 0 : 1),
          }));
        }
      }
    };
    /* mount 时跑一次 (清掉历史脏 entry), 之后每 10s 兜一次 */
    void reconcile();
    const id = window.setInterval(reconcile, 10_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [activeSession?.id, timelineMapRef, updateTimelineEntryById]);

  /* ---------- Surface: agent 调 open_surface/update_surface/close_surface 工具时,
   * 工具返回的 JSON 含 __neox_surface_event__ marker → 解析后灌进 surfaceStore.
   * SurfacePanel 用 useSurfaces(activeSession.id) 渲染右栏画布.
   *
   * 持久化兜底: action='open' + inline + 文本类 kind → 落盘到
   * ${workspace}/.neox/cache/surfaces/{id}.{ext}, 并把 source 改成 file 模式,
   * 下次会话能找回, viewer 也走 mtime polling 走原生 reload 路径. */
  /* 优先 session 绑定根 (agent setWorkspace / 创建会话时记下的), 再回落 UI 壳工程.
   *  否则 open_surface 相对路径会拼到「编码」这类侧栏工程, 而文件写在 session cwd → 右栏 ENOENT 白屏. */
  const workspacePathForSurface = sessionCwd(activeSession) || workspace.path;
  useEffect(() => {
    if (!window.neox?.onStream) return;
    const SURFACE_MARKER_LITERAL = '__neox_surface_event__';
    const KIND_TO_EXT: Record<string, string> = {
      doc: 'md', plan: 'md', todo: 'json',
      diagram: 'mmd', html: 'html', svg: 'svg',
      chart: 'json',
    };
    const unsub = window.neox.onStream((data: any) => {
      if (data?.type !== 'tool_result') return;
      const raw = typeof data?.output === 'string' ? data.output
        : typeof data?.result === 'string' ? data.result
        : typeof data?.content === 'string' ? data.content
        : '';
      if (!raw || !raw.includes(SURFACE_MARKER_LITERAL)) return;
      void import('../state/surfaceStore').then(async ({ parseSurfaceMarker, ingestSurfaceEvent }) => {
        const payload = parseSurfaceMarker(raw);
        if (!payload) return;
        const sessionId = requireStreamEventSession(data, 'surface_marker');
        if (!sessionId) return;

        /* cloud session + 文件源 surface: pod 上的路径在本机 fs 不存在, viewer 直接打开会空白.
         *  先调 cloudSession.fsRead 把内容拉回来, 转成 inline source, viewer 渲染就只靠内存数据. */
        const neox = (window as any)?.neox;
        const isCloud = !!neox?.cloudSession?.fsRead
          && (data.__transport === 'cloud_consumer'
              || (await neox.cloudSession.ensure?.(sessionId).catch(() => false)));
        if (
          isCloud
          && payload.action === 'open'
          && payload.surface?.source?.type === 'file'
        ) {
          try {
            const r = await neox.cloudSession.fsRead(sessionId, payload.surface.source.path, 4_194_304);
            if (r?.ok) {
              const content = r.encoding === 'base64'
                ? `data:application/octet-stream;base64,${r.content}`
                : r.content;
              payload.surface = {
                ...payload.surface,
                source: { type: 'inline', content },
                metadata: {
                  ...(payload.surface.metadata as any),
                  cloudPath: payload.surface.source.path,
                  cloudSize: r.size,
                  cloudTruncated: r.truncated,
                },
              };
            } else {
              console.warn('[surface] cloud fsRead 失败, surface 内容为空:', r?.error);
            }
          } catch (err: any) {
            console.warn('[surface] cloud fsRead 异常:', err?.message ?? err);
          }
        }

        /* 本地 file 源归一化: agent 用 open_surface 时经常给相对路径 (如 "foo.html"),
         *  ingest 后 CodeSurfaceViewer 直接把它送进 IPC readFile → `filePath must be absolute` 红字.
         *  这里在 ingest 前用 session/壳 workspace 拼绝对. cloud 分支上面已把 file→inline, 不进这条.
         *  同时烙 metadata.workspacePath, 让 Html/Code viewer 读文件时带对根 (不只依赖壳工程). */
        if (
          payload.action === 'open'
          && payload.surface?.source?.type === 'file'
        ) {
          let nextSurface = payload.surface;
          /* 判别式收窄要落在**这个变量**上: 上面判的是 payload.surface?.source?.type,
           * 换成 nextSurface 之后 TS 就不认了 (TS2339: SurfaceSource 上没有 path)。
           * 行为没变, 只是把守卫写在用它的地方。 */
          const nextSource = nextSurface.source;
          if (nextSource.type === 'file' && !isAbsPath(nextSource.path) && workspacePathForSurface) {
            const abs = resolveWorkspacePath(nextSource.path, workspacePathForSurface);
            if (isAbsPath(abs)) {
              nextSurface = {
                ...nextSurface,
                source: { type: 'file', path: abs },
              };
            }
          }
          if (workspacePathForSurface && !(nextSurface.metadata as any)?.workspacePath) {
            nextSurface = {
              ...nextSurface,
              metadata: { ...(nextSurface.metadata as any), workspacePath: workspacePathForSurface },
            };
          }
          payload.surface = nextSurface;
        }

        /* 兜底落盘: 只对 open + inline + 已知文本类 kind 做, file/url 已经天然持久化.
         *  cloud session 上面已经把 file → inline 转过, 这里照常走落盘逻辑没问题 (落盘到本机 .neox cache). */
        if (
          payload.action === 'open'
          && payload.surface?.source?.type === 'inline'
          && KIND_TO_EXT[payload.surface.kind]
          && workspacePathForSurface
          && window.neox?.writeFile
        ) {
          const ext = KIND_TO_EXT[payload.surface.kind];
          const filePath = `${workspacePathForSurface}/.neox/cache/surfaces/${payload.surface.id}.${ext}`;
          try {
            const write = await window.neox.writeFile(filePath, payload.surface.source.content);
            if (write?.success) {
              payload.surface = {
                ...payload.surface,
                source: { type: 'file', path: filePath },
                metadata: { ...(payload.surface.metadata as any), inlineFallbackPath: filePath },
              };
            }
          } catch (err) {
            console.warn('[surface] inline 兜底落盘失败, 继续走 inline 渲染:', err);
          }
        }

        ingestSurfaceEvent(sessionId, payload, { toolCallId: data.toolId || data.toolCallId });
      }).catch((err) => {
        /* 动态 import 失败 (chunk 丢失 / 网络问题) — 不致命, 用户感知是 surface 没渲染.
         * 别用 toast 打扰, 但要落 console 让排查时能看到. */
        console.error('[surface] dynamic import surfaceStore failed:', err);
      });
    });
    return () => { unsub?.(); };
  }, [activeSession?.id, activeSession?.workspacePath, workspacePathForSurface]);

  useEffect(() => {
    if (!window.neox?.onStream) return;
    const unsub = window.neox.onStream((data: any) => {
      if (data?.type !== 'error') return;
      const sessionId = requireStreamEventSession(data, 'runtime error');
      if (!sessionId) {
        return;
      }
      const raw = String(data.message ?? data.error ?? '').trim();
      if (!raw) return;
      /* 用户主动停的不算中断 —— 那是他自己按的, 再弹一张红卡是噪音 */
      if (/interrupted by user|Task interrupted|用户中断/i.test(raw)) return;

      const tl = timelineMapRef.current.get(sessionId) ?? [];
      const anchorIdx = tl.map((e) => e.type).lastIndexOf('user_message');
      const turnAnchorId = anchorIdx >= 0 ? tl[anchorIdx].id : null;
      const inTurn = anchorIdx >= 0 ? tl.slice(anchorIdx + 1) : tl;

      const entryId = turnAnchorId
        ? `runtime-error-${turnAnchorId}`
        : `runtime-error-${data.eventId ?? `${sessionId}-${Date.now()}`}`;
      const prevSame = tl.find((e) => e.id === entryId);

      const superseded = inTurn.filter((e) => e.type === 'runner_error' && e.id !== entryId);

      const repeatCount = Math.max(
        (prevSame as { errorRepeatCount?: number } | undefined)?.errorRepeatCount ?? 0,
        ...superseded.map((e) => (e as { errorRepeatCount?: number }).errorRepeatCount ?? 0),
        0,
      ) + 1;

      for (const e of superseded) {
        if (deleteTimelineEntry) void deleteTimelineEntry(sessionId, e.id);
        else updateTimelineEntryById(sessionId, e.id, (prev) => ({ ...prev, hidden: true } as any), true);
      }

      appendTimelineEntry(sessionId, {
        id: entryId,
        type: 'runner_error',
        errorRepeatCount: repeatCount,
        errorLastAt: Date.now(),
        title: bi('本轮中断', 'Turn interrupted'),
        timestamp: prevSame?.timestamp ?? Date.now(),
        pending: false,
        level: 'error',
        errorCode: typeof data.code === 'string' ? data.code : 'RUNTIME_ERROR',
        errorMessage: raw,
        errorSuggestion: typeof data.suggestion === 'string' && data.suggestion.trim()
          ? data.suggestion.trim()
          : '点「重试」再跑一次这一轮; 如果反复出现, 到 设置 → API 服务商 里确认这个模型的配置和额度。',
        errorAction: { kind: 'retry', label: '重试' },
      } as TimelineEntry, true /* forceSync — no-op, 仅签名兼容 */);
    });
    return () => { unsub?.(); };
  }, [activeSession?.id, appendTimelineEntry, timelineMapRef, deleteTimelineEntry, updateTimelineEntryById]);

  /* ---------- Surface 流式渲染: agent 还在 stream open_surface args 时, 用 partial
   * JSON 抽 kind + source.content 灌进 surfaceStore, 让右栏边流边渲染 (而不是等
   * tool_result 整段回来才一次性刷). 走 forwarder 的 type='token' source='tool_args'
   * 通道, 那个通道天然带 toolId/toolName, 不需要新 IPC 协议. */
  useEffect(() => {
    if (!window.neox?.onStream) return;
    const OPEN_SURFACE_NAMES = new Set(['open_surface', 'surface_open', 'openSurface']);
    const buffers = new Map<string, { args: string; inited: boolean }>();
    const unsub = window.neox.onStream((data: any) => {
      /* tool_result / error → GC buffer, streaming temp surface 由 ingestSurfaceEvent 替换. */
      if (data?.type === 'tool_result' || data?.type === 'tool_call_end' || data?.type === 'error') {
        const toolId = data.toolId || data.toolCallId;
        if (toolId) {
          const hadPlaceholder = buffers.get(toolId)?.inited === true;
          buffers.delete(toolId);
          if (hadPlaceholder) {
            const sid = requireStreamEventSession(data, 'surface placeholder');
            if (sid) {
              window.setTimeout(() => {
                void import('../state/surfaceStore').then(({ abandonStreamingSurface }) => {
                  abandonStreamingSurface(sid, toolId);
                });
              }, 1500);
            }
          }
        }
        return;
      }
      if (data?.type !== 'token' || (data as any).source !== 'tool_args') return;
      const toolId = (data as any).toolId;
      const toolName = (data as any).toolName;
      if (!toolId || !toolName || !OPEN_SURFACE_NAMES.has(toolName)) return;
      const sessionId = requireStreamEventSession(data, 'open surface');
      if (!sessionId) return;

      const buf = buffers.get(toolId) || { args: '', inited: false };
      buf.args += (data as any).content || '';
      buffers.set(toolId, buf);

      void import('../state/surfaceStore').then(({
        extractPartialOpenSurfaceArgs, ingestStreamingSurfaceInit, ingestStreamingSurfaceContent,
      }) => {
        const partial = extractPartialOpenSurfaceArgs(buf.args);
        if (!buf.inited && partial.kind && partial.sourceType === 'inline') {
          ingestStreamingSurfaceInit(sessionId, {
            toolCallId: toolId,
            kind: partial.kind,
            title: partial.title || `${partial.kind} 生成中…`,
          });
          buf.inited = true;
        }
        if (buf.inited && partial.content !== undefined) {
          ingestStreamingSurfaceContent(sessionId, {
            toolCallId: toolId,
            partialContent: partial.content,
          });
        }
      });
    });
    return () => { unsub?.(); };
  }, [activeSession?.id]);

  /* 后台服务起来 → 右侧自动显示服务面板; 判定与打开方式全在 state/serviceAutoShow.ts */
  useEffect(() => initServiceAutoShow({ getSessionId: () => activeSessionIdRef.current ?? undefined }), []);

  /* ---------- P2-1: main 进程派 services:auto-open IPC → 转 neox:open-surface 事件.
   * 触发场景: ProcessManager 探到 bound 进程的端口 + 对应 RunConfig.autoOpenSurface=true.
   * 整链路: bg shell 起 → 2s 端口探测 → port-detected event → main 广播 →
   * 这里转 CustomEvent → 下面那个 useEffect 灌进 surfaceStore. */
  useEffect(() => {
    const api = (window as any).neox;
    if (!api?.onServicesAutoOpen) return;
    const unsub = api.onServicesAutoOpen((detail: any) => {
      /* revealPanel: 这条路是 RunConfig.autoOpenSurface=true 明确点过的开关 ——
       * "起来后自动打开 localhost:port"。用户已经表过态, 照展。 */
      const ev = new CustomEvent('neox:open-surface', { detail: { ...detail, revealPanel: true } });
      window.dispatchEvent(ev);
    });
    return () => { unsub?.(); };
  }, []);

  /* ---------- 渲染端 dispatch 的 'neox:open-surface' CustomEvent →
   * 灌进 surfaceStore. 用于 UI 内组件 (e.g. Services viewer 的 "Open in browser",
   * CommandPalette services.open) 主动开 surface tab, 无需经过 agent 工具. */
  useEffect(() => {
    const onOpenSurface = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail || typeof detail !== 'object') return;
      const sessionId = activeSession?.id;
      if (!sessionId) return;
      void import('../state/surfaceStore').then(({ ingestSurfaceEvent }) => {
        const now = Date.now();
        ingestSurfaceEvent(sessionId, {
          __neox_surface_event__: true,
          action: 'open',
          byUser: detail.byUser === true,
          surface: {
            id: `sfc-ui-${now}-${Math.random().toString(16).slice(2, 6)}`,
            kind: detail.kind,
            source: detail.source,
            title: detail.title,
            pinned: detail.pinned === true,
            createdAt: now,
            updatedAt: now,
            /* 透传 metadata — singleton / isHome 等标记需要传到 store, 不能丢 */
            metadata: detail.metadata,
          },
        } as any, {
          reveal: detail.byUser === true || detail.revealPanel === true,
        });
      });
    };
    window.addEventListener('neox:open-surface', onOpenSurface);
    return () => window.removeEventListener('neox:open-surface', onOpenSurface);
  }, [activeSession?.id]);

  useOptimisticInjectBubbles(appendTimelineEntry, deleteTimelineEntry);

  useEffect(() => {
    if (!window.neox?.onStream) return;
    const unsub = window.neox.onStream((data: any) => {
      if (data?.type === 'ask_user_needed') {
        const sessionId = requireStreamEventSession(data, 'ask_user_needed');
        if (!sessionId) return;
        const nowTs = Date.now();
        const timeoutSec = typeof data.timeoutSec === 'number' && data.timeoutSec > 0
          ? data.timeoutSec : undefined;
        appendTimelineEntry(sessionId, {
          id: `ask-user-${data.requestId}`,
          type: 'ask_user',
          title: bi('Agent 提问', 'Agent is asking'),
          timestamp: nowTs,
          pending: true,
          askUserRequestId: data.requestId,
          askUserQuestions: (data.questions || []).map((q: any) => ({
            question: q.question,
            options: q.options || [],
          })),
          askUserStatus: 'waiting',
          askUserCreatedAt: nowTs,
          askUserTimeoutSec: timeoutSec,
        }, true /* forceSync */);
        return;
      }

      if (data?.type === 'ask_user_expired') {
        /* 同 ask_user_needed: 认事件自己的归属, 否则会把别的会话的超时翻在当前会话上 */
        const sessionId = requireStreamEventSession(data, 'ask_user_expired');
        if (!sessionId) return;
        const entryId = `ask-user-${data.requestId}`;
        const aborted = data.reason === 'aborted';
        updateTimelineEntryById(sessionId, entryId, (prev: TimelineEntry) => ({
          ...prev,
          pending: false,
          askUserStatus: prev.askUserStatus === 'waiting' ? 'timeout' : prev.askUserStatus,
          ...(aborted ? { interrupted: true, errorReason: 'interrupted' } : {}),
        } as TimelineEntry), true);
        return;
      }

      if (data?.type === 'ask_user_resolved') {
        const sessionId = requireStreamEventSession(data, 'ask_user_resolved');
        const answers = (data.answers && typeof data.answers === 'object') ? { askUserAnswers: data.answers } : {};
        if (sessionId) updateTimelineEntryById(sessionId, `ask-user-${data.requestId}`, (prev: TimelineEntry) => (
          prev.askUserStatus !== 'waiting' ? prev : ({ ...prev, pending: false, askUserStatus: 'answered', ...answers } as TimelineEntry)
        ), true);
        return;
      }
    });
    return () => { unsub?.(); };
  }, [activeSession?.id, appendTimelineEntry, updateTimelineEntryById]);

  /* ---------- Ask User 答复回传 ----------
   * 后端返 { status, reason? }:
   *   - 'resolved'/'resumed': 答案命中 (内存或磁盘 resume), 卡片翻 ✓ 已回答
   *   - 'orphan':              答案丢了 (服务在 ask_user 中重启 + 磁盘也没记录),
   *                            卡片留 waiting + 落 askUserError 字段, UI 提示用户改用普通消息.
   * 不再无视后端结果一律乐观翻 answered — 用户经历过"等很久回来 submit 没反应"的痛. */
  const answerAskUser = useCallback(
    async (requestId: string, answers: Record<string, string>) => {
      const entryId = `ask-user-${requestId}`;
      let sessionId: string | undefined;
      for (const [sid, entries] of timelineMapRef.current) {
        if (entries.some((e) => e.id === entryId)) { sessionId = sid; break; }
      }
      let status: 'resolved' | 'resumed' | 'orphan' = 'orphan';
      let reason: string | undefined;
      try {
        const result = await window.neox.replyAskUser(requestId, answers);
        if (result && typeof result === 'object' && 'status' in result) {
          status = result.status;
          reason = result.reason;
        } else {
          /* 旧 server (升级前) 不返 status, 当成功处理 — 避免破坏向后兼容 */
          status = 'resolved';
        }
      } catch (err: any) {
        console.error('[NeoxRuntimeBridge] replyAskUser failed', err);
        reason = err?.message || 'ipc error';
        status = 'orphan';
        dispatchOpFailedFromError('提交回答', err);
      }

      if (!sessionId) return;
      if (status === 'orphan') {
        updateTimelineEntryById(sessionId, entryId, (prev: TimelineEntry) => ({
          ...prev,
          pending: false,
          askUserStatus: prev.askUserStatus === 'waiting' ? 'timeout' : prev.askUserStatus,
          interrupted: true,
          errorReason: 'interrupted',
          askUserError: reason || '会话已断开, 答案未送达',
          askUserAttemptedAnswers: answers,
        } as TimelineEntry), true);
        return;
      }
      updateTimelineEntryById(sessionId, entryId, (prev: TimelineEntry) => ({
        ...prev,
        pending: false,
        askUserStatus: 'answered',
        askUserAnswers: answers,
      }));
    },
    [timelineMapRef, updateTimelineEntryById],
  );

  const [approvalQueueBySession, setApprovalQueueBySession] = useState<Record<string, PendingApproval[]>>({});

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as { __neoxTestApproval?: (p: unknown) => void }).__neoxTestApproval = (p: unknown) => {
      const sid = activeSessionIdRef.current;
      if (!sid) return;
      setApprovalQueueBySession(prev => (p
        ? { ...prev, [sid]: [p as PendingApproval] }
        : { ...prev, [sid]: [] }));
    };
  }, []);

  /* approval_needed 跟 timeline entry 的关联:
   * approval_needed 事件只带 (requestId, toolName, args), 没有 toolCallId — 后端 PermissionManager
   * 的 ApprovalRequest 接口本来就不传 tool call id. 但 UI 要把 "等待审批" 状态打到对应的 entry 上
   * (跟 "工具真在跑" 区分), 必须按 (toolName, args 指纹) 反向匹配 entry.
   *   · 文件类工具用 args.file_path / args.filePath / args.path 反查 entry.filePath
   *   · shell 工具用 args.command / args.code / args.cmd 反查 entry.commandCode
   *   · 匹中后 entry.awaitingApproval=true; 出队时清掉 (即便 entry 还在 pending) */
  const matchEntryForApproval = useCallback(
    (sessionId: string, approval: PendingApproval): string | undefined => {
      const timeline = timelineMapRef.current?.get(sessionId);
      if (!timeline) return undefined;
      const args = (approval.args ?? {}) as Record<string, any>;
      const filePath = typeof args.file_path === 'string' ? args.file_path
        : typeof args.filePath === 'string' ? args.filePath
        : typeof args.path === 'string' ? args.path
        : '';
      const command = typeof args.command === 'string' ? args.command
        : typeof args.code === 'string' ? args.code
        : typeof args.cmd === 'string' ? args.cmd
        : '';
      // 最近 pending 的同 toolName entry — 反向遍历, 取最后一条满足条件的
      for (let i = timeline.length - 1; i >= 0; i--) {
        const e = timeline[i]!;
        if (!e.pending) continue;
        if (e.toolName !== approval.toolName && e.toolName !== `${approval.toolName}`) continue;
        if (filePath) {
          const ep = e.filePath || e.targetPath || '';
          if (ep && (ep === filePath || ep.endsWith(filePath) || filePath.endsWith(ep))) return e.id;
        }
        if (command) {
          if (e.commandCode === command) return e.id;
        }
        // 没指纹可比: 同 toolName + pending 就行 (大多数 case 一个 session 内同时只有一个 pending)
        if (!filePath && !command) return e.id;
      }
      return undefined;
    },
    [timelineMapRef],
  );

  useEffect(() => {
    if (!window.neox?.onStream) return;
    const unsub = window.neox.onStream((data: any) => {
      if (data?.type === 'approval_needed') {
        const sessionId = requireStreamEventSession(data, 'approval_needed');
        if (!sessionId) {
          return;
        }
        const incoming: PendingApproval = {
          requestId: data.requestId,
          toolName: data.toolName,
          args: data.args,
          reason: data.reason,
          allowRemember: data.allowRemember,
          scopeKey: data.scopeKey,
          risk: data.risk,
          provenance: data.provenance,
        };
        setApprovalQueueBySession(prev => {
          const list = prev[sessionId] ?? [];
          if (list.some(p => p.requestId === incoming.requestId)) return prev;
          return { ...prev, [sessionId]: [...list, incoming] };
        });
        // 给对应 entry 打上 awaitingApproval — UI 显示 "等待审批" 而非 "运行中"
        const entryId = matchEntryForApproval(sessionId, incoming);
        if (entryId) {
          updateTimelineEntryById(sessionId, entryId, (entry: TimelineEntry) => ({
            ...entry,
            awaitingApproval: true,
          }));
        }
        return;
      }
      if (data?.type === 'approval_cancelled') {
        const sessionId = requireStreamEventSession(data, 'approval_cancelled');
        if (!sessionId) return;
        // 出队前先把 awaitingApproval 清掉 — 即便 entry 还在 pending (审批完工具开始跑, 状态变 "运行中")
        const removedApproval = (approvalQueueBySession[sessionId] ?? []).find(p => p.requestId === data.requestId);
        if (removedApproval) {
          const entryId = matchEntryForApproval(sessionId, removedApproval);
          if (entryId) {
            updateTimelineEntryById(sessionId, entryId, (entry: TimelineEntry) => ({
              ...entry,
              awaitingApproval: false,
            }));
          }
        }
        setApprovalQueueBySession(prev => {
          const list = prev[sessionId];
          if (!list || list.length === 0) return prev;
          const filtered = list.filter(p => p.requestId !== data.requestId);
          if (filtered.length === list.length) return prev;
          return { ...prev, [sessionId]: filtered };
        });
        return;
      }
    });
    return () => { unsub?.(); };
  }, [activeSession?.id, approvalQueueBySession, matchEntryForApproval, updateTimelineEntryById]);

  const pendingApproval: PendingApproval | null = useMemo(() => {
    const sessionId = activeSession?.id;
    if (!sessionId) return null;
    const list = approvalQueueBySession[sessionId];
    return list && list.length > 0 ? list[0]! : null;
  }, [activeSession?.id, approvalQueueBySession]);

  const answerApproval = useCallback(
    async (requestId: string, approved: boolean, remember: boolean) => {
      const sessionId = activeSession?.id;
      /* 乐观出队 — 不等 IPC roundtrip, 让 banner 立刻翻页. 同时清掉对应 entry 的 awaitingApproval —
       * 用户点了同意/拒绝, 等待态结束 (后续会有 tool_result 或 approval_cancelled 来彻底收敛). */
      if (sessionId) {
        const removedApproval = (approvalQueueBySession[sessionId] ?? []).find(p => p.requestId === requestId);
        if (removedApproval) {
          const entryId = matchEntryForApproval(sessionId, removedApproval);
          if (entryId) {
            updateTimelineEntryById(sessionId, entryId, (entry: TimelineEntry) => ({
              ...entry,
              awaitingApproval: false,
            }));
          }
        }
        setApprovalQueueBySession(prev => {
          const list = prev[sessionId];
          if (!list || list.length === 0) return prev;
          const filtered = list.filter(p => p.requestId !== requestId);
          if (filtered.length === list.length) return prev;
          return { ...prev, [sessionId]: filtered };
        });
      }
      try {
        await window.neox.replyPermission(requestId, approved, remember);
      } catch (err) {
        console.error('[NeoxRuntimeBridge] replyPermission failed', err);
        dispatchOpFailedFromError(approved ? '同意操作' : '拒绝操作', err);
      }
    },
    [activeSession?.id, approvalQueueBySession, matchEntryForApproval, updateTimelineEntryById],
  );

  /* ---------- 打开文件 (Finder/Explorer) ---------- */
  const openFile = useCallback(
    async (p: string) => {
      if (!p) return;
      const abs = /^\//.test(p) || /^[A-Z]:[\\/]/i.test(p) ? p : `${workspace.path}/${p}`;
      try {
        await window.neox.openInFinder(abs);
      } catch (err) {
        console.error('[NeoxRuntimeBridge] openInFinder failed', err);
        const lang = (typeof document !== 'undefined' ? document.documentElement.lang : '') || 'zh';
        dispatchOpFailedFromError(revealInFileManagerLabel(lang.toLowerCase().startsWith('zh')), err);
      }
    },
    [workspace.path],
  );

  /* ---------- Session level: compact / undo / checkpoint / rollback ---------- */
  const compactActiveSession = useCallback(async () => {
    if (!activeSession) return;
    window.dispatchEvent(new CustomEvent('neox:manual-compaction-started', {
      detail: {
        sessionId: activeSession.id,
        originalTokens: contextUsedRef.current,
        timestamp: Date.now(),
      },
    }));
    try {
      const updated = await window.neox.compactSession(activeSession.id);
      const sanitized = sanitizeSessionData(updated);
      /* 压缩完成事件(raw_response_event/context_compaction)会把 contextUsed 降到 finalTokens。
       * 但 IPC 随后返回的 refreshSession 可能仍带旧高水位(例如 171k), 不能让它覆盖刚收到的
       * finalTokens(例如 28k)。这里用全局 contextSnapshot / 最新 ref 保护较新的低水位。 */
      const snap = getContextSnapshot(sanitized.id);
      const snapTokens = snap?.sessionId === sanitized.id && typeof snap.tokensUsed === 'number'
        ? snap.tokensUsed
        : 0;
      const liveContextUsed = snapTokens > 0 ? snapTokens : contextUsedRef.current;
      const shouldKeepLiveContext = liveContextUsed > 0 && (sanitized.contextUsed || 0) > liveContextUsed;
      const merged: Session = shouldKeepLiveContext
        ? {
            ...sanitized,
            contextUsed: liveContextUsed,
            latestRequestUsage: {
              ...(sanitized.latestRequestUsage ?? {}),
              ...(snap?.latestRequestUsage ?? {}),
              inputTokens: snap?.latestRequestUsage?.inputTokens ?? liveContextUsed,
              totalTokens: liveContextUsed,
            },
          }
        : sanitized;
      setSessions((prev) => prev.map((x) => (x.id === merged.id ? merged : x)));
      patchActiveSession(merged.id, merged);
      /* 活跃会话单值: 大会话压几分钟, 回来时用户可能已切走, 写进去 = 新会话显示旧会话的消息和上下文 */
      if (activeSessionIdRef.current === merged.id) {
        setMessages(merged.messages ?? []);
        if (shouldKeepLiveContext) setContextUsed(liveContextUsed);
      }
    } catch (err) {
      console.error('[NeoxRuntimeBridge] compactSession failed', err);
      window.dispatchEvent(new CustomEvent('neox:manual-compaction-failed', {
        detail: {
          sessionId: activeSession.id,
          error: err instanceof Error ? err.message : String(err),
          timestamp: Date.now(),
        },
      }));
      dispatchOpFailedFromError('压缩上下文', err);
    }
  }, [activeSession, setSessions, patchActiveSession, setMessages, setContextUsed]);

  const undoActiveSession = useCallback(async () => {
    const sid = activeSessionIdRef.current;
    if (!sid) return;
    const entries = timelineMapRef.current.get(sid) ?? [];
    const last = [...entries].reverse().find((e) => e?.type === 'user_message');
    if (!last?.id) { dispatchHint('这个会话里还没有可撤销的消息。', 'info'); return; }
    if (!(await rewindToUserMessage(sid, last.id, '撤销'))) return;
    const text = (last.detail ?? '').trim();
    if (text) {
      try { window.dispatchEvent(new CustomEvent('neox:composer-fill', { detail: { text, focus: true } })); } catch { /* 输入框不在也无妨 */ }
    }
    dispatchHint('已撤销最近一轮；那条消息的文字在输入框里。', 'info');
  }, [rewindToUserMessage]);

  const checkpointActiveSession = useCallback(async (name?: string) => {
    if (!activeSession) return;
    try {
      await window.neox.checkpointSession(activeSession.id, name);
    } catch (err) {
      console.error('[NeoxRuntimeBridge] checkpointSession failed', err);
      dispatchOpFailedFromError('创建快照', err);
    }
  }, [activeSession]);

  const rollbackActiveSession = useCallback(async (checkpointId: string) => {
    if (!activeSession) return;
    try {
      const updated = await window.neox.rollbackSession(activeSession.id, checkpointId);
      const sanitized = sanitizeSessionData(updated);
      setSessions((prev) => prev.map((x) => (x.id === sanitized.id ? sanitized : x)));
      setActiveSession(sanitized);
      setMessages(sanitized.messages ?? []);
      await initializeSessionTimeline(sanitized.id);
    } catch (err) {
      console.error('[NeoxRuntimeBridge] rollbackSession failed', err);
    }
  }, [activeSession, setSessions, setActiveSession, setMessages, initializeSessionTimeline]);

  const stopCurrent = interruptCurrent;

  /* E-03 per-hunk review state 持久化 helper — CodeSurfaceViewer 内点 ✓/✗ 调.
   *   走 updateTimelineEntryById, 改 entry.editHunks[hunkIdx].review, 自动 queueWrite IndexedDB.
   *   hunkIdx<0 = 顶层单 hunk (entry 没 editHunks 数组, 用 entry.editStartLine/editNewString 顶层 fields).
   *   这种 entry 没有 editHunks 数组可放 review, 先把状态挂到 entry 顶层一个内部字段 (__topHunkReview),
   *   CodeSurfaceViewer 重 mount 时不会读这个 (顶层路径没经过 editHunks loop), 但至少不丢. */
  const updateHunkReview = useCallback(
    (sessionId: string, entryId: string, hunkIdx: number, review: 'pending' | 'accepted' | 'rejected') => {
      if (!sessionId || !entryId) return;
      updateTimelineEntryById(sessionId, entryId, (prev: any) => {
        if (hunkIdx < 0) {
          /* 顶层 single-hunk entry — review 存到 entry 顶层 internal 字段 (renderer 自己用) */
          return { ...prev, __topHunkReview: review };
        }
        const hunks = Array.isArray(prev.editHunks) ? [...prev.editHunks] : [];
        if (!hunks[hunkIdx]) return prev;
        hunks[hunkIdx] = { ...hunks[hunkIdx], review };
        return { ...prev, editHunks: hunks };
      }, true /* forceSync — no-op, 仅签名兼容 */);
    },
    [updateTimelineEntryById],
  );

  /* ---------- Context value ---------- */
  const value = useMemo<NeoxRuntimeContextValue>(
    () => ({
      workspacePath: workspace.path,
      sessions,
      sessionsLoading,
      activeSession,
      createNewSession,
      selectSession,
      renameSession,
      deleteSession,
      exportSession,
      /* 占位: 真实 feed 见 useTimelineFeed(); 稳定空引用避免 Context 因 events 换身份 */
      timelineEvents: EMPTY_TIMELINE_FOR_CONTEXT,
      prependOlderTimelineEntries,
      /* 异常区的「关闭」用它把那一条抹掉 (异常态本来就不落盘, 关掉即彻底消失)。 */
      dismissTimelineEntry: deleteTimelineEntry,
      streaming,
      runningSessionIds: mergedRunningSessionIds,
      status,
      selectedModel,
      availableModels,
      setSelectedModel: setSelectedModelPersisted,
      setModelForSession,
      attachments,
      addAttachment,
      removeAttachment,
      clearAttachments,
      mode,
      setMode,
      thinkingMode,
      setThinkingMode,
      effortLevel,
      effortByModel,
      setEffortForModel,
      sendPrompt,
      stopCurrent,
      interruptCurrent,
      retryLast,
      continueLast,
      answerAskUser,
      pendingApproval,
      answerApproval,
      openFile,
      compactActiveSession,
      undoActiveSession,
      checkpointActiveSession,
      rollbackActiveSession,
      paused,
      canRetry,
      lastError,
      clearLastError,
      contextUsed,
      totalTokens,
      turnStartedAt,
      updateHunkReview,
    }),
    [
      workspace.path,
      sessions,
      sessionsLoading,
      activeSession,
      createNewSession,
      selectSession,
      renameSession,
      deleteSession,
      exportSession,
      prependOlderTimelineEntries,
      deleteTimelineEntry,
      streaming,
      mergedRunningSessionIds,
      status,
      selectedModel,
      availableModels,
      setSelectedModelPersisted,
      setModelForSession,
      attachments,
      addAttachment,
      removeAttachment,
      clearAttachments,
      mode,
      setMode,
      thinkingMode,
      effortLevel,
      effortByModel,
      sendPrompt,
      stopCurrent,
      interruptCurrent,
      retryLast,
      continueLast,
      answerAskUser,
      pendingApproval,
      answerApproval,
      openFile,
      compactActiveSession,
      undoActiveSession,
      checkpointActiveSession,
      rollbackActiveSession,
      paused,
      canRetry,
      lastError,
      clearLastError,
      contextUsed,
      totalTokens,
      turnStartedAt,
      updateHunkReview,
    ],
  );

  return <NeoxRuntimeContext.Provider value={value}>{children}</NeoxRuntimeContext.Provider>;
};

export default NeoxRuntimeBridge;

