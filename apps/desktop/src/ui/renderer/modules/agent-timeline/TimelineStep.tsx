import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { dispatchOpFailedFromError } from '../../components/notifyEvents';

import { useNeoxRuntimeOptional } from '../../app/NeoxRuntimeContext';
import { useCountUp } from './hooks/useCountUp';
import { useI18n } from '../../hooks/useI18n';
import { useSurfaces } from '../../state/surfaceStore';
import { StepContentRenderer } from './cells/StepContentRenderer';
import { OpChipUndoButton } from './cells/OpChipView';
import { HistoryCellRenderer } from './cells/HistoryCellRenderer';
import { CompactionView } from './cells/CompactionView';
import { TargetContinueView } from './cells/TargetContinueView';
import type { TimelineStep as StepT } from './types';
import { getStepIconInfo } from './stepIcons';
import { buildHistoryCellFromStep } from './mapTimelineToRows';
import { useAskDockShown } from './askDockPresence';
import { isTimelineDebugEnabled, logTimelineJank } from './timelineDebug';
import { LiveShimmerText } from './components/LiveShimmerText';
import { DotSpinner } from '../../components/DotSpinner';

/* 从 ms → "3s" / "1m 12s" 的紧凑时长显示, 供 running 实时 elapsed 使用 */
function formatElapsedMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs === 0 ? `${m}m` : `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm === 0 ? `${h}h` : `${h}h ${rm}m`;
}
const TOOL_CONTENT_EXIT_MS = 360;
const TIMELINE_LAYOUT_TRANSITION_MS = 480;

function stepContentType(step: StepT): string {
  return step.content?.type ?? 'none';
}

function shouldDebugStepJank(step: StepT): boolean {
  const haystack = `${step.title} ${step.iconKind} ${stepContentType(step)}`;
  return /edit|diff|patch/i.test(haystack);
}

function shouldPreserveCompletedExpanded(step: StepT, expanded: boolean): boolean {
  if (!expanded) return false;
  if (step.status === 'running' || step.status === 'pending' || step.status === 'awaiting') {
    return false;
  }
  const type = step.content?.type;
  return (
    type === 'diff' ||
    type === 'turn_summary' ||
    type === 'askUser' ||
    type === 'error' ||
    type === 'deep_research' ||
    type === 'compaction'
  );
}

function stepJankPayload(step: StepT, extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: step.id,
    title: step.title,
    status: step.status,
    iconKind: step.iconKind,
    contentType: stepContentType(step),
    defaultExpanded: !!step.defaultExpanded,
    presentationPhase: step.presentation?.phase,
    presentationVisibility: step.presentation?.visibility,
    presentationDefaultExpanded: step.presentation?.defaultExpanded,
    ...extra,
  };
}

/** 工具卡标题简化: "Readfile · .../requirement/detail.vue" → "Readfile · detail.vue" */
function shortenToolTitle(title: string): string {
  const sep = title.indexOf(' · ');
  if (sep < 0) return title;
  const action = title.slice(0, sep);
  const path = title.slice(sep + 3);
  const fileName = path.split(/[\\/]/).pop() || path;
  return `${action} · ${fileName}`;
}

const USER_TOGGLED_EXPANDED = new Map<string, boolean>();
const USER_TOGGLED_MAX = 2000;
function rememberUserToggle(id: string, expanded: boolean): void {
  if (!id) return;
  if (USER_TOGGLED_EXPANDED.size >= USER_TOGGLED_MAX) USER_TOGGLED_EXPANDED.clear();
  USER_TOGGLED_EXPANDED.set(id, expanded);
}

const TIMELINE_SCROLL_GUARD_KEY = "__neoxTimelineUserScrollGuardUntil";
type TimelineGuardWindow = Window & { [TIMELINE_SCROLL_GUARD_KEY]?: number };

function isTimelineUserScrollGuardActive(): boolean {
  if (typeof window === 'undefined' || typeof performance === 'undefined') return false;
  return performance.now() < ((window as TimelineGuardWindow)[TIMELINE_SCROLL_GUARD_KEY] ?? 0);
}


function notifyTimelineLayoutTransition(source = 'tool', durationMs = TIMELINE_LAYOUT_TRANSITION_MS): void {
  if (typeof window === 'undefined') return;
  // 滚动/拖动期间不做锚点修正。工具卡、Plan、本轮改动的动态高度
  // 会被主 timeline 自己布局；此时再主动写 scrollTop 会造成肉眼可见的回弹。
  // 但仍然广播 transition 语义，让父 timeline 冻结测高采样，避免虚拟高度采到动画中间态。
  window.dispatchEvent(new CustomEvent('neox:timeline-layout-transition', {
    detail: { source, durationMs }
  }));
}

interface StepProps {
  step: StepT;
  /** 放在 parallel group 里? 调整阴影/背景 */
  inGroup?: boolean;
  /** Actions 聚合列表里的二级工具：使用更慢的 settle，避免工具刚完成就硬折叠。 */
  activityChild?: boolean;
  /** ActivityChildRow 已经渲染了自己的 header；展开详情只渲染内容，避免 askUser 这类工具出现双 header。 */
  contentOnly?: boolean;
}

/* 仅 running / failed / pending / awaiting 需要显式 badge, done 是默认态不挂 pill.
 * awaiting (等待审批) 跟 running (工具真在跑) 分开 — 用户能看出 "agent 在等我点同意"
 * 而不是误以为 "工具卡死了". */
function getStatusBadge(isZh: boolean): Partial<Record<StepT['status'], { text: string; cls: string }>> {
  return isZh
    ? {
        running:  { text: '运行中',   cls: 'is-running'  },
        awaiting: { text: '等待审批', cls: 'is-awaiting' },
        interrupted: { text: '已中断', cls: 'is-interrupted' },
        failed:   { text: '失败',     cls: 'is-failed'   },
        pending:  { text: '等待',     cls: 'is-pending'  },
      }
    : {
        running:  { text: 'Running',   cls: 'is-running'  },
        awaiting: { text: 'Awaiting approval', cls: 'is-awaiting' },
        interrupted: { text: 'Interrupted', cls: 'is-interrupted' },
        failed:   { text: 'Failed',    cls: 'is-failed'   },
        pending:  { text: 'Pending',   cls: 'is-pending'  },
      };
}

/* ============================================================
 * Tool Row
 * ============================================================ */

function areTimelineStepPropsEqual(prev: StepProps, next: StepProps): boolean {
  if (prev.inGroup !== next.inGroup) return false;
  if (prev.activityChild !== next.activityChild) return false;
  if (prev.contentOnly !== next.contentOnly) return false;
  const a = prev.step;
  const b = next.step;
  if (a === b) return true;
  if (!a || !b) return false;
  // 关键 UI 字段: id / status / title / description / duration / content ref / presentation ref
  if (a.id !== b.id) return false;
  if (a.status !== b.status) return false;
  if (a.title !== b.title) return false;
  if ((a as any).description !== (b as any).description) return false;
  if ((a as any).duration !== (b as any).duration) return false;
  if ((a as any).startedAtMs !== (b as any).startedAtMs) return false;
  if ((a as any).defaultExpanded !== (b as any).defaultExpanded) return false;
  if (a.content !== b.content) return false;              // 引用相同 = 内容未变
  if ((a as any).presentation !== (b as any).presentation) return false;
  if ((a as any).iconKind !== (b as any).iconKind) return false;
  return true;
}

const TimelineStepImpl: React.FC<StepProps> = ({ step, inGroup = false, activityChild = false, contentOnly = false }) => {
  const { isZh } = useI18n();
  const diffStreaming = (step.content as any)?.type === 'diff'
    && ((step.content as any).streaming === true || step.status === 'running');
  const liveAdd = useCountUp(step.diffStat?.add ?? 0, diffStreaming);
  const liveDel = useCountUp(step.diffStat?.del ?? 0, diffStreaming);
  const diffStatNode = !step.diffStat ? null : step.status === 'failed' ? (
    <span
      className="atl-tool__diffstat is-void"
      title={isZh ? '这次编辑失败了，文件未被修改' : 'This edit failed; the file was not modified'}
    >
      {isZh ? '未写入' : 'not written'}
    </span>
  ) : (
    <span className={`atl-tool__diffstat${diffStreaming ? ' is-writing' : ''}`}>
      <span className="atl-tool__diffstat-add">+{diffStreaming ? liveAdd : step.diffStat.add}</span>
      <span className="atl-tool__diffstat-del">−{diffStreaming ? liveDel : step.diffStat.del}</span>
    </span>
  );
  const isAwaitingAskUser = step.status !== 'interrupted' && step.content?.type === 'askUser' && step.content.status === 'waiting';
  /* activityChild + awaiting(审批中): 不展开空终端/内容壳 — CTA 在 ApprovalBanner.
   * ask_user waiting 仍必须展开 (选项卡在内容里). */
  const errorCardChild = step.content?.type === 'error';
  const thinkingChild = step.content?.type === 'thinking';
  const desiredExpanded = activityChild
    ? isAwaitingAskUser
      || (step.status === 'running' && !thinkingChild)
      || (step.status === 'failed' && !errorCardChild)
      || (step.presentation?.defaultExpanded ?? false)
    : (step.presentation?.defaultExpanded ?? !!step.defaultExpanded);
  /* 用户动过就以他的选择为初始值 (重挂后不回弹) */
  const [expanded, setExpanded] = useState(
    () => USER_TOGGLED_EXPANDED.get(step.id) ?? desiredExpanded,
  );
  const [renderContent, setRenderContent] = useState(desiredExpanded);
  const [openVisual, setOpenVisual] = useState(desiredExpanded);
  const openRafRef = useRef<number | null>(null);
  /* 只有**用户手动切换**才分帧; 首次挂载直接到位。
   * timeline 是虚拟列表, 滚动时行会不断重挂, 若每次重挂都播一遍入场反而更晃。 */
  const openFirstRunRef = useRef(true);
  const opChip = step.content?.type === 'op_chip' ? step.content : null;
  const hasContent = !!step.content && step.content.type !== 'none' && !opChip;
  /* hint 是一句人话 (「nothing to commit」「回到主工作区」), 跟标题同一种字, 用 · 接在后面 ——
   * 跟合并行「读取 project · 执行 1 条命令」是同一个写法; target 是路径 / id / pid, 走 desc 的等宽。 */
  const rowTitle = opChip ? [opChip.label, opChip.hint].filter(Boolean).join(' · ') : step.title;
  const rowDesc = opChip ? opChip.target : step.desc;
  const presentation = step.presentation;
  const collapseAfterCompleteMs = activityChild && presentation?.collapseAfterCompleteMs
    ? Math.max(presentation.collapseAfterCompleteMs, 1800)
    : presentation?.collapseAfterCompleteMs;
  const debugStepSnapshotRef = useRef<{
    content: StepT['content'];
    presentation: StepT['presentation'];
    status: StepT['status'];
    title: string;
    defaultExpanded?: boolean;
  } | null>(null);

  useEffect(() => {
    if (!isTimelineDebugEnabled() || !shouldDebugStepJank(step)) return;
    logTimelineJank('step-mount', stepJankPayload(step, { activityChild, contentOnly }));
    return () => {
      logTimelineJank('step-unmount', stepJankPayload(step, { activityChild, contentOnly }));
    };
  }, [activityChild, contentOnly, step.id]);

  useEffect(() => {
    if (!isTimelineDebugEnabled() || !shouldDebugStepJank(step)) {
      debugStepSnapshotRef.current = {
        content: step.content,
        presentation: step.presentation,
        status: step.status,
        title: step.title,
        defaultExpanded: step.defaultExpanded,
      };
      return;
    }
    const prev = debugStepSnapshotRef.current;
    if (prev) {
      const changed: string[] = [];
      if (prev.content !== step.content) changed.push('content-ref');
      if (prev.presentation !== step.presentation) changed.push('presentation-ref');
      if (prev.status !== step.status) changed.push(`status:${prev.status}->${step.status}`);
      if (prev.title !== step.title) changed.push('title');
      if (prev.defaultExpanded !== step.defaultExpanded) changed.push('defaultExpanded');
      if (changed.length > 0) {
        logTimelineJank('step-props-changed', stepJankPayload(step, {
          changed,
          activityChild,
          contentOnly,
        }));
      }
    }
    debugStepSnapshotRef.current = {
      content: step.content,
      presentation: step.presentation,
      status: step.status,
      title: step.title,
      defaultExpanded: step.defaultExpanded,
    };
  });

  /* 跟随 presentation.defaultExpanded 变化.
   * 展示策略集中在 timelinePresentation.ts: running 展开、失败/核心结果保留展开、
   * shell/read/search 等完成后先 settle 再折叠. 一旦用户手动 toggle, 后续尊重用户选择. */
  const collapseTimerRef = useRef<number | null>(null);
  const contentExitTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (USER_TOGGLED_EXPANDED.has(step.id)) return;   /* 用户动过 → 永远尊重他 */
    if (collapseTimerRef.current) {
      window.clearTimeout(collapseTimerRef.current);
      collapseTimerRef.current = null;
    }
    if (!desiredExpanded && shouldPreserveCompletedExpanded(step, expanded)) {
      if (isTimelineDebugEnabled() && shouldDebugStepJank(step)) {
        logTimelineJank('step-preserve-expanded', stepJankPayload(step, {
          activityChild,
          contentOnly,
        }));
      }
      return;
    }
    if (!desiredExpanded && expanded && collapseAfterCompleteMs) {
      const collapseWhenIdle = () => {
        if (isTimelineUserScrollGuardActive()) {
          collapseTimerRef.current = window.setTimeout(collapseWhenIdle, 180);
          return;
        }
        collapseTimerRef.current = null;
        notifyTimelineLayoutTransition();
        setExpanded(false);
      };
      collapseTimerRef.current = window.setTimeout(
        collapseWhenIdle,
        collapseAfterCompleteMs
      );
      return () => {
        if (collapseTimerRef.current) {
          window.clearTimeout(collapseTimerRef.current);
          collapseTimerRef.current = null;
        }
      };
    }
    if (expanded !== desiredExpanded) notifyTimelineLayoutTransition();
    setExpanded(desiredExpanded);
  }, [activityChild, collapseAfterCompleteMs, contentOnly, desiredExpanded, expanded, step]);

  useEffect(() => {
    if (contentExitTimerRef.current) {
      window.clearTimeout(contentExitTimerRef.current);
      contentExitTimerRef.current = null;
    }
    if (openRafRef.current !== null) {
      cancelAnimationFrame(openRafRef.current);
      openRafRef.current = null;
    }
    if (expanded) {
      setRenderContent(true);
      if (openFirstRunRef.current) {
        /* 首次挂载(含滚动重挂): 直接到位, 不播入场 */
        openFirstRunRef.current = false;
        setOpenVisual(true);
        return;
      }
      /* 双 rAF: 第一帧让 is-closing(0fr) 真正提交成计算值, 第二帧再切 is-open,
       * 浏览器这才有起止两个值可插值。仓库里 Sidebar.tsx / TerminalView.tsx 同款写法。 */
      openRafRef.current = requestAnimationFrame(() => {
        openRafRef.current = requestAnimationFrame(() => {
          openRafRef.current = null;
          setOpenVisual(true);
        });
      });
      return () => {
        if (openRafRef.current !== null) {
          cancelAnimationFrame(openRafRef.current);
          openRafRef.current = null;
        }
      };
    }
    openFirstRunRef.current = false;
    setOpenVisual(false);
    contentExitTimerRef.current = window.setTimeout(() => {
      contentExitTimerRef.current = null;
      setRenderContent(false);
    }, TOOL_CONTENT_EXIT_MS);
    return () => {
      if (contentExitTimerRef.current) {
        window.clearTimeout(contentExitTimerRef.current);
        contentExitTimerRef.current = null;
      }
    };
  }, [expanded]);

  /* 不再为每个展开内容启动 480ms RAF 派发 layout-transition。
   * 主 timeline 已统一负责滚动；这里持续 RAF 会在长 timeline 滚动时抢主线程。 */

  const toggle = useCallback(() => {
    if (!hasContent) return;
    rememberUserToggle(step.id, !expanded);
    if (collapseTimerRef.current) {
      window.clearTimeout(collapseTimerRef.current);
      collapseTimerRef.current = null;
    }
    setExpanded((v) => !v);
    notifyTimelineLayoutTransition();
  }, [hasContent]);

  const { Icon, className: iconClass } = getStepIconInfo(step.iconKind);
  const appIcon = (step.content?.type === 'computer' ? step.content.icon : undefined) || step.brandIcon;

  /* Phase 3.12 §6.2 lite wire-in: 12 covered StepContent.type 走新 HistoryCellRenderer
   *  (cells/ 收到 HistoryCell-shaped 数据). 7 uncovered 仍走老 StepContentRenderer 兜底.
   *  Phase E (full) 完成后 mapTimelineEntriesToRows 在更外层产 HistoryCellRow, 这里
   *  就只剩 cell 路径 + legacy_step 二选一. */
  const historyCell = useMemo(
    () => (step.content ? buildHistoryCellFromStep(step) : null),
    [step]
  );

  /* running 时 1 秒 tick, 动态显示 elapsed; 非 running / stale 不 tick. */
  const [now, setNow] = useState(() => Date.now());

  const STALE_THRESHOLD_MS = 3 * 60 * 1000;
  const runtimeForStale = useNeoxRuntimeOptional();
  const isStaleRunning = useMemo(() => {
    if (step.status !== 'running') return false;
    if (!step.startedAtMs) return false;
    /* 当前会话还在 streaming, 不可能是 stale — 真在跑. */
    if (runtimeForStale?.streaming) return false;
    return (Date.now() - step.startedAtMs) > STALE_THRESHOLD_MS;
    /* now 也参与判定, 让首次进入 stale 时立刻 re-render. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step.status, step.startedAtMs, runtimeForStale?.streaming, now]);

  useEffect(() => {
    if (step.status !== 'running' || !step.startedAtMs) return;
    /* stale 后不再 tick — 时长固化, 不再继续累加 */
    if (isStaleRunning) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [step.status, step.startedAtMs, isStaleRunning]);

  /* stale 时 badge 改"已中断", 视觉用 failed 同款灰红 */
  const STATUS_BADGE = getStatusBadge(isZh);
  const badge = isStaleRunning
    ? { text: isZh ? '已中断' : 'Interrupted', cls: 'is-interrupted' }
    : step.tone ? undefined
    : STATUS_BADGE[step.status];

  const liveDuration =
    step.status === 'running' && step.startedAtMs && !isStaleRunning
      ? formatElapsedMs(now - step.startedAtMs)
      : (step.status === 'running' && step.startedAtMs && isStaleRunning
          /* stale 也展示固化时长, 让用户知道这步跑过多久才挂 */
          ? formatElapsedMs(now - step.startedAtMs)
          : step.duration);

  const shouldShowDuration =
    !!liveDuration &&
    !presentation?.suppressDuration &&
    (step.status === 'running' ||
      step.status === 'failed' ||
      !/^0(\.\d+)?\s*m?s$/i.test(liveDuration));
  const terminalPid =
    step.content?.type === 'terminal' &&
    typeof step.content.pid === 'number' &&
    step.content.pid > 0
      ? step.content.pid
      : null;
  const normalizedContentType =
    hasContent && step.content
      ? step.content.type.replace(/_/g, '-')
      : undefined;
  const contentTypeClass = normalizedContentType
    ? `is-content-${normalizedContentType}`
    : '';
  /* 渲染期标记 —— 替代 `.atl-tool__content-shell:has(.atl-ask--settled)`。
   * 判定与 AskUserView 里出 `atl-ask--settled` 的三个分支逐一对应:
   *   · status !== waiting 且不是 orphan 错误卡 → 收成摘要行
   *   · 药丸接管 (dockOwns) → 即使还在 waiting 也收成一行
   * 少一半都不行, 否则等待期那张卡会多出 shell 的 6px 上边距。 */
  const askContent = step.content?.type === 'askUser' ? step.content : null;
  const askDockOwns = useAskDockShown(askContent?.requestId);
  const contentAskSettled =
    !!askContent && ((!askContent.error && askContent.status !== 'waiting') || askDockOwns)
      ? '1'
      : undefined;
  const compactionContent = step.content?.type === 'compaction' ? step.content : null;
  const targetContinueContent = step.content?.type === 'target_continuation' ? step.content : null;

  const runtimeForSurface = useNeoxRuntimeOptional();
  const sessionIdForSurface = runtimeForSurface?.activeSession?.id;
  const surfaces = useSurfaces(sessionIdForSurface ?? null);
  const isSurfaceTool = useMemo(() => {
    const t = step.title || '';
    return /^(browser_|sheet_|image_|canvas_|open_surface|update_surface|close_surface)/.test(t);
  }, [step.title]);
  const surfaceChipLabel = useMemo(() => {
    if (!isSurfaceTool || surfaces.length === 0) return null;
    /* 1 个 surface: 显示具体 title (e.g., "→ Cursor.com")
     * 多个: 显示总数 (e.g., "→ 3 surface") */
    if (surfaces.length === 1) {
      const s = surfaces[0];
      const title = s.title || s.kind || 'surface';
      return `→ ${title.length > 24 ? title.slice(0, 22) + '…' : title}`;
    }
    return `→ ${surfaces.length} surface`;
  }, [isSurfaceTool, surfaces]);
  const onSurfaceChipClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    /* 跟 BackgroundTasksBar.openServicesSurface 同款 — 右栏开 Services 总控页 */
    window.dispatchEvent(new CustomEvent('neox:open-surface', {
      detail: {
        kind: 'services',
        source: { type: 'inline', content: '' },
        title: isZh ? '服务' : 'Services',
        pinned: true,
        /* 用户点了 timeline 里那一行 —— 明确要看, 照展右栏 */
        byUser: true,
      },
    }));
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  };

  if (compactionContent) {
    return (
      <div
        className={[
          'atl-compaction-step',
          `is-${step.status}`,
          (isStaleRunning || step.status === 'interrupted') ? 'is-stale' : '',
          inGroup ? 'is-in-group' : '',
          activityChild ? 'is-activity-child' : '',
          contentOnly ? 'is-content-only' : '',
          presentation?.phase ? `is-phase-${presentation.phase}` : '',
          presentation?.importance ? `is-importance-${presentation.importance}` : '',
          presentation?.visibility ? `is-visibility-${presentation.visibility}` : '',
          compactionContent.status ? `is-compaction-${compactionContent.status}` : '',
        ].filter(Boolean).join(' ')}
        data-phase={presentation?.phase}
        data-importance={presentation?.importance}
        data-visibility={presentation?.visibility}
        data-timeline-step-id={step.id}
        data-content-type="compaction"
        title={presentation?.summary}
      >
        <CompactionView
          status={compactionContent.status}
          originalTokens={compactionContent.originalTokens}
          finalTokens={compactionContent.finalTokens}
          budgetTokens={compactionContent.budgetTokens}
          originalMsgs={compactionContent.originalMsgs}
          keptMsgs={compactionContent.keptMsgs}
          droppedMsgs={compactionContent.droppedMsgs}
          compressionBuckets={compactionContent.compressionBuckets}
          compressionTotalBuckets={compactionContent.compressionTotalBuckets}
          compressionCompletedBuckets={compactionContent.compressionCompletedBuckets}
          compressionSummaryModel={compactionContent.compressionSummaryModel}
          errorDetail={compactionContent.errorDetail}
        />
      </div>
    );
  }

  if (targetContinueContent) {
    return (
      <div
        className={[
          'atl-compaction-step',
          'atl-target-continue-step',
          `is-${step.status}`,
          inGroup ? 'is-in-group' : '',
          activityChild ? 'is-activity-child' : '',
          contentOnly ? 'is-content-only' : '',
        ].filter(Boolean).join(' ')}
        data-timeline-step-id={step.id}
        data-content-type="target_continuation"
        title={presentation?.summary}
      >
        <TargetContinueView
          iteration={targetContinueContent.iteration}
          consecutiveBlocks={targetContinueContent.consecutiveBlocks}
          kind={targetContinueContent.kind}
        />
      </div>
    );
  }

  const richCardContent =
    step.content?.type === 'neox_card' || step.content?.type === 'timer_card'
      ? step.content
      : null;
  if (richCardContent && !inGroup) {
    return (
      <div
        className={[
          'atl-richcard-step',
          `is-${step.status}`,
          activityChild ? 'is-activity-child' : '',
          contentOnly ? 'is-content-only' : '',
        ].filter(Boolean).join(' ')}
        data-timeline-step-id={step.id}
        data-content-type={richCardContent.type}
        title={presentation?.summary}
      >
        <StepContentRenderer content={richCardContent} stepTitle={step.title} stepContext={step.desc || ''} />
      </div>
    );
  }

  if (contentOnly) {
    /* 活动子行的头由 ActivityChildRow 画; op_chip 没有展开区 —— 除了 delete_file 的「撤销删除」,
     * 它得有个地方挂 (行头是个 <button>, 里面不能再套按钮)。 */
    if (opChip?.deletionSnapshotId) {
      return (
        <div className="atl-tool__content atl-tool__content--undo">
          <OpChipUndoButton deletionSnapshotId={opChip.deletionSnapshotId} className="atl-tool__undo" />
        </div>
      );
    }
    if (!hasContent) return null;
    const terminalContent = step.content?.type === 'terminal' ? step.content : null;
    const historyExecEmpty =
      historyCell?.kind === 'exec' &&
      (!(historyCell.output && String(historyCell.output).trim()) || step.status === 'awaiting');
    const legacyTermEmpty =
      !!terminalContent &&
      (step.status === 'awaiting' ||
        ((terminalContent.streaming || step.status === 'running' || step.status === 'pending') &&
          !(terminalContent.output && String(terminalContent.output).trim())));
    if (historyExecEmpty || legacyTermEmpty) return null;
    return (
      <div
        className={[
          'atl-tool atl-tool--content-only',
          `is-${step.status}`,
          step.tone ? `is-tone-${step.tone}` : '',
          (isStaleRunning || step.status === 'interrupted') ? 'is-stale' : '',
          'is-expanded',
          'is-activity-child',
          contentTypeClass,
          hasContent ? 'has-content' : '',
          isAwaitingAskUser ? 'is-awaiting-ask' : '',
        ].filter(Boolean).join(' ')}
        data-timeline-step-id={step.id}
        data-content-type={normalizedContentType}
      >
        <div
          className={[
            'atl-tool__content-shell',
            'atl-tool__content-shell--enter',
            contentTypeClass,
            'is-open',
          ].filter(Boolean).join(' ')}
          data-content-type={normalizedContentType}
          data-ask-settled={contentAskSettled}
          aria-hidden={false}
        >
          <div className="atl-tool__content-shell-inner">
            {historyCell ? (
              <HistoryCellRenderer cell={historyCell} stepTitle={step.title} stepContext={step.desc || ''} />
            ) : (
              <StepContentRenderer content={step.content} stepTitle={step.title} stepContext={step.desc || ''} />
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={[
        'atl-tool',
        `is-${step.status}`,
        step.tone ? `is-tone-${step.tone}` : '',
        (isStaleRunning || step.status === 'interrupted') ? 'is-stale' : '',
        expanded ? 'is-expanded' : '',
        inGroup ? 'is-in-group' : '',
        activityChild ? 'is-activity-child' : '',
        hasContent ? 'has-content' : '',
        contentTypeClass,
        step.diffStat ? 'has-diffstat' : '',
        presentation?.phase ? `is-phase-${presentation.phase}` : '',
        presentation?.importance ? `is-importance-${presentation.importance}` : '',
        presentation?.visibility ? `is-visibility-${presentation.visibility}` : '',
        isAwaitingAskUser ? 'is-awaiting-ask' : '',
      ].filter(Boolean).join(' ')}
      data-phase={presentation?.phase}
      data-importance={presentation?.importance}
      data-visibility={presentation?.visibility}
      data-timeline-step-id={step.id}
      data-content-type={normalizedContentType}
      title={presentation?.summary}
    >
      <div
        className="atl-tool__row"
        role={hasContent ? 'button' : undefined}
        tabIndex={hasContent ? 0 : -1}
        aria-expanded={hasContent ? expanded : undefined}
        onClick={toggle}
        onKeyDown={onKey}
      >
        {/* Computer Use 用真实 App 图标 (计算器就是计算器那枚), 其它工具用线性 glyph */}
        <div className={`atl-tool__icon ${appIcon ? 'atl-tool__icon--app' : iconClass}`}>
          {step.status === 'running' && !isStaleRunning ? (
            <DotSpinner size={12} />
          ) : appIcon ? (
            <img className="atl-appicon" src={appIcon} alt="" />
          ) : (
            <Icon size={14} />
          )}
        </div>
        <div className="atl-tool__body">
          <span className="atl-tool__text">
            <LiveShimmerText
              className="atl-tool__title"
              title={rowTitle}
              text={opChip ? rowTitle : shortenToolTitle(rowTitle)}
              live={step.status === 'running' && !isStaleRunning}
            />
            {rowDesc && <span className="atl-tool__desc">{rowDesc}</span>}
            {surfaceChipLabel && (
              <span
                className="atl-tool__surface-chip"
                onClick={onSurfaceChipClick}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter') onSurfaceChipClick(e as any); }}
                title={isZh ? '点击打开 Surface 总控页' : 'Open the Surface control page'}
              >
                {surfaceChipLabel}
              </span>
            )}
          </span>
          {step.meta && step.meta.length > 0 && (
            <span className="atl-tool__meta">
              {step.meta.map((m, i) => (
                <span key={i} className="atl-tool__meta-item">{m}</span>
              ))}
            </span>
          )}
        </div>
        {diffStatNode}
        {shouldShowDuration && <span className="atl-tool__duration">{liveDuration}</span>}
        {badge && <span className={`atl-tool__badge ${badge.cls}`}>{badge.text}</span>}
        {/* 不展开也能停: running 的 shell tool card 头里挂 ■, 点了 killBackgroundTask(pid).
         * 仅 terminal 类型 content + 有 pid 时出来; 其它工具类型(read/edit/...) 没意义. */}
        {step.status === 'running' && terminalPid !== null && (
          <button
            type="button"
            className="atl-tool__stop"
            title={isZh ? `停止 PID ${terminalPid} (SIGTERM)` : `Stop PID ${terminalPid} (SIGTERM)`}
            aria-label={isZh ? '停止' : 'Stop'}
            onClick={(e) => {
              e.stopPropagation();
              try {
                (window as any).neox?.killBackgroundTask?.(terminalPid, false)
                  ?.catch?.((err: unknown) =>
                    dispatchOpFailedFromError(isZh ? '停止进程' : 'Stop process', err));
              } catch (err) {
                dispatchOpFailedFromError(isZh ? '停止进程' : 'Stop process', err);
              }
            }}
          >■</button>
        )}
        {opChip?.deletionSnapshotId && (
          <OpChipUndoButton deletionSnapshotId={opChip.deletionSnapshotId} className="atl-tool__undo" />
        )}
        {step.timestamp && <span className="atl-tool__time">{step.timestamp}</span>}
        <span className="atl-tool__chevron" aria-hidden="true" />
      </div>

      {hasContent && renderContent && (
        <div
          className={[
            'atl-tool__content-shell',
            'atl-tool__content-shell--enter',
            contentTypeClass,
            openVisual ? 'is-open' : 'is-closing',
          ].filter(Boolean).join(' ')}
          data-content-type={normalizedContentType}
          data-ask-settled={contentAskSettled}
          aria-hidden={!expanded}
        >
          <div className="atl-tool__content-shell-inner">
            {historyCell ? (
              <HistoryCellRenderer cell={historyCell} stepTitle={step.title} stepContext={step.desc || ''} />
            ) : (
              <StepContentRenderer content={step.content} stepTitle={step.title} stepContext={step.desc || ''} />
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export const TimelineStep = React.memo(TimelineStepImpl, areTimelineStepPropsEqual);
TimelineStep.displayName = 'TimelineStep';

export default TimelineStep;
