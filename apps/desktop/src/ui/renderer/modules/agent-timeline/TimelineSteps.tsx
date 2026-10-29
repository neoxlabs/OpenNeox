import React, { useMemo, useRef, useCallback, useEffect, useState } from "react";
import { MessageCell } from "./cells/messageRouter";
import { WorkReceiptForTurn } from "./cells/WorkReceiptNote";
import { TurnFoldRow } from './TurnFoldRow';
import { WorkProgressCard } from './WorkProgressCard';
import { withWorkProgressCard } from './workProgress';
import { LiveTurnAvatar } from './LiveTurnAvatar';
import { liveTurnMark } from './liveTurnMark';
import { ActivityRow, FlatActivityRow, ActivityChildRow, isFlatToolRow, groupFlatChildren, flatGroupHeadRolls } from "./components/ActivityRow";
import { RowContent } from "./components/RowContent";
import { LiveShimmerText } from "./components/LiveShimmerText";
import { DotSpinner } from "../../components/DotSpinner";
import { useWaitingPhase } from "../shell/useAgentPhase";
import type { TimelineDensity, TimelineRow } from "./types";
import { IconChevronDown } from "../shell/shellIcons";
import { shellPerf } from "../../perf/shellPerf";
import type { Row } from "./timelineRows";
import {
  rowKeyOf,
  rowStepId,
  rowStepIds,
  buildUniqueRowKeys,
  buildTimelineRows,
  pinnedSetAdd,
  stabilizeTimelineRows,
  rowHasRunningStep,
} from "./timelineRows";
import { rowHasWideContent } from "./rowWideContent";
import { useTimelineFreshness } from "./hooks/useTimelineFreshness";
import { useDeferredTimelineRows } from "./hooks/useDeferredTimelineRows";
import { useTimelineVirtualizer } from "./hooks/useTimelineVirtualizer";
import { useTimelineDiagnostics } from "./hooks/useTimelineDiagnostics";
import { useTimelineScrollController } from "./hooks/useTimelineScrollController";
import { useI18n } from "../../hooks/useI18n";
import { useAgentModeVariant } from "../../hooks/useAgentModeVariant";
import { ActivityBrief } from "./components/ActivityRow";
import {
  debugRowKind,
  getDebugRowLabel,
  isTimelineDebugEnabled,
  logTimelineJank,
} from "./timelineDebug";

interface Props {
  items: TimelineRow[];
  /** 整条会话被用户暂停 — 透传给空 streaming MessageCell, 占位变 "已暂停" */
  paused?: boolean;
  /** session 级别 streaming 状态 — agent turn 整体是否在运行中 */
  sessionStreaming?: boolean;
  /** 当前 active session id — 用于判断进入/切换会话时的初始滚动定位. */
  sessionId?: string | null;
  /** 同一 session 在不同 Timeline 容器里展示时，滚动存档需要隔离. */
  scrollScope?: string;
  /** Timeline 显示密度 — minimal 下更激进地聚合连续同类工具 (阈值 3→2). */
  density?: TimelineDensity;
  /** 滚到顶时按需回捞更早历史 — 返回本批 loaded 数与是否已到最早, 供滚动锚点保持. */
  onReachTop?: () => Promise<{ loaded: number; reachedStart: boolean }>;
}

/** 稳定的空数组身份 —— 每次返回新 [] 会把下游所有 memo 打穿 */
const EMPTY_ROWS: Row[] = [];

/**
 * Code: 正在跑的这一轮, 两段话之间连着的工具合成一组 (跟折起来展开后同一套), 尾巴那组标成活的 ——
 * 新工具一到就在那一行里滚动播报, 而不是先冒出一条条单行、等下一段话来了再缩成一行。
 * 只动最后一条用户消息之后的部分, 历史轮不碰 (它们已经是 turn_fold)。
 */
function withLiveToolGroups(rows: Row[], streaming: boolean): Row[] {
  let start = rows.length;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (r.kind === "message" && r.message.role === "user") break;
    start = i;
  }
  if (start >= rows.length) return rows;
  const tail = groupFlatChildren(rows.slice(start));
  for (let i = 0; i < tail.length; i++) {
    const r = tail[i]!;
    if (r.kind !== "activity") continue;
    const live = streaming && i === tail.length - 1;
    if (!!r.inActiveTurn !== live) tail[i] = { ...r, inActiveTurn: live };
  }
  return [...rows.slice(0, start), ...tail];
}

const TurnPendingRow: React.FC<{ isZh: boolean; paused?: boolean; flat?: boolean }> = ({ isZh, paused, flat }) => {
  const startedAt = useMemo(() => Date.now(), []);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    /* 1s 一跳就够 —— 这行只是让人知道"还在走", 不是秒表 */
    const t = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => window.clearInterval(t);
  }, [startedAt]);
  /* 跟顶栏岛同一套阶段 (agentPhase.ts): 连接中 / 思考中 / 整理结果 / 重试中 2/3 …… 不再一律「思考中」 */
  const { phase, label } = useWaitingPhase(isZh);
  if (paused) return null;
  /* Code 定版: 跟工具行同一个样子 —— 点阵 · 阶段扫光 · 行尾钴蓝计时。
   * 换阶段时新的一句从下面顶上来 (跟跑着的工具组播报同一个滚动, 只动 transform); 进度数字原地改 */
  if (flat) {
    return (
      <div className="nx-tool is-running is-tail" role="status" aria-live="polite" data-phase={phase}>
        <div className="nx-trow">
          <span className="nx-trow__ic" aria-hidden="true"><DotSpinner size={12} /></span>
          <span className="nx-tgroup__live nx-trow__v"><ActivityBrief text={label} live rollKey={phase} /></span>
          <span className="nx-trow__d">{elapsed > 0 ? `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}` : ""}</span>
          <span className="nx-trow__c" />
        </div>
      </div>
    );
  }
  const text = phase === "thinking" ? (isZh ? "Agent 正在思考…" : "Agent is thinking…") : `${label}…`;
  return (
    <div className="atl-turn-pending" role="status" aria-live="polite">
      <ActivityBrief text={text} live />
      {elapsed > 0 && (
        <span className="atl-turn-pending__elapsed">
          {elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`}
        </span>
      )}
    </div>
  );
};

function logRowIdentityAudit(
  previous: Row[] | null,
  built: Row[],
  stable: Row[],
  sessionId: string | null | undefined,
  density: TimelineDensity
): void {
  if (!previous || !isTimelineDebugEnabled()) return;
  const prevKeys = buildUniqueRowKeys(previous);
  const prevByKey = new Map<string, Row>();
  previous.forEach((row, index) => {
    prevByKey.set(prevKeys[index] ?? rowKeyOf(row, index), row);
  });
  const nextKeys = buildUniqueRowKeys(built);
  let reused = 0;
  let missingPrev = 0;
  let kindChanged = 0;
  let contentChanged = 0;
  const examples: Array<Record<string, unknown>> = [];
  for (let index = 0; index < built.length; index++) {
    const row = built[index];
    const key = nextKeys[index] ?? rowKeyOf(row, index);
    const prev = prevByKey.get(key);
    const stableRow = stable[index];
    if (prev && stableRow === prev) {
      reused += 1;
      continue;
    }
    let reason = "content-signature-changed";
    if (!prev) {
      missingPrev += 1;
      reason = "new-key";
    } else if (prev.kind !== row.kind) {
      kindChanged += 1;
      reason = "kind-changed";
    } else {
      contentChanged += 1;
    }
    const label = getDebugRowLabel(row);
    const interesting =
      examples.length < 10 &&
      (reason !== "new-key" ||
        /edit|diff|patch|activity/i.test(`${label} ${debugRowKind(row)}`));
    if (interesting) {
      examples.push({
        index,
        key,
        reason,
        kind: debugRowKind(row),
        label,
        prevLabel: prev ? getDebugRowLabel(prev) : null,
      });
    }
  }
  const suspicious = contentChanged > 0 || kindChanged > 0 || examples.length > 0;
  if (!suspicious) return;
  logTimelineJank("rows-identity", {
    sessionId,
    density,
    rows: built.length,
    reused,
    missingPrev,
    kindChanged,
    contentChanged,
    examples,
  });
}

/* ============================================================
 * TimelineSteps — 混排 message / tool / parallel group / sequential cluster
 * ============================================================ */
const TimelineStepsImpl: React.FC<Props> = ({
  items,
  paused = false,
  sessionId,
  scrollScope,
  density = "normal",
  sessionStreaming = false,
  onReachTop,
}) => {
  const { isZh } = useI18n();
  const modeVariant = useAgentModeVariant();
  const minimal = density === "minimal" || modeVariant.isWork;
  const turnLastAssistantIds = useMemo(() => {
    const ids = new Set<string>();
    let lastAsst: string | null = null;
    for (const it of items) {
      if (!it || it.kind !== "cell") continue;
      if (it.cell.kind === "user") {
        if (lastAsst) ids.add(lastAsst);
        lastAsst = null;
        continue;
      }
      if (it.cell.kind === "assistant_text") lastAsst = it.id;
    }
    if (lastAsst) ids.add(lastAsst);
    return ids;
  }, [items]);
  /* 当前活跃轮 (= 最后一条 user 及之后) 的消息 id.
   *  turnRunning 只压这一轮: 历史轮的 footer 在会话再跑时也要继续显示. */
  const activeTurnMessageIds = useMemo(() => {
    const ids = new Set<string>();
    let lastUserIdx = -1;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it?.kind === "cell" && it.cell.kind === "user") {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx < 0) return ids;
    for (let i = lastUserIdx; i < items.length; i++) {
      const it = items[i];
      if (it?.kind === "cell" && (it.cell.kind === "user" || it.cell.kind === "assistant_text")) {
        ids.add(it.id);
      }
    }
    return ids;
  }, [items]);
  const PIN_CAP = 1500;
  const pinnedSingleStepIdsRef = useRef<Set<string>>(new Set());
  const lastSessionIdRef = useRef<string | null | undefined>(sessionId);
  if (lastSessionIdRef.current !== sessionId) {
    pinnedSingleStepIdsRef.current = new Set();
    lastSessionIdRef.current = sessionId;
  }
  const pinAdd = useCallback((id: string) => {
    pinnedSetAdd(pinnedSingleStepIdsRef.current, id, PIN_CAP);
  }, []);
  const stableRowsRef = useRef<{
    sessionId?: string | null;
    rows: Row[];
  } | null>(null);

  const [paneVisible, setPaneVisible] = useState(true);
  const paneVisibleRef = useRef(true);
  useEffect(() => {
    const el = feedShellRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      const e = entries[entries.length - 1];
      if (!e) return;
      /* display:none 的元素 boundingClientRect 全 0 且 isIntersecting=false */
      const vis = e.isIntersecting || e.boundingClientRect.width > 0 || e.boundingClientRect.height > 0;
      if (paneVisibleRef.current !== vis) {
        paneVisibleRef.current = vis;
        setPaneVisible(vis);
      }
    }, { threshold: 0 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const computedRows = useMemo<Row[]>(
    () => {
      /* 不可见 → 原样交还上一份, 整条管线一次都不跑 */
      if (!paneVisible) {
        const cached = stableRowsRef.current;
        if (cached && cached.sessionId === sessionId) return cached.rows;
        return EMPTY_ROWS;
      }
      const built = shellPerf.measure(
        "timeline.computeRows",
        () => buildTimelineRows(items, minimal, pinnedSingleStepIdsRef.current, !minimal, sessionStreaming, sessionId),
        { sessionId, items: items.length, density }
      );
      for (const row of built) {
        if (row.kind === "single") {
          pinAdd(rowStepId(row.step));
        } else if (row.kind === "activity" || row.kind === "turn_fold") {
          /* activity / turn_fold 内部子行也算 — 防止它们把 single 子行重新聚成 cluster */
          for (const child of row.rows) {
            if (child.kind === "single") {
              pinAdd(rowStepId(child.step));
            } else if (child.kind === "activity") {
              for (const gc of child.rows) {
                if (gc.kind === "single") pinAdd(rowStepId(gc.step));
              }
            }
          }
        }
      }
      const stableSnapshot = stableRowsRef.current;
      const previous =
        stableSnapshot && stableSnapshot.sessionId === sessionId
          ? stableSnapshot.rows
          : null;
      /* Work: 正在跑的这一轮, 工作行收成一张进度卡 (见 workProgress.ts) */
      const shaped = modeVariant.isWork
        ? withWorkProgressCard(built, sessionStreaming === true)
        : modeVariant.isCode
          ? withLiveToolGroups(built, sessionStreaming === true)
          : built;
      const stable = shellPerf.measure(
        "timeline.stabilizeRows",
        () => stabilizeTimelineRows(previous, shaped),
        { sessionId, rows: shaped.length, density }
      );
      logRowIdentityAudit(previous, shaped, stable, sessionId, density);
      stableRowsRef.current = { sessionId, rows: stable };
      return stable;
    },
    [items, minimal, sessionId, density, pinAdd, paneVisible, sessionStreaming, modeVariant.isWork]
  );

  const { rows, rowsLengthRef, scrollingFlagRef } = useDeferredTimelineRows({
    computedRows,
    sessionId,
  });
  const scrollerRef = useRef<HTMLElement | Window | null>(null);
  const scrollerElRef = useRef<HTMLElement | null>(null);

  const rowKeys = useMemo(() => buildUniqueRowKeys(rows), [rows]);
  /* 正在跑的这一轮: 第一行左边挂会动的标 (跑完折起后换成折叠行的静态头像) */
  /* Work 也走 minimal 管线, 但它跑完的折叠行有头像, 跑着的这一轮 (进度卡) 也要有会动的那枚 */
  const liveMark = useMemo(
    () => (minimal && !modeVariant.isWork ? null : liveTurnMark(rows, sessionStreaming)),
    [rows, sessionStreaming, minimal, modeVariant.isWork],
  );

  /* 这一轮发出去了但还什么都没回来 —— feed 末尾补一行"正在思考"。
   * 判据只看**最后一行是不是用户消息**: 只要模型吐了字 / 起了工具, 末行就不再是
   * user message, ActivityRow 的 shimmer 接管, 这行自动让位 (不会两个指示并存)。 */
  const turnPending = useMemo(() => {
    if (!sessionStreaming) return false;
    const last = rows[rows.length - 1];
    if (!last) return false;
    if (last.kind === "message" && last.message.role === "user") return true;
    if (!modeVariant.isCode) return false;
    /* 正文在往外流: 字本身就是指示 */
    if (last.kind === "message") return !(last.message.streaming && last.message.text.trim());
    /* 活的那组工具头上在滚动播报 (两个工具之间也写着阶段), 不再另挂一行 */
    if (last.kind === "activity" && flatGroupHeadRolls(last)) return false;
    /* 在跑的工具 / 思考 / 等你回答: 那一行自己在动 */
    return !rowHasRunningStep(last);
  }, [rows, sessionStreaming, modeVariant.isCode]);
  const {
    windowingActive,
    virtualizer,
    measureElement,
    virtualItems,
    totalSize,
    rowHeightPrefix,
    commitViewportState,
    scheduleStableRowHeightSample,
    scrollToIndex,
    scrollToEnd,
    syncFollowBottom,
  } = useTimelineVirtualizer({
    rows,
    rowKeys,
    scrollerElRef,
    scrollingFlagRef,
    sessionId,
    scrollScope,
    sessionStreaming,
    trailingSlotCount: turnPending && !paused ? 1 : 0,
  });

  const isRowFresh = useTimelineFreshness({ rows, rowKeys, sessionId });

  const {
    feedShellRef,
    scrollThumbElRef,
    bottomSentinelRef,
    scrollToTop,
    forceScrollToBottom,
    onScrollRailPointerDown,
  } = useTimelineScrollController({
    rows,
    rowKeys,
    rowHeightPrefix,
    sessionId,
    sessionStreaming,
    scrollScope,
    scrollerRef,
    scrollerElRef,
    scrollingFlagRef,
    commitViewportState,
    scheduleStableRowHeightSample,
    onReachTop,
    /* prepend 锚点交给 TanStack；离底时 syncFollowBottom 会切到 start-anchor。 */
    libraryOwnsPrependAnchor: windowingActive,
    librarySyncFollowBottom: windowingActive ? syncFollowBottom : undefined,
    /* 所有"到底"走库的 scrollToEnd — DOM scrollHeight 在虚拟化下是收敛中的估值,
     * 按它算出来的底会随估值一起动。 */
    libraryScrollToEnd: windowingActive ? scrollToEnd : undefined,
    libraryScrollToIndex: windowingActive ? scrollToIndex : undefined,
  });


  const getRowTimeMs = useCallback((r: Row): number => {
    if (r.kind === "message") {
      const t = r.message.timestamp;
      if (typeof t === "number" && Number.isFinite(t)) return t;
      if (typeof t === "string" && t) {
        const n = Date.parse(t);
        return Number.isFinite(n) ? n : 0;
      }
      return 0;
    }
    if (r.kind === "single") return (r.step as { startedAtMs?: number }).startedAtMs ?? 0;
    if (r.kind === "cluster" || r.kind === "group") {
      const first = r.items[0] as { startedAtMs?: number } | undefined;
      return first?.startedAtMs ?? 0;
    }
    if (r.kind === "activity" || r.kind === "turn_fold") {
      /* activity / turn_fold 内嵌 Row[] — 递归取第一个可解出的 ms; 全 0 视为无时间戳 */
      for (const child of r.rows) {
        const ms = getRowTimeMs(child as unknown as Row);
        if (ms) return ms;
      }
      return 0;
    }
    return 0;
  }, []);
  const dayKeyOf = useCallback((ms: number): string => {
    if (!ms) return "";
    const d = new Date(ms);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }, []);
  const formatDayLabel = useCallback((ms: number): string => {
    if (!ms) return "";
    const d = new Date(ms);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const rowDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const diffDays = Math.round((today - rowDay) / 86400000);
    if (diffDays === 0) return isZh ? "今天" : "Today";
    if (diffDays === 1) return isZh ? "昨天" : "Yesterday";
    if (diffDays > 1 && diffDays < 7) {
      const weekdays = isZh
        ? ["周日", "周一", "周二", "周三", "周四", "周五", "周六"]
        : ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      return weekdays[d.getDay()] ?? "";
    }
    if (isZh) {
      const sameYear = d.getFullYear() === now.getFullYear();
      return sameYear ? `${d.getMonth() + 1}月${d.getDate()}日` : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
    }
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
    });
  }, [isZh]);

  const renderRow = useCallback(
    (index: number, r: Row) => {
      const key = rowKeys[index] ?? rowKeyOf(r, index);
      /* 仅 Work 模式插日期头 (day boundary 或 首行 且有效时间戳). */
      let dayHeader: React.ReactNode = null;
      if (modeVariant.isWork) {
        const currMs = getRowTimeMs(r);
        if (currMs) {
          const currKey = dayKeyOf(currMs);
          /* 回溯找**最近一个有有效时间戳**的 row (tool group / cluster 的 ms 常为 0, 直接看 index-1
           * 会拿到 0-key, 与 curr 的今天 key 永远不等, 导致每次 tool call 后都插一个"今天". */
          let prevKey = "";
          for (let i = index - 1; i >= 0; i--) {
            const prevMs = getRowTimeMs(rows[i]);
            if (prevMs) { prevKey = dayKeyOf(prevMs); break; }
          }
          if (currKey && currKey !== prevKey) {
            dayHeader = (
              <div className="atl-day-header" role="separator" aria-label={formatDayLabel(currMs)}>
                <span className="atl-day-header__label">{formatDayLabel(currMs)}</span>
              </div>
            );
          }
        }
      }
      let inner: React.ReactNode;
      let receiptNote: React.ReactNode = null;
      if (r.kind === "message") {
        /* 每一轮结论 (该轮最后一条 assistant) 都挂 footer, 不只整会话最后一条 */
        const isLastAssistant =
          r.message.role === "assistant" &&
          turnLastAssistantIds.has(r.message.id);
        /* 只有活跃轮在跑时才压 footer; 历史轮不受 sessionStreaming 影响 */
        const turnRunning =
          !!sessionStreaming && activeTurnMessageIds.has(r.message.id);
        /* 重新生成只对整会话最后一条 assistant (retryLast 语义) */
        const allowRegenerate =
          isLastAssistant && !turnRunning && activeTurnMessageIds.has(r.message.id);
        inner = (
          <MessageCell
            message={r.message}
            paused={paused}
            isLastAssistant={isLastAssistant}
            turnRunning={turnRunning}
            allowRegenerate={allowRegenerate}
          />
        );
        if (
          modeVariant.isWork
          && r.message.role === "assistant"
          && isLastAssistant
          && !turnRunning
          && !r.message.streaming
        ) {
          receiptNote = (
            <WorkReceiptForTurn rows={rows} index={index} text={r.message.text ?? ""} zh={isZh} />
          );
        }
      } else if (r.kind === "activity" && modeVariant.isCode) {
        /* Code 定版: 每个工具一行, 不折摘要 (见 FlatActivityRow) */
        inner = <FlatActivityRow activity={r} />;
      } else if (r.kind === "activity") {
        inner = (
          <ActivityRow
            activity={r}
            turnActive={r.inActiveTurn === true}
            digest
          />
        );
      } else if (r.kind === "turn_fold") {
        /* 已封口 turn 折成一行。展开时子行走 RowContent —— 折叠行内部不再嵌套折叠,
         * 里面的 activity/cluster 保持它们自己的行为。 */
        inner = (
          <TurnFoldRow
            fold={r}
            zh={isZh}
            renderRows={(children) => (modeVariant.isCode ? groupFlatChildren(children) : children).map((child, ci) => (
              <div className="atl-turnfold__child" key={`${r.id}-c${ci}`}>
                {child.kind === "message"
                  ? <MessageCell message={child.message} paused={paused} />
                  : child.kind === "activity"
                    ? (modeVariant.isCode
                      ? <FlatActivityRow activity={child} />
                      : <ActivityRow activity={child} turnActive={false} digest />)
                    : modeVariant.isCode && isFlatToolRow(child)
                      ? <ActivityChildRow row={child} index={ci} flat />
                      : <RowContent row={child} />}
              </div>
            ))}
          />
        );
      } else if (r.kind === "work_progress") {
        inner = <WorkProgressCard rows={r.rows} live zh={isZh} ask={r.ask} />;
      } else if (modeVariant.isCode && isFlatToolRow(r)) {
        inner = <ActivityChildRow row={r} index={index} flat />;
      } else {
        inner = <RowContent row={r} />;
      }
      const scrolling = scrollingFlagRef.current;
      const cls =
        isRowFresh(r, index) && !scrolling
          ? "atl-row-clamp atl-row-clamp--fresh"
          : "atl-row-clamp";
      return (
        <div
          className={cls}
          data-timeline-row-index={index}
          data-timeline-row-key={key}
          data-timeline-step-ids={rowStepIds(r).join(" ")}
          /* 行内是否含 diff / turn-summary —— 替代 `.atl-row-clamp:has(...)` 的尺寸规则 */
          data-atl-wide-content={rowHasWideContent(r) ? "1" : undefined}
        >
          {dayHeader}
          {liveMark?.index === index && <LiveTurnAvatar state={liveMark.state} />}
          {inner}
          {receiptNote}
        </div>
      );
    },
    [
      liveMark,
      paused,
      turnLastAssistantIds,
      activeTurnMessageIds,
      isRowFresh,
      rowKeys,
      rows,
      minimal,
      modeVariant.isWork,
      modeVariant.isCode,
      getRowTimeMs,
      dayKeyOf,
      formatDayLabel,
      scrollingFlagRef,
      isZh,
    ]
  );

  useEffect(() => {
    const feed = scrollerElRef.current;
    if (!feed) return;
    const INNER_SCROLL_SELECTOR = ".atl-diff, .atl-diff-preview, .atl-code__lines, .atl-msg__code";
    let engaged: Element | null = null;
    const onPointerDown = (e: PointerEvent) => {
      const next = (e.target as Element | null)?.closest?.(INNER_SCROLL_SELECTOR) ?? null;
      if (engaged && engaged !== next) engaged.classList.remove("is-wheel-engaged");
      engaged = next;
      if (engaged) engaged.classList.add("is-wheel-engaged");
    };
    feed.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      feed.removeEventListener("pointerdown", onPointerDown, true);
      if (engaged) engaged.classList.remove("is-wheel-engaged");
    };
  }, []);

  const onRowsProfilerRender = useCallback<React.ProfilerOnRenderCallback>(
    (id, phase, actualDuration, baseDuration, startTime, commitTime) => {
      /* 滚动中提高阈值, 避免 Profiler 回调本身刷屏占主线程. */
      const scrolling = scrollingFlagRef.current;
      const actualFloor = scrolling ? 12 : 8;
      const baseFloor = scrolling ? 80 : 40;
      if (actualDuration < actualFloor && baseDuration < baseFloor) return;
      const first = virtualItems[0];
      const last = virtualItems[virtualItems.length - 1];
      shellPerf.mark("react-profiler", {
        id,
        phase,
        actualMs: Math.round(actualDuration * 10) / 10,
        baseMs: Math.round(baseDuration * 10) / 10,
        startTime: Math.round(startTime * 10) / 10,
        commitTime: Math.round(commitTime * 10) / 10,
        sessionId,
        rows: rows.length,
        renderedRows: windowingActive ? virtualItems.length : rows.length,
        windowStart: first?.index ?? 0,
        windowEnd: last ? last.index + 1 : rows.length,
        estimatedHeight: Math.round(totalSize),
        items: items.length,
        streaming: sessionStreaming,
        scrolling,
        engine: windowingActive ? "tanstack-virtual" : "full",
      });
    },
    [
      items.length,
      rows.length,
      scrollingFlagRef,
      sessionId,
      sessionStreaming,
      totalSize,
      virtualItems,
      windowingActive,
    ]
  );

  return (
    <div className="atl-feed-shell" ref={feedShellRef}>
      <div
        className="atl-feed"
        /* 虚拟占位存在性给 CSS 用 —— 替代 `.atl-feed:has(.atl-feed__virtual-space)` */
        data-atl-virtual-space={
          !paneVisible || (windowingActive && virtualizer) ? "1" : undefined
        }
        ref={(el) => {
          scrollerRef.current = el;
          scrollerElRef.current = el;
        }}
      >
        <React.Profiler id="TimelineSteps.rows" onRender={onRowsProfilerRender}>
          {!paneVisible ? (
            <div className="atl-feed__virtual-space" style={{ height: 1 }} aria-hidden />
          ) : windowingActive && virtualizer ? (
            <div
              className="atl-feed__virtual-space"
              style={{ height: totalSize }}
              data-atl-virtual-engine="tanstack"
              data-atl-est-total={totalSize}
            >
              {virtualItems.map((item) => {
                const isPendingSlot = turnPending && !paused && item.index >= rows.length;
                const row = rows[item.index];
                if (!row && !isPendingSlot) return null;
                return (
                  <div
                    key={item.key}
                    className="atl-feed__virtual-item"
                    data-index={item.index}
                    ref={measureElement}
                    style={{
                      position: "absolute",
                      top: item.start,
                      left: 0,
                      width: "100%",
                    }}
                  >
                    {isPendingSlot ? (
                      <div className="atl-row-clamp">
                        <TurnPendingRow isZh={isZh} paused={paused} flat={modeVariant.isCode} />
                      </div>
                    ) : (
                      renderRow(item.index, row!)
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            rows.map((row, index) => (
              <React.Fragment key={rowKeys[index] ?? rowKeyOf(row, index)}>
                {renderRow(index, row)}
              </React.Fragment>
            ))
          )}
          {turnPending && paneVisible && !(windowingActive && virtualizer) && (
            <div className="atl-row-clamp">
              <TurnPendingRow isZh={isZh} paused={paused} flat={modeVariant.isCode} />
            </div>
          )}
          <div
            ref={bottomSentinelRef}
            className="atl-feed__footer-spacer"
            aria-hidden="true"
          />
        </React.Profiler>
      </div>

      {rows.length > 0 && (
        <div className="atl-scroll-nav" aria-label={isZh ? 'Timeline 快速滚动' : 'Timeline quick scroll'}>
          <button
            type="button"
            className="atl-scroll-nav__btn atl-scroll-nav__btn--top"
            onClick={() => scrollToTop(false)}
            aria-label={isZh ? '滚动到顶部' : 'Scroll to top'}
            title={isZh ? '到顶部' : 'Top'}
          >
            <IconChevronDown size={14} />
          </button>
          <div
            className="atl-scroll-nav__track"
            role="scrollbar"
            aria-orientation="vertical"
            aria-label={isZh ? '拖动快速定位 Timeline' : 'Drag to jump within Timeline'}
            onPointerDown={onScrollRailPointerDown}
            title={isZh ? '拖动快速定位' : 'Drag to jump'}
          >
            <span
              ref={scrollThumbElRef}
              className="atl-scroll-nav__thumb"
              aria-hidden="true"
            />
          </div>
          <button
            type="button"
            className="atl-scroll-nav__btn atl-scroll-nav__btn--bottom"
            onClick={() => {
              feedShellRef.current?.classList.remove("show-scroll-btn");
              forceScrollToBottom(false, "user");
            }}
            aria-label={isZh ? '滚动到底部' : 'Scroll to bottom'}
            title={isZh ? '到底部' : 'Bottom'}
          >
            <IconChevronDown size={14} />
          </button>
        </div>
      )}
      {rows.length > 0 && (
        <button
          type="button"
          className="atl-scroll-bottom"
          onClick={() => {
            feedShellRef.current?.classList.remove("show-scroll-btn");
            forceScrollToBottom(true, "user");
          }}
          aria-label={isZh ? '滚动到底部' : 'Scroll to bottom'}
          title={isZh ? '滚动到底部' : 'Scroll to bottom'}
        >
          <IconChevronDown size={15} />
          {/* "到底" 在中文里是"究竟"的意思, 单独当按钮文字读不成"回到底部" */}
          <span>{isZh ? '回到底部' : 'Bottom'}</span>
        </button>
      )}
    </div>
  );
};


export const TimelineSteps = React.memo(TimelineStepsImpl);

export default TimelineSteps;
