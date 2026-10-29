import TimelineSkeleton from './TimelineSkeleton';
import React, { Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { PPTX_AVAILABLE } from '../surface/pptxAvailability';
import { useTimelineEventsForMapping } from './hooks/useTimelineEventsForMapping';
import { useComposerFlip } from './hooks/useComposerFlip';
import { createEmptyFocusLatch, stepEmptyFocusLatch, type EmptyFocusLatchState } from './emptyFocusLatch';
import TimelineHeader from './TimelineHeader';
import WorkFolderPill from './WorkFolderPill';
import TimelineSteps from './TimelineSteps';
import { useEditionBillingPill as useBillingPill } from '../shell/editionHooks';
import TimelineComposer, { ApprovalBanner } from './TimelineComposer';
import ShelfButton from './ShelfButton';
import Mascot from '../mascot/Mascot';
import {
  currentActivity, deriveMascotMood, errorSignalText, lastToolFailureId, pickMascotSignal, useRunDoneNotice,
  type MascotSignalKind,
} from '../mascot/mascotSignal';
import { DirectImageTurns } from './DirectImageTurns';
import { useBackgroundTaskPills } from './BackgroundTasksBar';
import { useSubAgentPills } from './SubAgentsBar';
import { useTurnReviewPill } from './TurnSummaryBar';
import { usePlanPill } from './PlanStatusBar';
import { useResumePill } from './useResumePill';
import { buildPlanEditDirective, notePlanEdit, type PlanUserEdit } from '../../state/planEdits';
import { useTargetPill } from './TargetInlineBanner';
import { useTeamPill } from './useTeamPill';
import DockRail from './dock/DockRail';
import type { DockPill } from './dock/dockTypes';
import { mapTimelineEntriesToRows } from './mapTimelineToRows';
import { useNeoxRuntime } from '../../app/NeoxRuntimeContext';
import { useTimelineFeed, useTimelineFeedSessionId, useTimelineHydratingSessionId } from '../../state/timelineFeedStore';
import { publishTimelinePanelSummary } from '../../state/timelinePanelSummaryStore';
import { buildTimelinePanelSummary } from '../../state/buildTimelinePanelSummary';
import { useAgentModeVariant } from '../../hooks/useAgentModeVariant';
import { useStableCallback } from '../../hooks/useStableCallback';
import { CodeEmptyTop } from './CodeEmptySuggestions';
import { WorkStarters } from './WorkStarters';
import { useAutoOpenDeliverable } from './hooks/useAutoOpenDeliverable';
import { BrandMarkImg } from './BrandMarkImg';
import { useI18n } from '../../hooks/useI18n';
import type { TimelineRow } from './types';
import type { TimelineEntry } from '../../utils/workspaceUtils';
import { displayWorkspaceName } from '../../utils/modeHomeName';
import { useTimelineDensityPreference, useTimelineFontScalePreference, useTimelineLineHeightPreference, useContextRailHidden, useComposerStylePreference } from './timelinePreferences';
import { shellPerf } from '../../perf/shellPerf';
import { useWorkspaceFsWatcher } from '../../platform/useWorkspaceFsWatcher';
import { isBlankSession } from '../../app/blankSessionReuse';

import type { CloudLocation } from '../shell/cloudLocation';
import { CloudSessionBanner } from './CloudSessionBanner';
import { dispatchOpFailed } from '../../components/notifyEvents';
import { AgentTimelineContextRail } from './AgentTimelineContextRail';
import { usePanelLayout, useActivePanelTab } from '../../state/panelLayoutStore';
import { useContextRailFit } from './hooks/useContextRailFit';
import { deferToAgentAnswer } from './cells/AskUserView';
import { setAskDockShown } from './askDockPresence';
import { isAnomalyEntry, pickCurrentTurnAnomalies } from './turnAnomaly';
import { cancelAutoRetry } from '../../state/turnAutoRetry';
import { ProjectPicker, type ProjectChoice } from '../shell/ProjectPicker';
import { normalizeAgentMode, presentationMode } from '../../app/modeWorkspaceBinding';
import {
  newOptimisticInjectId,
  emitOptimisticInject,
  emitOptimisticInjectDrop,
} from './injectOptimisticBubble';


/* 稳定引用 —— 每次新建 [] 会让下游 useMemo/defer 全部失效 */
const EMPTY_TIMELINE_EVENTS: TimelineEntry[] = [];

interface Props {
  onSubmit?: (prompt: string) => void;
  /** 当前 session 的云端 location — header 用它决定 CloudSyncCapsule 显隐. */
  cloudLocation?: CloudLocation;
  /** Cloud session meta — banner 显 */
  cloudMeta?: {
    podId?: string | null;
    fileCount?: number | null;
    lastActiveAt?: number | null;
    sessionState?: string | null;
  };
  /** Cloud banner 操作 */
  onPullBackFromCloud?: () => void;
  onTerminateCloud?: () => void;
  /**
   * 壳层 Surface 右栏是否收起。收起时在 timeline 内侧显示 Cursor 式上下文栏；
   * Surface 展开时隐藏，避免双右栏。默认 true（无 prop 时也显示栏）。
   */
  surfacePanelCollapsed?: boolean;
  /** 空态「在 X 里」点项目名弹的菜单: 可选项目 / 选中后在那新建 / 打开其他文件夹 */
  projectChoices?: ProjectChoice[];
  onPickProject?: (path: string) => void;
  onOpenProjectFolder?: () => void;
}


function findWaitingAskUser(events: any[], isZh: boolean) {
  for (let i = events.length - 1; i >= 0; i--) {
    const entry = events[i];
    if (entry?.type === 'ask_user' && entry.askUserStatus === 'waiting' && entry.interrupted !== true) {
      const questions = Array.isArray(entry.askUserQuestions) ? entry.askUserQuestions : [];
      const firstQuestion = questions[0]?.question || (isZh ? 'Agent 需要你确认下一步' : 'Agent needs your confirmation');
      const optionCount = questions.reduce((sum: number, q: any) => sum + (Array.isArray(q?.options) ? q.options.length : 0), 0);
      return { id: entry.id, requestId: entry.askUserRequestId ?? entry.requestId, question: firstQuestion, questions, questionCount: questions.length, optionCount };
    }
  }
  return null;
}

/* ============================================================
 * AgentTimelineView — Live only
 *   runtime 由 <NeoxRuntimeBridge> 装配, 这里直接消费 context.
 *   真实能力全接通, 不再做 demo fallback.
 * ============================================================ */
const AgentTimelineViewImpl: React.FC<Props> = ({
  onSubmit, cloudLocation, cloudMeta, onPullBackFromCloud, onTerminateCloud,
  surfacePanelCollapsed = true,
  projectChoices, onPickProject, onOpenProjectFolder,
}) => {
  const [projectMenuAt, setProjectMenuAt] = useState<DOMRect | null>(null);
  const runtime = useNeoxRuntime();
  const { isZh } = useI18n();
  const [timelineDensity] = useTimelineDensityPreference();
  const [timelineFontScale] = useTimelineFontScalePreference();
  const [timelineLineHeight] = useTimelineLineHeightPreference();
  const timelineEvents = useTimelineFeed();
  const [contextRailHidden, setContextRailHidden] = useContextRailHidden();
  const { shellRef, fits: contextRailFits } = useContextRailFit(surfacePanelCollapsed);
  const panelLayout = usePanelLayout();
  const activePanelTab = useActivePanelTab();
  const {
    activeSession,
    prependOlderTimelineEntries,
    streaming,
    turnStartedAt,
    sendPrompt,
    stopCurrent,
    paused,
    pendingApproval,
    answerApproval,
    canRetry,
    retryLast,
    continueLast,
    lastError,
    clearLastError,
    dismissTimelineEntry,
  } = runtime;

  const workspacePath = runtime?.workspacePath;

  useWorkspaceFsWatcher(workspacePath);

  /* 会话历史是否还在加载 —— 由 NeoxRuntimeBridge 在 initializeSessionTimeline 前后成对标记。
     只认"正在水合的正是当前会话", 快速连切时不会拿上一次的标记误判。 */
  const hydratingSessionId = useTimelineHydratingSessionId();


  /* 呈现口径只有 work / code 两种: Pilot 跟 Work 一样说人话 */
  const activeAgentMode = presentationMode(normalizeAgentMode((activeSession as { agentMode?: string } | null)?.agentMode
    ?? (typeof window !== 'undefined'
      ? (window as { __neoxDefaultAgentMode?: string }).__neoxDefaultAgentMode
      : undefined)));
  const feedSessionId = useTimelineFeedSessionId();
  const feedIsForActiveSession = !activeSession?.id || feedSessionId === activeSession.id;
  const eventsForActiveSession = feedIsForActiveSession ? timelineEvents : EMPTY_TIMELINE_EVENTS;

  const timelineEventsForFeed = useMemo(
    () => (eventsForActiveSession.some(isAnomalyEntry)
      ? eventsForActiveSession.filter((e) => !isAnomalyEntry(e))
      : eventsForActiveSession),
    [eventsForActiveSession],
  );
  const turnAnomalies = useMemo(
    () => pickCurrentTurnAnomalies(eventsForActiveSession),
    [eventsForActiveSession],
  );
  useEffect(() => {
    if (turnAnomalies.length === 0) cancelAutoRetry(activeSession?.id ?? null);
  }, [turnAnomalies, activeSession?.id]);
  /* 稳定引用 —— 每渲染新建一个箭头会让 dock 的排程 effect 每 250ms 重跑一次。 */
  const handleRetryAnomaly = useCallback(() => { void retryLast(); }, [retryLast]);
  const handleContinueAnomaly = useCallback(() => { void continueLast(); }, [continueLast]);

  const canContinueTurn = useMemo(() => {
    const anchor = eventsForActiveSession.map((e) => e.type).lastIndexOf('user_message');
    const inTurn = anchor >= 0 ? eventsForActiveSession.slice(anchor + 1) : eventsForActiveSession;
    return inTurn.some((e) => e.type === 'assistant_message'
      && typeof e.detail === 'string'
      && e.detail.trim().length >= 30);
  }, [eventsForActiveSession]);

  /* 传 sessionId: 换会话时 hook 会绕过 defer, 否则正文会继续显示上一个会话 (残影)。 */
  const deferredTimelineEvents = useTimelineEventsForMapping(timelineEventsForFeed, activeSession?.id ?? null);
  const items = useMemo<TimelineRow[]>(() => {
    return shellPerf.measure('timeline.mapTimelineEntries', () =>
      mapTimelineEntriesToRows(deferredTimelineEvents, workspacePath, { density: timelineDensity, sessionId: activeSession?.id ?? '', agentMode: activeAgentMode }),
      { sessionId: activeSession?.id ?? null, events: deferredTimelineEvents.length, density: timelineDensity },
    );
  }, [deferredTimelineEvents, workspacePath, timelineDensity, activeSession?.id, activeAgentMode]);
  const timelineIsVisible = panelLayout !== 'tabs' || activePanelTab === 'timeline';
  const contextRailVisible = timelineIsVisible && contextRailFits && !contextRailHidden && items.length > 0;


  const activeSid = activeSession?.id ?? null;

  /* 加载确实返回了空会话时要能落到空状态, 否则新建会话会永远停在骨架。
   * 判据: 标记已解除 (加载流程走完) 且这一会话从没见过内容 —— 那它就是真的空。 */
  const rawFeedHasEntries = timelineEventsForFeed.length > 0;

  const activeSessionHasMessages = !isBlankSession(
    activeSession as unknown as Parameters<typeof isBlankSession>[0],
  ) && !!activeSid;

  const hydrating = !!activeSid
    && items.length === 0
    && (rawFeedHasEntries || activeSessionHasMessages);

  /* 右栏 Task Detail 共用本次 map 结果 — 禁止第二份 mapTimelineEntries */
  useEffect(() => {
    const sid = activeSession?.id;
    if (!sid) {
      publishTimelinePanelSummary(null);
      return;
    }
    publishTimelinePanelSummary(buildTimelinePanelSummary(sid, items));
  }, [items, activeSession?.id]);

  /* 滚到顶回捞更早历史 — 防并发 + 到最早后不再打 DB. session 切换重置闸门. */
  const activeSessionId = activeSession?.id ?? null;
  const loadingOlderRef = useRef(false);
  const reachedStartRef = useRef(false);
  useEffect(() => {
    loadingOlderRef.current = false;
    reachedStartRef.current = false;
  }, [activeSessionId]);
  const handleReachTop = useCallback(async (): Promise<{
    loaded: number;
    reachedStart: boolean;
  }> => {
    if (!activeSessionId || loadingOlderRef.current || reachedStartRef.current) {
      return { loaded: 0, reachedStart: reachedStartRef.current };
    }
    loadingOlderRef.current = true;
    try {
      const res = await prependOlderTimelineEntries(activeSessionId);
      if (res.reachedStart) reachedStartRef.current = true;
      return res;
    } catch {
      return { loaded: 0, reachedStart: false };
    } finally {
      loadingOlderRef.current = false;
    }
  }, [activeSessionId, prependOlderTimelineEntries]);

  const waitingAskRaw = useMemo(
    () => findWaitingAskUser(eventsForActiveSession, isZh),
    [eventsForActiveSession, isZh],
  );
  const [askDockDismissedId, setAskDockDismissedId] = React.useState<string | null>(null);
  /* 「关掉提示」只对那一个 ask 生效, 不能跨会话残留 —— entry id 是稳定的
   * `ask-user-<requestId>`, 不清的话切走再回来那张卡还是被关着。 */
  React.useEffect(() => { setAskDockDismissedId(null); }, [activeSession?.id]);
  const waitingAsk = waitingAskRaw && waitingAskRaw.id !== askDockDismissedId ? waitingAskRaw : null;
  React.useEffect(() => {
    const id = waitingAsk && waitingAsk.questionCount <= 1 ? (waitingAsk.requestId || null) : null;
    setAskDockShown(id);
    return () => setAskDockShown(null);
  }, [waitingAsk]);
  const revealWaitingAsk = useCallback(() => {
    window.dispatchEvent(new CustomEvent('neox:timeline-reveal-blocking-ask', {
      detail: { id: waitingAsk?.id },
    }));
  }, [waitingAsk?.id]);
  /* 就地作答 —— 药丸面板里点选项 / 敲自由文本都走这里。
   * 多问题时只处理第一问 (面板只列第一问), 其余留给卡片; 单问是绝大多数场景。 */
  /* 走 useStableCallback 而不是 useCallback: 闭包链内存泄漏, 见 hooks/useStableCallback.ts */
  const answerWaitingAsk = useStableCallback(async (value: string) => {
    if (!waitingAsk || !value) return;
    const first = waitingAsk.questions?.[0]?.question;
    if (!first) return;
    const answers: Record<string, string> = { [first]: value };
    try {
      if (waitingAsk.requestId) {
        await runtime.answerAskUser(waitingAsk.requestId, answers);
      } else {
        await runtime.sendPrompt(`Q: ${first}\nA: ${value}`);
      }
    } catch {
      await runtime.sendPrompt(`Q: ${first}\nA: ${value}`);
    }
  });

  const rejectWaitingAsk = useStableCallback(async () => {
    if (!waitingAsk) return;
    const answers: Record<string, string> = {};
    for (const q of waitingAsk.questions ?? []) {
      if (q?.question) answers[q.question] = deferToAgentAnswer(isZh);
    }
    const text = Object.entries(answers).map(([q, a]) => `Q: ${q}\nA: ${a}`).join('\n\n');
    try {
      if (waitingAsk.requestId) {
        await runtime.answerAskUser(waitingAsk.requestId, answers);
      } else if (text) {
        await runtime.sendPrompt(text);
      }
    } catch {
      if (text) await runtime.sendPrompt(text);
    } finally {
      setAskDockDismissedId(waitingAsk.id);
    }
  });


  /* ── 输入框上方那一条药丸的数据源 ──────────────────────────────
   * 五个来源各自维护自己的订阅/计时器, 这里只把结果并成一个数组交给 DockRail。
   * 顺序无所谓 —— DockRail 自己按 (要处理 → 权重 → 最新) 排。
   * 2026-08 漏迁: Target 一直停在 composer 内的整宽横幅, 简约胶囊输入框上看不见。 */
  const bgTaskPills = useBackgroundTaskPills();
  const subAgentPills = useSubAgentPills();
  /* 用户对计划的修改 (Q-06): 本地先合并 (点下去立刻变), 再把一条大白话指令送给 agent。
   * 运行中走插话 (排到下一个 iteration gap, 不打断当前工具); 空闲时当一条正常用户消息发。
   * 有意**不硬改引擎里的计划数据**: 计划是模型的意图声明, 该用指令纠正 (harness-core 裁决)。 */
  const handlePlanEdit = useCallback((edit: PlanUserEdit, step: { content?: string }) => {
    const sid = activeSession?.id;
    if (!sid) return;
    const record = notePlanEdit(sid, edit, step.content ?? '');
    const directive = buildPlanEditDirective(record, isZh);
    if (streaming) {
      void (window as any).neox?.injectMessage?.({
        sessionId: sid,
        message: directive,
        transport: cloudLocation === 'cloud' ? 'cloud' : 'local',
        when: 'turn-end',
      })?.catch?.(() => undefined);
      return;
    }
    void sendPrompt(directive);
  }, [activeSession?.id, isZh, streaming, cloudLocation, sendPrompt]);
  const planPill = usePlanPill(timelineEvents as any, streaming, {
    sessionId: activeSession?.id ?? null,
    onEditPlan: handlePlanEdit,
  });
  /* 中断后的「继续这一轮」入口 (Q-21) —— 只认用户按停止那一种, 从计划的第一步没做完的接着跑 */
  const resumePill = useResumePill({
    timeline: timelineEvents as any,
    running: streaming,
    sessionId: activeSession?.id ?? null,
    onResume: handleContinueAnomaly,
  });
  const reviewPillRaw = useTurnReviewPill({ timeline: timelineEvents as any, streaming });
  const isPilotSession = normalizeAgentMode((activeSession as { agentMode?: string } | null)?.agentMode) === 'pilot';
  const reviewPill = isPilotSession ? null : reviewPillRaw;
  const [composerStyle] = useComposerStylePreference();
  const targetPillRaw = useTargetPill(activeSessionId);
  /* 团队药丸独立于目标药丸 —— 团队会话里显示的必须是"团队", 而且它有自己的三阶段 */
  const teamPill = useTeamPill(activeSessionId);
  /* 简约胶囊: 目标走 Dock 药丸。标准输入框仍用 composer 内 TargetInlineBanner, 避免双份。
   * 例外: 团队会话 —— 横幅那边已经 return null, 这里无论哪种输入框都走药丸 (一行、窄、点开才展开)。 */
  const targetPill = composerStyle === 'minimal' ? targetPillRaw : null;
  const askPill = useMemo<DockPill | null>(() => {
    if (!waitingAsk) return null;
    const count = waitingAsk.questionCount > 1
      ? (isZh ? `${waitingAsk.questionCount} 个问题` : `${waitingAsk.questionCount} questions`)
      : (isZh ? `${waitingAsk.optionCount || 0} 个选项` : `${waitingAsk.optionCount || 0} options`);
    const q = (waitingAsk.question || '').replace(/\s+/g, ' ').trim();
    const qShort = q.length > 12 ? `${q.slice(0, 11)}…` : q;
    return {
      id: `ask:${waitingAsk.id}`,
      tone: 'attention',
      icon: <AskPillIcon />,
      label: qShort || (isZh ? 'Agent 在问你' : 'Agent is asking'),
      meta: waitingAsk.questionCount > 1 ? count : undefined,
      weight: 10,
      attention: true,
      autoOpenPanel: true,
      /* 选项卡摊在胶囊下面, 不做成点外面就关的浮层 */
      panelInline: true,
      updatedAt: Date.now(),
      ariaLabel: [isZh ? '等你选择' : 'Your choice', waitingAsk.question].filter(Boolean).join(' · '),
      panel: (
        <div className="nx-dock__ask">
          <div className="nx-dock__ask-eyebrow">
            <span className="nx-dock__ask-dot" aria-hidden="true" />
            {isZh ? 'Agent 需要你拿个主意' : 'Agent needs your call'}
            {waitingAsk.questionCount > 1 && (
              <span className="nx-dock__ask-count">{isZh ? `共 ${waitingAsk.questionCount} 问` : `${waitingAsk.questionCount} questions`}</span>
            )}
          </div>
          <div className="nx-dock__ask-q">{waitingAsk.question}</div>
          {(waitingAsk.questions?.[0]?.options ?? []).length > 0 && (
            <div className="nx-dock__ask-opts" role="list">
              {(waitingAsk.questions[0].options as any[]).map((o: any, i: number) => (
                <button
                  key={i}
                  type="button"
                  role="listitem"
                  className="nx-dock__ask-opt"
                  onClick={() => void answerWaitingAsk(String(o?.label ?? ''))}
                >
                  <span className="nx-dock__ask-radio" aria-hidden="true" />
                  <span className="nx-dock__ask-opt-text">
                    <span className="nx-dock__ask-opt-label">{String(o?.label ?? '')}</span>
                    {o?.description && <span className="nx-dock__ask-opt-desc">{String(o.description)}</span>}
                  </span>
                </button>
              ))}
            </div>
          )}
          <form
            className="nx-dock__ask-freebox"
            onSubmit={(e) => {
              e.preventDefault();
              const el = (e.currentTarget.elements.namedItem('free') as HTMLInputElement | null);
              const v = el?.value.trim();
              if (v) void answerWaitingAsk(v);
            }}
          >
            <input
              name="free"
              type="text"
              className="nx-dock__ask-free"
              placeholder={isZh ? '都不是? 直接说你的想法' : 'None of these? Say what you want'}
            />
            <button type="submit" className="nx-dock__ask-send" aria-label={isZh ? '提交' : 'Send'}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 13V3M8 3L3.5 7.5M8 3l4.5 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
          </form>
          <div className="nx-dock__ask-acts">
            <button type="button" className="nx-dock__ask-btn" onClick={() => void rejectWaitingAsk()}>
              {isZh ? '让 AI 自己决定' : 'Let AI decide'}
            </button>
            {waitingAsk.questionCount > 1 && (
              <button type="button" className="nx-dock__ask-btn" onClick={revealWaitingAsk}>
                {isZh ? '在对话里逐个答' : 'Answer all in chat'}
              </button>
            )}
            <span className="nx-dock__ask-spacer" />
            <button type="button" className="nx-dock__ask-btn is-quiet" onClick={() => setAskDockDismissedId(waitingAsk.id)}>
              {isZh ? '稍后' : 'Later'}
            </button>
          </div>
        </div>
      ),
    };
  }, [waitingAsk, isZh, revealWaitingAsk, rejectWaitingAsk, answerWaitingAsk]);

  const billingPill = useBillingPill();

  const dockPills = useMemo(
    () => [askPill, teamPill, reviewPill, resumePill, targetPill, planPill, billingPill, ...subAgentPills, ...bgTaskPills].filter(Boolean) as NonNullable<typeof planPill>[],
    [askPill, teamPill, reviewPill, resumePill, targetPill, planPill, billingPill, subAgentPills, bgTaskPills],
  );

  const onTimelineProfilerRender = useCallback<React.ProfilerOnRenderCallback>(
    (id, phase, actualDuration, baseDuration, startTime, commitTime) => {
      if (actualDuration < 8 && baseDuration < 40) return;
      shellPerf.mark('react-profiler', {
        id,
        phase,
        actualMs: Math.round(actualDuration * 10) / 10,
        baseMs: Math.round(baseDuration * 10) / 10,
        startTime: Math.round(startTime * 10) / 10,
        commitTime: Math.round(commitTime * 10) / 10,
        sessionId: activeSession?.id ?? null,
        events: timelineEvents.length,
        items: items.length,
        streaming,
      });
    },
    [activeSession?.id, items.length, streaming, timelineEvents.length],
  );

  const title = activeSession?.name?.trim() || (isZh ? '新会话' : 'New chat');
  const modeVariant = useAgentModeVariant();
  const railShown = false && contextRailVisible && !modeVariant.isPilot;
  const projectName = workspacePath ? displayWorkspaceName(workspacePath, null, isZh) : '';
  /* Code 空态: Cursor 式居中输入; Life/Work / 有消息时保持原布局 */
       const rawCodeEmptyFocus = items.length === 0 && !hydrating && turnAnomalies.length === 0
           && !activeSessionHasMessages;
  const activeSessionKey = activeSession?.id ?? null;
  const emptyLatchRef = useRef<EmptyFocusLatchState | null>(null);
  if (emptyLatchRef.current === null) emptyLatchRef.current = createEmptyFocusLatch(activeSessionKey);
  const codeEmptyFocus = stepEmptyFocusLatch(emptyLatchRef.current, activeSessionKey, rawCodeEmptyFocus);
  /* 居中 → 落底 那一次做 FLIP 位移动画; 居中态的定位也由它负责 (量占位元素) */
  const composerSlotRef = useComposerFlip(codeEmptyFocus);

  /* 宠物替用户留意: 等批准 / 等回答 / 出错 / 长回合跑完, 点它就带到要处理的地方 */
  const [runDone, clearRunDone] = useRunDoneNotice(streaming, turnStartedAt, activeSession?.id ?? null);
  /* Work: 一轮做完 agent 没把成品摆出来时, 右栏自动打开它 (见 hooks/useAutoOpenDeliverable) */
  useAutoOpenDeliverable({
    enabled: modeVariant.isWork,
    sessionId: activeSession?.id ?? null,
    entries: timelineEventsForFeed,
    workspacePath: workspacePath || undefined,
    streaming,
  });
  const mascotSignal = useMemo(() => pickMascotSignal({
    streaming,
    approvalId: pendingApproval?.requestId ?? null,
    askId: waitingAsk?.id ?? null,
    errorKey: lastError ? `${lastError.code ?? ''}:${lastError.message}` : null,
    errorText: lastError ? errorSignalText(lastError, isZh) : undefined,
    done: runDone,
    zh: isZh,
  }), [streaming, pendingApproval?.requestId, waitingAsk?.id, lastError, runDone, isZh]);
  const mascotMood = useMemo(() => deriveMascotMood({
    streaming,
    waiting: Boolean(pendingApproval || waitingAsk),
    error: Boolean(lastError),
    events: eventsForActiveSession as Parameters<typeof deriveMascotMood>[0]['events'],
  }), [streaming, pendingApproval, waitingAsk, lastError, eventsForActiveSession]);
  const mascotFlinchKey = useMemo(
    () => (streaming ? lastToolFailureId(eventsForActiveSession as Parameters<typeof lastToolFailureId>[0]) : null),
    [streaming, eventsForActiveSession],
  );
  const mascotActivity = useMemo(
    () => (streaming ? currentActivity(eventsForActiveSession as Array<{ pending?: boolean; title?: string; type?: string }>) : null),
    [streaming, eventsForActiveSession],
  );
  const onMascotSignal = useCallback((kind: MascotSignalKind) => {
    const slot = composerSlotRef.current;
    if (kind === 'approval') {
      const target = slot?.querySelector<HTMLElement>('.atl-approve-dock button');
      target?.scrollIntoView({ block: 'nearest' });
      target?.focus();
      return;
    }
    if (kind === 'done') clearRunDone();
    slot?.querySelector<HTMLElement>('textarea, [contenteditable="true"]')?.focus();
  }, [composerSlotRef, clearRunDone]);

  /**
   * 优先走外部 onSubmit (NeoxShellHost 在那里 set activeNav + 调 runtime.sendPrompt),
   * 没有 onSubmit 才走本地 sendPrompt. 之前两个都调, 导致 runtime.sendPrompt() 执行
   * 两次, 用户消息被 append 两次.
   */
  const handleSubmit = (prompt: string) => {
    if (onSubmit) {
      onSubmit(prompt);
    } else {
      void sendPrompt(prompt);
    }
  };

  const composer = (
    <TimelineComposer
      onSubmit={handleSubmit}
      heroCard={codeEmptyFocus}
      placeholderOverride={
        /* Work 首屏也用它自己那句白话 (「要改稿、整理数据…」), 不说「/ 技能、@ 引用上下文」 */
        codeEmptyFocus && !modeVariant.isWork
          ? (isZh ? '描述任务，或 / 技能、@ 引用上下文…' : 'Describe a task, or / skills, @ context…')
          : codeEmptyFocus && modeVariant.isWork
            ? (PPTX_AVAILABLE
              ? (isZh ? '描述你要的成品，例如：把这份表做成汇报 PPT…' : 'Describe what you need, e.g. turn this sheet into a deck…')
              : (isZh ? '描述你要的成品，例如：把这份表整理成一份分析报告…' : 'Describe what you need, e.g. turn this sheet into a report…'))
            : undefined
      }
      onInject={(prompt, images, opts) => {
        /* 运行中插话: 排队到正在跑的 session, server 在合适的 iteration gap 自然处理。 */
        const sid = activeSession?.id;
        if (!sid) return;
        const transport = cloudLocation === 'cloud' ? 'cloud' : 'local';

        if (opts?.when === 'turn-end') {
          void (async () => {
            let r: { queued?: boolean; reason?: string } | undefined;
            try {
              r = await (window as any).neox?.injectMessage?.({ sessionId: sid, message: prompt, images, transport, when: 'turn-end' });
            } catch (err) {
              console.warn('[AgentTimelineView] injectMessage(turn-end) threw:', err);
            }
            if (r?.queued === true) return;
            if (r?.queued === false && (r.reason === 'host_idle' || r.reason === 'no_host_for_session')) {
              return;
            }
            if (r?.queued === false) {
              /* 本轮正在被停 / 已中断: 不自动续发, 退回输入框由用户决定 */
              window.dispatchEvent(new CustomEvent('neox:queued-message-rejected', {
                detail: { sessionId: sid, text: prompt, images },
              }));
              return;
            }
            dispatchOpFailed({
              op: '排队消息',
              message: '未收到排队确认，消息可能已经排上。请留意本轮结束后是否发出；系统不会自动重复发送。',
            });
          })();
          return;
        }

        const optimisticId = newOptimisticInjectId();
        emitOptimisticInject({ sessionId: sid, entryId: optimisticId, text: prompt });
        const dropOptimistic = (): void => emitOptimisticInjectDrop(sid, optimisticId);

        void (async () => {
          // Only explicit rejection restores the draft. Unknown delivery must not replay it.
          let queued: boolean | undefined;
          try {
            const r = await (window as any).neox?.injectMessage?.({ sessionId: sid, message: prompt, images, transport });
            queued = typeof r?.queued === 'boolean' ? r.queued : undefined;
          } catch (err) {
            console.warn('[AgentTimelineView] injectMessage threw:', err);
          }
          if (queued) {
            void (window as any).neox?.steerSession?.({ sessionId: sid, transport }).catch?.(() => undefined);
          }
          if (queued === undefined) {
            dispatchOpFailed({
              op: '排队插话',
              message: '未收到排队确认，消息可能已经送达。请先查看当前会话；系统不会自动重复发送。',
            });
            return;
          }
          if (queued === false) {
            // Explicit rejection returns the draft; it never starts a second run.
            dropOptimistic();
            dispatchOpFailed({
              op: '排队插话',
              message: '这条消息未排入当前任务，文字和图片已退回原会话。',
            });
            window.dispatchEvent(new CustomEvent('neox:queued-message-rejected', {
              detail: { sessionId: sid, text: prompt, images },
            }));
          }
        })();
      }}
      onSteer={(items) => {
        const sid = activeSession?.id;
        if (!sid) return;
        const transport = cloudLocation === 'cloud' ? 'cloud' : 'local';
        if (!streaming) {
          void (async () => {
            for (const it of items) {
              try { await (window as any).neox?.dequeueLastQueued?.({ sessionId: sid, transport, text: it.text }); }
              catch { /* 没有残留 */ }
            }
            const text = items.map((it) => it.text).filter(Boolean).join('\n');
            const images = items.flatMap((it) => it.images ?? []);
            void sendPrompt(text, images.length > 0 ? { images } : undefined);
          })();
          return;
        }
        for (const it of items) {
          emitOptimisticInject({ sessionId: sid, entryId: newOptimisticInjectId(), text: it.text });
        }
        void (window as any).neox?.steerSession?.({ sessionId: sid, transport }).catch?.(() => undefined);
      }}
      onCancelQueued={async (text) => {
        /* 取消排队消息: 从 server 队列摘掉**这一条**。
         * **必须把摘到的文本返回去** —— composer 靠它判断"引擎是不是已经消费了这条":
         * 摘到了才允许退回输入框, 摘不到说明消息已在路上, 退回就会重复。 */
        const sid = activeSession?.id;
        if (!sid) return null;
        const transport = cloudLocation === 'cloud' ? 'cloud' : 'local';
        try {
          return (await (window as any).neox?.dequeueLastQueued?.({ sessionId: sid, transport, text })) ?? null;
        } catch { return null; }
      }}
      cloudReadonly={cloudLocation === 'migrating' || cloudLocation === 'syncing-back'}
      /* 异常区放在 composer 内部 (跟输入框同宽同边界), 数据仍来自 timeline store。 */
      anomalies={turnAnomalies}
      onDismissAnomaly={(entryId) => {
        const sid = activeSession?.id;
        if (!sid) return;
        void dismissTimelineEntry?.(sid, entryId);
      }}
      onRetryAnomaly={handleRetryAnomaly}
      /* 有断点就把主动作换成「继续」—— 自动重试也走这条 (续写永远比重来划算)。 */
      onContinueAnomaly={handleContinueAnomaly}
      canContinueAnomaly={canContinueTurn}
    />
  );

  const dockStack = (
    <>
      {(activeSession as { kind?: string } | null)?.kind !== 'image' && (
        <DirectImageTurns sessionId={activeSession?.id} zh={isZh} />
      )}
      <DockRail pills={dockPills} />
      {lastError && (
        <div className="atl-approve-dock">
          <div
            className="atl-error-banner"
            title={
              (lastError.code ? `[${lastError.code}] ` : '') +
              lastError.message +
              (lastError.raw ? `\n\n上游原文: ${lastError.raw}` : '')
            }
          >
            <span className="atl-error-banner__icon" aria-hidden>⚠</span>
            {lastError.code && <strong className="atl-error-banner__code">{lastError.code}</strong>}
            <span className="atl-error-banner__msg">
              {lastError.message}
              {lastError.suggestion && (
                <span className="atl-error-banner__hint"> · {lastError.suggestion}</span>
              )}
            </span>
            {canRetry && (
              <button
                type="button"
                className="atl-error-banner__action"
                onClick={() => void retryLast()}
                title={isZh ? "重新发送上一条" : "Resend previous message"}
              >
                {isZh ? "重试" : "Retry"}
              </button>
            )}
            <button
              type="button"
              className="atl-error-banner__close"
              onClick={() => clearLastError()}
              aria-label={isZh ? "关闭" : "Close"}
            >×</button>
          </div>
        </div>
      )}
      {pendingApproval && (
        <div className="atl-approve-dock">
          <ApprovalBanner
            request={pendingApproval}
            onReply={(approved, remember) =>
              answerApproval(pendingApproval.requestId, approved, remember)
            }
          />
        </div>
      )}
      {(cloudLocation === 'migrating' || cloudLocation === 'syncing-back') && (
        <div className="atl-approve-dock">
          <div className="atl-readonly-banner" role="status" aria-live="polite">
            <span className="atl-readonly-banner__spinner" aria-hidden>⟳</span>
            <span className="atl-readonly-banner__msg">
              {cloudLocation === 'migrating'
                ? (isZh ? '正在迁移到云端, 此期间无法发送消息…' : 'Migrating to cloud; messages are disabled for now…')
                : (isZh ? '正在拉回本地, 此期间无法发送消息…' : 'Pulling back locally; messages are disabled for now…')}
            </span>
          </div>
        </div>
      )}
    </>
  );

  /* Work 任务文件夹胶囊: 文件夹建好了 (首条消息发出后) 才有, 空态不出 */
  const taskDir = (activeSession as { taskDir?: string | null } | null)?.taskDir;
  const workFolder = modeVariant.isWork && !codeEmptyFocus && taskDir && !/[\\/]$/.test(taskDir) ? taskDir : null;

  return (
    <div ref={shellRef} className={`atl-shell${railShown ? ' has-context-rail' : ''}`}>
    <div
      className={`agent-timeline is-density-${timelineDensity}${codeEmptyFocus ? ' agent-timeline--empty-focus' : ''}${modeVariant.isWork ? ' agent-timeline--work' : ''}${modeVariant.isCode ? ' agent-timeline--code' : ''}${workFolder ? ' has-work-folder' : ''}`}
      /* 字号 / 行距缩放只作用于对话区 — --nx-fs-scale 挂这里;
         --neox-fs-* token 会在 agent-timeline.css 里按本节点 scale 重新绑定。 */
      style={{
        '--nx-fs-scale': timelineFontScale,
        '--nx-lh-scale': timelineLineHeight,
      } as React.CSSProperties}
    >
      <TimelineHeader
        title={title}
        turnStartedAt={turnStartedAt}
        running={streaming}
        paused={paused}
        onStop={() => void stopCurrent()}
        workspacePath={activeSession?.workspacePath}
        cloudLocation={cloudLocation}
        sessionId={activeSession?.id}
        agentMode={activeSession?.agentMode}
      />
      {workFolder && <WorkFolderPill dir={workFolder} running={streaming} zh={isZh} />}
      {cloudLocation && cloudLocation !== 'local' && cloudLocation !== 'cloud' && (
        <CloudSessionBanner
          state={cloudLocation}
          podId={cloudMeta?.podId}
          fileCount={cloudMeta?.fileCount}
          lastActiveAt={cloudMeta?.lastActiveAt}
          sessionState={cloudMeta?.sessionState}
          onPullBack={onPullBackFromCloud}
          onTerminate={onTerminateCloud}
        />
      )}
      {codeEmptyFocus ? (
        <div className="atl-empty-stage">
          {/* Pilot: 舞台头上已经有它本人 (名字 / 形象 / 分工), 这里不再放问候语和第二只宠物 */}
          {modeVariant.isPilot
            ? <p className="atl-pilot-empty">{isZh ? '直接跟它说，或者点右上角「通话」。' : 'Just talk to it, or tap Call in the corner.'}</p>
            : <CodeEmptyTop
                isZh={isZh}
                projectName={modeVariant.isWork ? '' : projectName}
                onPickProject={onPickProject ? setProjectMenuAt : undefined}
              />}
          {projectMenuAt && onPickProject && (
            <ProjectPicker
              anchor={projectMenuAt}
              title={isZh ? '换到哪个项目' : 'Switch project'}
              projects={[...(workspacePath ? [{ path: workspacePath }] : []), ...(projectChoices ?? [])]}
              currentPath={workspacePath}
              isZh={isZh}
              onPick={(p) => { setProjectMenuAt(null); onPickProject(p); }}
              onOpenFolder={onOpenProjectFolder ? () => { setProjectMenuAt(null); onOpenProjectFolder(); } : undefined}
              onClose={() => setProjectMenuAt(null)}
            />
          )}
          {/* 包一层只为给 FLIP 一个可 transform 的挂点 —— 落底态是 .atl-bottom-float,
              两边挂同一个 ref, 同时只有一个存在。列宽规则跟着搬到这层, 见 css。 */}
          <div className="atl-empty-composer" ref={composerSlotRef}>
            {!modeVariant.isPilot && <Mascot
              className="atl-empty-mascot"
              composerRef={composerSlotRef}
              size={150}
              busy={streaming}
              signal={mascotSignal}
              onSignal={onMascotSignal}
              busySince={turnStartedAt}
              activity={mascotActivity}
              mood={mascotMood}
              flinchKey={mascotFlinchKey}
            />}
            {dockStack}
            {composer}
          </div>
          {(modeVariant.isWork || modeVariant.isCode) && !streaming && <WorkStarters isZh={isZh} mode={modeVariant.isCode ? 'code' : 'work'} />}
          {/* 成品架入口 (UI 3.0 设计稿首页右下角): 所有会话做出来的东西都在那 */}
          {!modeVariant.isPilot && <ShelfButton isZh={isZh} />}
          {/* 「继续之前的工作」已移除 —— 左侧栏本来就按项目/时间列着同一批会话,
            * 首屏再列一遍是同一份数据出现两次, 还把输入框往上挤。 */}
        </div>
      ) : (
        <>
          {items.length > 0 ? (
            <React.Profiler id="AgentTimelineView.TimelineSteps" onRender={onTimelineProfilerRender}>
            <TimelineSteps
              key={activeSession?.id ?? 'none'}
              items={items}
              paused={paused}
              sessionId={activeSession?.id ?? null}
              density={timelineDensity}
              sessionStreaming={streaming}
              onReachTop={handleReachTop}
            />
            </React.Profiler>
          ) : hydrating ? (
            <TimelineSkeleton />
          ) : (
            <EmptyState streaming={streaming} hasSession={!!activeSession} />
          )}
          {/* 真悬浮: 只让输入框 / 待审条等 chrome 浮在 feed 上, 外层不再占不透明底栏 */}
          <div className="atl-bottom-float" ref={composerSlotRef}>
            {!modeVariant.isPilot && <Mascot
              className="atl-bottom-mascot"
              composerRef={composerSlotRef}
              size={124}
              busy={streaming}
              signal={mascotSignal}
              onSignal={onMascotSignal}
              busySince={turnStartedAt}
              activity={mascotActivity}
              mood={mascotMood}
              flinchKey={mascotFlinchKey}
            />}
            {dockStack}
            {composer}
          </div>
        </>
      )}
    </div>
    {/* entries 必须是**当前会话那一条流** —— feedIsForActiveSession 已经把"feed 还压着
        上一个会话"的残影挡掉了, 右栏「产物」节靠它回放 WriteDeclaration
        (不从 fs 事件猜"谁写了什么", 见 hooks/useRecentArtifacts.ts)。 */}
    {/* Pilot 是 IM 形态, 右边的工作台看板取代这条上下文栏 */}
    {railShown ? <AgentTimelineContextRail entries={eventsForActiveSession} /> : null}
    {timelineIsVisible && contextRailFits && contextRailHidden ? (
      <button
        type="button"
        className="atl-ctx-reveal"
        onClick={() => setContextRailHidden(false)}
        title={isZh ? '显示上下文栏' : 'Show context rail'}
        aria-label={isZh ? '显示上下文栏' : 'Show context rail'}
      >
        <span className="atl-ctx-reveal__chev" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor"
            strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="12 3.5 7.5 8 12 12.5" />
            <polyline points="7 3.5 2.5 8 7 12.5" />
          </svg>
        </span>
      </button>
    ) : null}
    </div>
  );
};

const EmptyState: React.FC<{ streaming: boolean; hasSession: boolean }> = ({ streaming }) => {
  const runtime = useNeoxRuntime();
  const { isZh } = useI18n();
  const modeVariant = useAgentModeVariant();
  const workspacePath = runtime?.workspacePath ?? '';
  const projectName = workspacePath ? displayWorkspaceName(workspacePath, null, isZh) : '';

  const headline = streaming
    ? (isZh ? '正在启动…' : 'Starting…')
    : (modeVariant.emptyHeadline
      ?? (projectName ? undefined : (isZh ? '开始一个新任务' : 'Start a new task')));
  const subtitle = streaming
    ? (isZh ? '正在规划, 很快开始' : 'Planning; starting soon…')
    : (modeVariant.emptySubtitle
      ?? (isZh ? '描述你想做的事, Agentic 会自动规划、调用工具、一步步完成 —— 全过程实时展示在这里' : 'Describe what you want. Agentic will plan, call tools, and complete it step by step — all live here'));

  return (
    <div className="atl-empty">
      <div className="atl-empty__hero">
        {!modeVariant.hideMascot && (
          <span className="atl-empty__mark" aria-hidden>
            <BrandMarkImg />
          </span>
        )}
        <h2 className="atl-empty__h">
          {headline ?? (projectName
            ? <>{isZh ? '开始' : 'Start'} · <span className="atl-empty__h-accent">{projectName}</span></>
            : (isZh ? '开始一个新任务' : 'Start a new task'))}
        </h2>
        <p className="atl-empty__p">{subtitle}</p>
      </div>
    </div>
  );
};



/* askUser 药丸图标 —— 问号气泡, 跟其它药丸的线性风格一致 */
const AskPillIcon = (): React.ReactElement => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden>
    <path d="M13.5 8.6c0 2.5-2.4 4.5-5.5 4.5-.7 0-1.3-.1-1.9-.3L3 13.8l.8-2.3C3 10.7 2.5 9.7 2.5 8.6 2.5 6.1 4.9 4 8 4s5.5 2.1 5.5 4.6Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    <path d="M6.9 7.4c0-.7.5-1.2 1.2-1.2s1.2.5 1.2 1.1c0 .8-1.1.9-1.1 1.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    <circle cx="8.1" cy="10.6" r=".6" fill="currentColor" />
  </svg>
);

export const AgentTimelineView = React.memo(AgentTimelineViewImpl);

export default AgentTimelineView;
