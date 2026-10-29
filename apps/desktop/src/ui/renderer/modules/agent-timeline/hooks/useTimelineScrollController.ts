import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Row } from "../timelineRows";
import { rowContainsStepId, rowHasWaitingAsk } from "../timelineRows";
import {
  isTimelineUserScrollGuardActive,
  setTimelineBottomFollowIntentProbe,
  setTimelineBottomFollowUntil,
  setTimelineUserScrollGuardUntil,
} from "../timelineScrollGuard";
import {
  isTimelineDebugEnabled,
  isTimelineScrollRailDebugDisabled,
  logTimelineJank,
} from "../timelineDebug";
import { useTimelineDiagnostics } from "./useTimelineDiagnostics";
import { DOCKED_MASCOT_SELECTOR, bottomChromeRect, countsAsFloatingBar } from "./bottomChrome";
import { bindUserScrollIntent } from "./bindUserScrollIntent";
import {
  ensureDurableTimelineScrollStateLoaded,
  flushTimelineScrollStateWrite,
  loadTimelineScrollStateSync,
  persistedAnchorMissing,
  rememberTimelineScrollState,
  rowKeySignature,
  shouldRestoreLiveSessionToBottom,
  timelineScrollStateBySession,
  timelineSessionScrollKey,
  type PersistedTimelineScrollState,
} from "./timelineScrollStatePersist";

const STICK_BOTTOM_THRESHOLD = 40;
const STREAM_FOLLOW_INTERVAL_MS = 90;
/* scrollTop 落到这个像素内即视为"到顶", 触发回捞更早历史 (提前一点, 让加载更无缝). */
const TIMELINE_REACH_TOP_PX = 240;
const TIMELINE_SCROLL_RESTORE_BOTTOM_HOLD_MS = 1800;

interface PendingSessionRestore {
  key: string;
  previousSignature: string;
  startedAt: number;
  skippedInitialCommit: boolean;
  source: "session-switch" | "durable-load";
}

import type {
  ScrollBottomSource,
  UseTimelineScrollControllerArgs,
  UseTimelineScrollControllerResult,
} from "./useTimelineScrollController.types";

function findMountedRowByKey(root: HTMLElement, key: string) {
  const nodes = root.querySelectorAll<HTMLElement>(
    ".atl-row-clamp[data-timeline-row-key]"
  );
  for (const node of nodes) {
    if (node.dataset.timelineRowKey === key) return node;
  }
  return null;
}

interface ScrollStaticMetrics {
  scrollHeight: number;
  clientHeight: number;
  maxScroll: number;
  canScroll: boolean;
  longEnoughForRail: boolean;
}


export function useTimelineScrollController({
  rows,
  rowKeys,
  rowHeightPrefix,
  sessionId,
  sessionStreaming = false,
  scrollScope,
  scrollerRef,
  scrollerElRef,
  scrollingFlagRef,
  commitViewportState,
  scheduleStableRowHeightSample,
  libraryOwnsPrependAnchor = false,
  libraryScrollToEnd,
  libraryScrollToIndex,
  librarySyncFollowBottom,
  onReachTop,
}: UseTimelineScrollControllerArgs): UseTimelineScrollControllerResult {
  /* ============================================================
   * 原生滚动容器 + TanStack Virtual（Chat: anchorTo end）。
   * 贴底 / 自定义 rail / reach-top / 会话恢复仍由本 controller 管；
   * 窗口切片与 prepend 锚点不再自研。
   * ============================================================ */
  const scrollerCleanupRef = useRef<(() => void) | null>(null);
  /* 存 ref 而不是直接闭包捕获: virtualizer 每次渲染换新回调, 直接进 useCallback 依赖
   * 会让 scrollToBottom 每帧重建, 连带一串 effect 反复解绑重绑。 */
  const libraryScrollToEndRef = useRef(libraryScrollToEnd);
  libraryScrollToEndRef.current = libraryScrollToEnd;
  const libraryScrollToIndexRef = useRef(libraryScrollToIndex);
  libraryScrollToIndexRef.current = libraryScrollToIndex;
  const librarySyncFollowBottomRef = useRef(librarySyncFollowBottom);
  librarySyncFollowBottomRef.current = librarySyncFollowBottom;
  const followTimerRef = useRef<number | null>(null);
  const userScrollGuardUntilRef = useRef(0);
  const railDraggingRef = useRef(false);
  const streamFollowPausedUntilRef = useRef(0);
  const bottomFollowLeaseUntilRef = useRef(0);
  const lastProgrammaticBottomAtRef = useRef(0);
  // 用户没有主动离底时，动态卡片（PlanCard / Actions / markdown）增高也要维持贴底。
  // 不能只看当前 gap：高度刚变大的一帧 gap 会突然 > threshold，旧逻辑会误判“离底”。
  const bottomStickIntentRef = useRef(true);
  const contentResizeFollowRafRef = useRef<number | null>(null);
  const contentResizeSettleTimersRef = useRef<number[]>([]);
  /* 滚顶回捞历史的闸门: loading 防并发, reachedStart 到最早后不再打 DB. session 切换重置. */
  const reachTopLoadingRef = useRef(false);
  const reachedStartRef = useRef(false);
  /* prepend 落地后待补偿 — 由 rows-change 的 row-commit layout effect 在 paint 前消费.
   * anchorScroll* 是触发回捞瞬间的几何, 用 scrollHeight 增量补偿比估高前缀更稳. */
  const pendingPrependRef = useRef<{
    loaded: number;
    anchorScrollTop: number;
    anchorScrollHeight: number;
  } | null>(null);
  /* onReachTop 每轮可能换引用 (session 切换); 用 ref 让 onScroll 监听器读到最新的, 不必重绑. */
  const onReachTopRef = useRef(onReachTop);
  onReachTopRef.current = onReachTop;
  useEffect(() => {
    reachTopLoadingRef.current = false;
    reachedStartRef.current = false;
  }, [sessionId, scrollScope]);
  const atBottomRef = useRef(true);
  /* 用户主动滚动 latch — scroll metrics 有几帧延迟,
   *  恢复期间 RAF tick 高频, 用户上滚不到 atBottomThreshold (40px) 就被 RAF 拽回 → 翻不动.
   *  wheel / touchmove 一发生立刻 latch, 直到用户自己再滚回底部 (atBottom=true) 才解除. */
  const userScrolledAwayRef = useRef(false);
  const currentSessionScrollKeyRef = useRef(
    timelineSessionScrollKey(sessionId, scrollScope)
  );
  const pendingSessionRestoreRef = useRef<PendingSessionRestore | null>(null);
  const restoreHistoryInFlightRef = useRef(false);
  const restoreHistoryTriedKeysRef = useRef(new Set<string>());
  const restoreBottomHoldRef = useRef<{ key: string; until: number } | null>(
    null
  );
  const restoredAwayScrollKeyRef = useRef<string | null>(null);
  const initialScrollResolvedKeysRef = useRef<Set<string>>(new Set());
  const [durableScrollStateVersion, setDurableScrollStateVersion] =
    useState(0);
  const scrollStateWritePauseRef = useRef<{ key: string; until: number } | null>(
    null
  );
  const scrollStatePersistTimerRef = useRef<number | null>(null);
  const rowsLengthSnapshotRef = useRef(rows.length);
  rowsLengthSnapshotRef.current = rows.length;
  const currentRowKeySignature = useMemo(
    () => rowKeySignature(rowKeys),
    [rowKeys]
  );
  /* 上一 commit 的行签名 — 切换会话时判断 DOM 是否已换成新会话 (见切换 effect 注释) */
  const lastCommittedSignatureRef = useRef(currentRowKeySignature);
  const isSessionRestoreBlockingBottom = useCallback(() => {
    const currentKey = currentSessionScrollKeyRef.current;
    const hold = restoreBottomHoldRef.current;
    return (
      pendingSessionRestoreRef.current?.key === currentKey ||
      restoredAwayScrollKeyRef.current === currentKey ||
      (hold?.key === currentKey && performance.now() < hold.until)
    );
  }, []);
  const isUserScrollGuardActive = useCallback(() => {
    return (
      railDraggingRef.current ||
      performance.now() < userScrollGuardUntilRef.current
    );
  }, []);
  const armUserScrollGuard = useCallback((ms = 700) => {
    const until = performance.now() + ms;
    userScrollGuardUntilRef.current = until;
    setTimelineUserScrollGuardUntil(
      Math.max(until, userScrollGuardUntilRef.current)
    );
  }, []);
  const pauseStreamFollow = useCallback((ms = 900) => {
    streamFollowPausedUntilRef.current = Math.max(
      streamFollowPausedUntilRef.current,
      performance.now() + ms
    );
  }, []);
  const leaseBottomFollow = useCallback((ms: number) => {
    bottomFollowLeaseUntilRef.current = Math.max(
      bottomFollowLeaseUntilRef.current,
      performance.now() + ms
    );
  }, []);
  const hasBottomFollowLease = useCallback(
    () => performance.now() < bottomFollowLeaseUntilRef.current,
    []
  );
  const canAutoFollowBottom = useCallback(() => {
    return sessionStreaming || hasBottomFollowLease();
  }, [hasBottomFollowLease, sessionStreaming]);
  /* 静止态贴底：流结束后卡片异步长高时仍应跟随。
   * canAutoFollowBottom() 只覆盖 streaming / lease，不能单独否决 bottomStickIntent。
   * 用户主动上滚离底 (userScrolledAway) 仍一票否决。 */
  const allowsBottomFollow = useCallback(() => {
    if (userScrolledAwayRef.current) return false;
    if (canAutoFollowBottom()) return true;
    return bottomStickIntentRef.current || atBottomRef.current;
  }, [canAutoFollowBottom]);
  const canStreamFollowBottom = useCallback(() => {
    const el = scrollerElRef.current;
    if (!el) return false;
    if (!sessionStreaming) return false;
    if (
      railDraggingRef.current ||
      isSessionRestoreBlockingBottom() ||
      isUserScrollGuardActive() ||
      userScrolledAwayRef.current
    )
      return false;
    if (performance.now() < streamFollowPausedUntilRef.current) return false;
    const gap = el.scrollHeight - el.clientHeight - el.scrollTop;
    const nearBottom = gap <= STICK_BOTTOM_THRESHOLD;
    if (!nearBottom) {
      /* 关键：这里不能把 userScrolledAwayRef 置 true。
       * gap 变大可能只是 streaming / composer / Actions 动画导致 scrollHeight 变化，
       * 如果误判成“用户离底”，用户向下拉到底时 follow-bottom 会永久失效，表现为到底反弹。 */
      atBottomRef.current = false;
      feedShellRef.current?.classList.add("show-scroll-btn");
      return false;
    }
    atBottomRef.current = true;
    userScrolledAwayRef.current = false;
    bottomStickIntentRef.current = true;
    librarySyncFollowBottomRef.current?.(true);
    feedShellRef.current?.classList.remove("show-scroll-btn");
    return true;
  }, [
    isSessionRestoreBlockingBottom,
    isUserScrollGuardActive,
    sessionStreaming,
  ]);
  const lastUserScrollAtRef = useRef(0);
  const pointerHeldRef = useRef(false);
  const lastAnyScrollAtRef = useRef(0);
  const lastUserAwayAtRef = useRef(0);
  const idleAutoBottomTimerRef = useRef<number | null>(null);
  const bottomSafeRafRef = useRef<number | null>(null);
  const bottomSettleTimersRef = useRef<number[]>([]);
  const bottomSentinelRef = useRef<HTMLDivElement>(null);
  const lastBottomSafePxRef = useRef(24);
  const clearBottomSettleTimers = useCallback(() => {
    for (const timer of bottomSettleTimersRef.current)
      window.clearTimeout(timer);
    bottomSettleTimersRef.current = [];
  }, []);
  const clearContentResizeSettleTimers = useCallback(() => {
    for (const timer of contentResizeSettleTimersRef.current)
      window.clearTimeout(timer);
    contentResizeSettleTimersRef.current = [];
  }, []);
  const getVisibleScrollAnchor = useCallback((el: HTMLElement) => {
    const scrollerRect = el.getBoundingClientRect();
    const nodes = el.querySelectorAll<HTMLElement>(
      ".atl-row-clamp[data-timeline-row-index][data-timeline-row-key]"
    );
    for (const node of nodes) {
      const rect = node.getBoundingClientRect();
      if (rect.bottom <= scrollerRect.top + 6) continue;
      if (rect.top >= scrollerRect.bottom - 6) break;
      const key = node.dataset.timelineRowKey;
      const index = Number(node.dataset.timelineRowIndex);
      if (!key || !Number.isFinite(index)) continue;
      return {
        key,
        index,
        offsetTop: Math.round((rect.top - scrollerRect.top) * 10) / 10,
      };
    }
    return null;
  }, []);
  const rememberCurrentScrollState = useCallback(
    (
      key = currentSessionScrollKeyRef.current,
      overrides?: Partial<
        Pick<
          PersistedTimelineScrollState,
          "atBottom" | "userScrolledAway" | "bottomStickIntent"
        >
      >
    ) => {
      const pending = pendingSessionRestoreRef.current;
      if (pending?.key === key) return;
      const writePause = scrollStateWritePauseRef.current;
      if (writePause?.key === key) {
        if (performance.now() < writePause.until) return;
        scrollStateWritePauseRef.current = null;
      }
      const el = scrollerElRef.current;
      if (!el) return;
      const scrollHeight = el.scrollHeight;
      const clientHeight = el.clientHeight;
      const maxScroll = Math.max(0, scrollHeight - clientHeight);
      const canScroll = scrollHeight > clientHeight + 8;
      const gapToBottom = canScroll ? maxScroll - el.scrollTop : 0;
      const atBottom =
        overrides?.atBottom ??
        (!canScroll || gapToBottom <= STICK_BOTTOM_THRESHOLD);
      const userScrolledAway =
        overrides?.userScrolledAway ??
        (canScroll && !atBottom
          ? true
          : userScrolledAwayRef.current && !atBottom);
      const anchor =
        canScroll && !atBottom ? getVisibleScrollAnchor(el) : null;
      rememberTimelineScrollState(key, {
        scrollTop: Math.max(0, Math.min(maxScroll, el.scrollTop)),
        scrollHeight,
        clientHeight,
        maxScroll,
        gapToBottom,
        anchorKey: anchor?.key,
        anchorIndex: anchor?.index,
        anchorOffsetTop: anchor?.offsetTop,
        atBottom,
        userScrolledAway,
        bottomStickIntent:
          overrides?.bottomStickIntent ??
          (atBottom ? true : bottomStickIntentRef.current && !userScrolledAway),
        rowsLength: rowsLengthSnapshotRef.current,
        updatedAt: Date.now(),
      });
    },
    [getVisibleScrollAnchor]
  );
  const scrollToBottom = useCallback(
    (smooth: boolean, force = false, source: ScrollBottomSource = "auto") => {
      const el = scrollerRef.current as HTMLElement | null;
      if (!el || !("scrollTo" in el)) return;
      const bypassSessionRestore =
        source === "user" || source === "new-message";
      if (isSessionRestoreBlockingBottom() && !bypassSessionRestore) return;
      if (!force && isUserScrollGuardActive())
        return;
      if (force) {
        if (source === "new-message") leaseBottomFollow(12000);
        else if (source === "user") leaseBottomFollow(2600);
        else if (sessionStreaming) leaseBottomFollow(1800);
        if (
          bypassSessionRestore &&
          restoredAwayScrollKeyRef.current === currentSessionScrollKeyRef.current
        )
          restoredAwayScrollKeyRef.current = null;
        if (
          bypassSessionRestore &&
          restoreBottomHoldRef.current?.key === currentSessionScrollKeyRef.current
        )
          restoreBottomHoldRef.current = null;
        streamFollowPausedUntilRef.current = 0;
        userScrolledAwayRef.current = false;
        bottomStickIntentRef.current = true;
        librarySyncFollowBottomRef.current?.(true);
      }
      const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
      const gap = maxScroll - el.scrollTop;
      if (Math.abs(gap) < 1) {
        atBottomRef.current = true;
        userScrolledAwayRef.current = false;
        bottomStickIntentRef.current = true;
        librarySyncFollowBottomRef.current?.(true);
        feedShellRef.current?.classList.remove("show-scroll-btn");
        rememberCurrentScrollState(undefined, {
          atBottom: true,
          userScrolledAway: false,
          bottomStickIntent: true,
        });
        return;
      }
      bottomStickIntentRef.current = true;
      librarySyncFollowBottomRef.current?.(true);
      lastProgrammaticBottomAtRef.current = performance.now();
      /* 续租贴底 — 只要还在真的往底部滚, viewport hook 的行高锚点保持就让位 (互斥,
       * 避免两套系统同帧对着 scrollTop 反向拉扯). 220ms > 90ms 的 follow interval,
       * 流式期每 tick 续租一次即可保持连续覆盖. */
      setTimelineBottomFollowUntil(performance.now() + 220);
      /* 单一到底实现 — 库接管定位时一律走库, 见 libraryScrollToEnd 注释.
       * 11 处到底调用 (发消息回底 / 4.5s 空闲纠偏 / 恢复解闩 / ask 卡露出 / settle 序列…)
       * 全部收敛到这一行, 产品行为一个不改, 但不再有第二个人写 scrollTop. */
      const toEnd = libraryScrollToEndRef.current;
      if (libraryOwnsPrependAnchor && toEnd) {
        toEnd({ behavior: smooth ? "smooth" : "auto" });
      } else {
        el.scrollTo({ top: maxScroll, behavior: smooth ? "smooth" : "auto" });
      }
      requestAnimationFrame(() =>
        rememberCurrentScrollState(undefined, {
          atBottom: true,
          userScrolledAway: false,
          bottomStickIntent: true,
        })
      );
    },
    [
      isSessionRestoreBlockingBottom,
      isUserScrollGuardActive,
      leaseBottomFollow,
      libraryOwnsPrependAnchor,
      rememberCurrentScrollState,
      sessionStreaming,
    ]
  );
  const isLiveAtBottom = useCallback((threshold = STICK_BOTTOM_THRESHOLD) => {
    const el = scrollerElRef.current;
    if (!el) return true;
    return (
      Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop) <= threshold
    );
  }, []);

  const scrollToTop = useCallback(
    (smooth: boolean) => {
      const el = scrollerRef.current as HTMLElement | null;
      if (!el || !("scrollTo" in el)) return;
      armUserScrollGuard(900);
      lastUserAwayAtRef.current = performance.now();
      userScrolledAwayRef.current = true;
      bottomStickIntentRef.current = false;
      atBottomRef.current = false;
      librarySyncFollowBottomRef.current?.(false);
      el.scrollTo({ top: 0, behavior: smooth ? "smooth" : "auto" });
      requestAnimationFrame(() =>
        rememberCurrentScrollState(undefined, {
          atBottom: false,
          userScrolledAway: true,
          bottomStickIntent: false,
        })
      );
    },
    [armUserScrollGuard, rememberCurrentScrollState]
  );
  const scheduleFollowBottom = useCallback(() => {
    if (followTimerRef.current !== null) return;
    followTimerRef.current = window.setTimeout(() => {
      followTimerRef.current = null;
      if (libraryOwnsPrependAnchor) return;
      if (canStreamFollowBottom()) {
        scrollToBottom(false);
      }
    }, STREAM_FOLLOW_INTERVAL_MS);
  }, [canStreamFollowBottom, libraryOwnsPrependAnchor, scrollToBottom]);
  const forceScrollToBottom = useCallback(
    (smooth: boolean, source: ScrollBottomSource = "auto") => {
      /* 真·到底不是一次 scrollHeight 写入就结束：底部服务条/composer、Actions 展开动画、
       * streaming 结束后的 markdown/工具卡片收尾都会在后续几帧改变可视高度。这里做短促
       * settle 序列，只在 force 场景清掉用户离底 latch，不在普通滚动中抢用户手势。 */
      if (source === "auto" && isSessionRestoreBlockingBottom()) return;
      const scheduledKey = currentSessionScrollKeyRef.current;
      clearBottomSettleTimers();
      scrollToBottom(smooth, true, source);
      requestAnimationFrame(() => {
        if (currentSessionScrollKeyRef.current === scheduledKey)
          scrollToBottom(false, true, source);
      });
      for (const delay of [90, 220, 480, 900]) {
        const timer = window.setTimeout(() => {
          if (
            currentSessionScrollKeyRef.current === scheduledKey &&
            !railDraggingRef.current &&
            !isUserScrollGuardActive()
          )
            scrollToBottom(false, true, source);
        }, delay);
        bottomSettleTimersRef.current.push(timer);
      }
    },
    [
      clearBottomSettleTimers,
      isSessionRestoreBlockingBottom,
      isUserScrollGuardActive,
      scrollToBottom,
    ]
  );

  const revealBlockingAsk = useCallback(
    (stepId?: string) => {
      const now = performance.now();
      userScrolledAwayRef.current = true;
      bottomStickIntentRef.current = false;
      atBottomRef.current = false;
      librarySyncFollowBottomRef.current?.(false);
      userScrollGuardUntilRef.current = Math.max(
        userScrollGuardUntilRef.current,
        now + 1400
      );
      setTimelineUserScrollGuardUntil(userScrollGuardUntilRef.current);
      streamFollowPausedUntilRef.current = Math.max(
        streamFollowPausedUntilRef.current,
        now + 1600
      );
      feedShellRef.current?.classList.remove("show-scroll-btn");

      const scrollTargetIntoView = () => {
        const root = scrollerElRef.current;
        if (!root) return false;
        const escapeIdent = (value: string) =>
          typeof CSS !== "undefined" && typeof CSS.escape === "function"
            ? CSS.escape(value)
            : value.replace(/"/g, '\\"');
        const escaped = stepId ? escapeIdent(stepId) : null;
        const exactSelectors = escaped
          ? [
              `.atl-tool[data-timeline-step-id="${escaped}"] .atl-ask.is-waiting`,
              `.atl-tool[data-timeline-step-id="${escaped}"].is-awaiting-ask`,
              `.atl-activity-child[data-timeline-step-ids~="${escaped}"] .atl-ask.is-waiting`,
              `.atl-activity-child[data-timeline-step-ids~="${escaped}"] .atl-tool.is-awaiting-ask`,
              `.atl-row-clamp[data-timeline-step-ids~="${escaped}"] .atl-ask.is-waiting`,
              `.atl-row-clamp[data-timeline-step-ids~="${escaped}"] .atl-tool.is-awaiting-ask`,
            ]
          : [];
        let target: HTMLElement | null = null;
        for (const selector of exactSelectors) {
          target = root.querySelector<HTMLElement>(selector);
          if (target) break;
        }
        if (!target && !escaped) {
          const visibleWaitingTargets = root.querySelectorAll<HTMLElement>(
            ".atl-ask.is-waiting, .atl-tool.is-awaiting-ask"
          );
          target = visibleWaitingTargets.item(visibleWaitingTargets.length - 1);
        }
        let exact = !!target;
        if (!target && escaped) {
          target =
            root.querySelector<HTMLElement>(
              `.atl-activity-child[data-timeline-step-ids~="${escaped}"]`
            ) ??
            root.querySelector<HTMLElement>(
              `.atl-row-clamp[data-timeline-step-ids~="${escaped}"]`
            );
          exact = false;
        }
        if (!target) return false;
        target.scrollIntoView({
          block: "center",
          inline: "nearest",
          behavior: "smooth",
        });
        const pulseTarget =
          target.closest<HTMLElement>(".atl-activity-child, .atl-row-clamp") ??
          target;
        pulseTarget.classList.add("atl-row-clamp--reveal-pulse");
        window.setTimeout(
          () => pulseTarget.classList.remove("atl-row-clamp--reveal-pulse"),
          920
        );
        scheduleStableRowHeightSample("reveal-blocking-ask", 140);
        return exact;
      };

      if (scrollTargetIntoView()) return;
      const rowIndex = stepId
        ? rows.findIndex((row) => rowContainsStepId(row, stepId))
        : (() => {
            for (let index = rows.length - 1; index >= 0; index--) {
              if (rowHasWaitingAsk(rows[index])) return index;
            }
            return -1;
          })();
      if (rowIndex >= 0 && scrollerElRef.current) {
        const toIndex = libraryScrollToIndexRef.current;
        if (libraryOwnsPrependAnchor && toIndex) {
          toIndex(rowIndex, { align: "center", behavior: "smooth" });
        } else {
          const estimatedTop = rowHeightPrefix[rowIndex] ?? 0;
          const viewportH = scrollerElRef.current.clientHeight || 0;
          scrollerElRef.current.scrollTo({
            top: Math.max(0, estimatedTop - viewportH * 0.28),
            behavior: "smooth",
          });
        }
        scheduleStableRowHeightSample("reveal-blocking-ask-estimate", 80);
        let revealed = false;
        const retryReveal = () => {
          if (revealed) return;
          revealed = scrollTargetIntoView();
          if (!revealed)
            scheduleStableRowHeightSample("reveal-blocking-ask-retry", 80);
        };
        for (const delay of [80, 180, 360, 700, 1100]) {
          window.setTimeout(retryReveal, delay);
        }
        return;
      }
      for (const delay of [80, 180, 360]) {
        window.setTimeout(scrollTargetIntoView, delay);
      }
    },
    [libraryOwnsPrependAnchor, rowHeightPrefix, rows, scheduleStableRowHeightSample]
  );

  useEffect(() => {
    const onRevealBlockingAsk = (event: Event) => {
      const detail = (event as CustomEvent<{ id?: string }>).detail;
      revealBlockingAsk(detail?.id);
    };
    window.addEventListener(
      "neox:timeline-reveal-blocking-ask",
      onRevealBlockingAsk
    );
    return () =>
      window.removeEventListener(
        "neox:timeline-reveal-blocking-ask",
        onRevealBlockingAsk
      );
  }, [revealBlockingAsk]);
  const feedShellRef = useRef<HTMLDivElement>(null);
  const scrollThumbElRef = useRef<HTMLSpanElement>(null);
  const scrollPaintTimerRef = useRef<number | null>(null);
  // 只记录滚动状态给 JS guard 用，不再给 feed shell 切 .is-scrolling。
  // 大范围 class 切换会让所有 .atl-feed-shell.is-scrolling 后代选择器重算，长 timeline 下反而卡。
  const scrollMetricsRafRef = useRef<number | null>(null);
  const scrollThumbRafRef = useRef<number | null>(null);
  const scrollRailMetricsRef = useRef({ trackPx: 0, thumbH: 30, maxTop: 0 });
  const scrollRailBoundsRef = useRef({
    top: -1,
    bottom: -1,
    right: -1,
    height: -1,
  });
  const scrollRailBoundsRafRef = useRef<number | null>(null);
  /* 连续一致性确认: 过渡期测到的候选值, 120ms 后复测一致才应用 (见 updateScrollRailBoundsNow) */
  const scrollRailPendingRef = useRef<{ height: number; top: number; bottom: number; right: number } | null>(null);
  const scrollRailGeomSigRef = useRef<string>("");
  const scrollRailConfirmTimeoutRef = useRef<number | null>(null);
  /* 兜底 timeout: 布局 transition (~300ms CSS 动画) 结束后补测一次.
   * 场景: sidebar 折叠 / composer 高度变化 等外部布局迁移会让 panel.rect.right 平移,
   *       但 shell/panel 自身尺寸不变 → ResizeObserver 不再触发, CSS 变量卡在过渡中值,
   *       滚动条 rail 飘到 timeline 中央. 300ms + 50ms 保险 = 350ms 兜底重测. */
  const scrollRailBoundsLateTimeoutRef = useRef<number | null>(null);
  const scrollStaticMetricsRef = useRef({
    scrollHeight: 0,
    clientHeight: 0,
    maxScroll: 1,
    canScroll: false,
    longEnoughForRail: false,
  });
/** 一次程序滚动之后多久内到达的 scroll 事件算它的回声, 不当成用户在滚。
 *  160ms > 一帧, 又远小于跟随间隔外的真实用户手势间隔。 */
const PROGRAMMATIC_SCROLL_ECHO_MS = 160;

  const scrollMetricsFreezeRef = useRef<{
    active: boolean;
    maxScroll: number;
  }>({ active: false, maxScroll: 1 });
  const {
    noteDebugScrollActivity,
    sampleDebugScrollMutation,
    scheduleDebugScrollMutation,
    stopDebugFrameLoop,
  } = useTimelineDiagnostics({
    rows,
    rowKeys,
    sessionId,
    scrollerElRef,
    scrollingFlagRef,
    scrollStaticMetricsRef,
  });
  const lastScrollThumbRef = useRef({
    y: -1,
    h: -1,
    canScroll: false,
    atTop: true,
    long: false,
  });
  const updateScrollThumbFast = useCallback(() => {
    const el = scrollerRef.current as HTMLElement | null;
    const thumb = scrollThumbElRef.current;
    if (!el || !thumb || isTimelineScrollRailDebugDisabled()) return;
    const cached = scrollRailMetricsRef.current;
    const stat = scrollStaticMetricsRef.current;
    if (!stat.longEnoughForRail || cached.maxTop <= 0) return;
    const maxScroll = Math.max(
      1,
      (() => {
        const pad = el.querySelector(
          ".atl-feed__virtual-pad--bottom"
        ) as HTMLElement | null;
        const est = pad
          ? Number(pad.dataset.atlEstTotal || 0)
          : 0;
        if (Number.isFinite(est) && est > el.clientHeight) {
          return est - el.clientHeight;
        }
        return el.scrollHeight - el.clientHeight;
      })()
    );
    const thumbTop =
      Math.round(
        Math.max(
          0,
          Math.min(
            cached.maxTop,
            (el.scrollTop / maxScroll) * cached.maxTop
          )
        ) * 100
      ) / 100;
    if (Math.abs(lastScrollThumbRef.current.y - thumbTop) >= 0.5) {
      // 只更新 thumb 自己的 compositor transform；不要写父级 CSS var，避免整棵 timeline 样式失效产生拖影。
      thumb.style.transform = `translate3d(0, ${thumbTop}px, 0)`;
      lastScrollThumbRef.current.y = thumbTop;
    }
  }, []);

  const scheduleScrollThumbFast = useCallback(() => {
    if (scrollThumbRafRef.current !== null) return;
    scrollThumbRafRef.current = window.requestAnimationFrame(() => {
      scrollThumbRafRef.current = null;
      updateScrollThumbFast();
    });
  }, [updateScrollThumbFast]);

  const refreshScrollMetrics = useCallback(
    (reportedAtBottom?: boolean) => {
      const el = scrollerRef.current as HTMLElement | null;
      if (!el) return;

      const scrollHeight = el.scrollHeight;
      const clientHeight = el.clientHeight;
      const maxScroll = Math.max(1, scrollHeight - clientHeight);
      const canScroll = scrollHeight > clientHeight + 8;
      const longEnoughForRail = canScroll && scrollHeight > clientHeight * 1.35;

      /* 翻历史中只刷新 atBottom 判定, 不改 maxScroll / thumb 高度 —— 否则换片导致的
       * scrollHeight 抖动会直接变成进度条跳动. */
      const freezeBrowsing =
        scrollingFlagRef.current || isTimelineUserScrollGuardActive();
      if (!freezeBrowsing) {
        scrollStaticMetricsRef.current = {
          scrollHeight,
          clientHeight,
          maxScroll,
          canScroll,
          longEnoughForRail,
        };
        scrollMetricsFreezeRef.current = { active: false, maxScroll };
      } else if (!scrollMetricsFreezeRef.current.active) {
        scrollMetricsFreezeRef.current = {
          active: true,
          maxScroll: scrollStaticMetricsRef.current.maxScroll || maxScroll,
        };
      }

      if (!canScroll) {
        atBottomRef.current = true;
        if (!userScrolledAwayRef.current) bottomStickIntentRef.current = true;
      } else if (typeof reportedAtBottom === "boolean") {
        atBottomRef.current = reportedAtBottom;
        if (reportedAtBottom) bottomStickIntentRef.current = true;
        else if (userScrolledAwayRef.current)
          bottomStickIntentRef.current = false;
      } else {
        atBottomRef.current =
          scrollHeight - clientHeight - el.scrollTop <= STICK_BOTTOM_THRESHOLD;
        if (atBottomRef.current) bottomStickIntentRef.current = true;
        else if (userScrolledAwayRef.current)
          bottomStickIntentRef.current = false;
      }

      if (isTimelineScrollRailDebugDisabled()) return;

      const shell = feedShellRef.current;
      if (!shell) return;
      const atTop = !canScroll || el.scrollTop <= 24;
      const railOn = freezeBrowsing
        ? scrollStaticMetricsRef.current.longEnoughForRail
        : longEnoughForRail;
      shell.classList.toggle(
        "show-scroll-btn",
        canScroll && !atBottomRef.current
      );
      shell.classList.toggle("show-scroll-top", canScroll && !atTop);
      shell.classList.toggle("show-scroll-nav", railOn);
      lastScrollThumbRef.current.canScroll = canScroll;
      lastScrollThumbRef.current.atTop = atTop;
      lastScrollThumbRef.current.long = railOn;

      if (railOn && !freezeBrowsing) {
        const cached = scrollRailMetricsRef.current;
        /* thumb 行程必须跟真实 track DOM 高度一致 —— 不能用
         * window.innerHeight - top - bottom 推算（fixed 被祖先 transform
         * 劫持时推算值虚大，滚到底会溢出）。拖拽路径已用 track rect。 */
        const trackEl = shell.querySelector<HTMLElement>(
          ".atl-scroll-nav__track"
        );
        const liveTrackPx = trackEl?.getBoundingClientRect().height ?? 0;
        if (liveTrackPx > 0) cached.trackPx = liveTrackPx;
        const trackPx = Math.max(120, liveTrackPx || cached.trackPx || clientHeight);
        const ratio = clientHeight / Math.max(scrollHeight, 1);
        const naturalThumbH = trackPx * ratio;
        // track 是全高坐标系；thumb 保持短小，避免再次变成一条长紫条。
        const thumbH = Math.round(
          Math.max(22, Math.min(Math.min(58, trackPx * 0.18), naturalThumbH))
        );
        const maxTop = Math.max(0, trackPx - thumbH);
        cached.thumbH = thumbH;
        cached.maxTop = maxTop;
        if (lastScrollThumbRef.current.h !== thumbH) {
          shell.style.setProperty("--atl-scroll-thumb-height", `${thumbH}px`);
          if (scrollThumbElRef.current)
            scrollThumbElRef.current.style.height = `${thumbH}px`;
          lastScrollThumbRef.current.h = thumbH;
        }
      }
      updateScrollThumbFast();
    },
    [updateScrollThumbFast]
  );

  const scheduleRefreshScrollMetrics = useCallback(() => {
    if (scrollMetricsRafRef.current !== null) return;
    scrollMetricsRafRef.current = window.requestAnimationFrame(() => {
      scrollMetricsRafRef.current = null;
      refreshScrollMetrics();
    });
  }, [refreshScrollMetrics]);

  const restoreScrollState = useCallback(
    (key: string, state: PersistedTimelineScrollState) => {
      const el = scrollerElRef.current;
      if (!el || rows.length === 0) return false;
      const pinLive = shouldRestoreLiveSessionToBottom({
        sessionStreaming,
        saved: state,
        lastRowKey: rowKeys[rowKeys.length - 1],
      });
      if (pinLive) {
        state = { ...state, atBottom: true, userScrolledAway: false };
      }
      clearBottomSettleTimers();
      clearContentResizeSettleTimers();
      const scrollHeight = el.scrollHeight;
      const clientHeight = el.clientHeight;
      const maxScroll = Math.max(0, scrollHeight - clientHeight);
      const canScroll = scrollHeight > clientHeight + 8;
      const anchorIndex =
        state.anchorKey !== undefined ? rowKeys.indexOf(state.anchorKey) : -1;
      const anchorTop =
        anchorIndex >= 0 ? rowHeightPrefix[anchorIndex] : undefined;
      const anchorOffsetTop = state.anchorOffsetTop ?? 0;
      const clampScrollTop = (value: number) =>
        Math.max(
          0,
          Math.min(Math.max(0, el.scrollHeight - el.clientHeight), value)
        );
      const nextScrollTop = state.atBottom
        ? maxScroll
        : anchorTop !== undefined
          ? clampScrollTop(anchorTop - anchorOffsetTop)
          : Math.max(0, Math.min(maxScroll, state.scrollTop));
      if (isTimelineDebugEnabled()) {
        logTimelineJank("scroll-restore", {
          key,
          rows: rows.length,
          savedAtBottom: state.atBottom,
          savedScrollTop: state.scrollTop,
          nextScrollTop,
          scrollHeight,
          clientHeight,
          maxScroll,
          anchorKey: state.anchorKey,
          anchorIndex,
        });
      }
      if (!state.atBottom) {
        scrollStateWritePauseRef.current = {
          key,
          until: performance.now() + 900,
        };
      }
      if (
        !state.atBottom &&
        anchorIndex >= 0 &&
        libraryScrollToIndexRef.current
      ) {
        libraryScrollToIndexRef.current(anchorIndex, { align: "start" });
        el.scrollTop = clampScrollTop(el.scrollTop - anchorOffsetTop);
      } else if (state.atBottom && libraryScrollToEndRef.current) {
        libraryScrollToEndRef.current({ behavior: "auto" });
      } else {
        el.scrollTop = nextScrollTop;
      }
      const restoredTop = el.scrollTop;
      const liveMaxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
      const gapToBottom = canScroll ? liveMaxScroll - restoredTop : 0;
      const restoredAtBottom =
        !canScroll || gapToBottom <= STICK_BOTTOM_THRESHOLD;
      atBottomRef.current = restoredAtBottom;
      userScrolledAwayRef.current = !restoredAtBottom && state.userScrolledAway;
      librarySyncFollowBottomRef.current?.(
        restoredAtBottom || !userScrolledAwayRef.current
      );
      if (!restoredAtBottom) {
        /* 切回正在 streaming 的会话时, lastUserAway/Scroll 还是老时间戳, idle>4.5s
         * 的自动贴底会立刻把刚恢复的位置拉到底。恢复到非底部后把该 session
         * 视为用户正在读历史, 直到用户自己到底/发新消息才解除。 */
        const now = performance.now();
        lastUserAwayAtRef.current = now;
        lastUserScrollAtRef.current = now;
        restoredAwayScrollKeyRef.current = key;
        restoreBottomHoldRef.current = {
          key,
          until: Math.max(
            restoreBottomHoldRef.current?.key === key
              ? restoreBottomHoldRef.current.until
              : 0,
            now + TIMELINE_SCROLL_RESTORE_BOTTOM_HOLD_MS
          ),
        };
      } else {
        if (restoredAwayScrollKeyRef.current === key)
          restoredAwayScrollKeyRef.current = null;
        if (restoreBottomHoldRef.current?.key === key)
          restoreBottomHoldRef.current = null;
      }
      bottomStickIntentRef.current =
        restoredAtBottom || (state.bottomStickIntent && !state.userScrolledAway);
      if (!restoredAtBottom) {
        feedShellRef.current?.classList.add("show-scroll-btn");
      } else {
        feedShellRef.current?.classList.remove("show-scroll-btn");
      }
      commitViewportState(
        { scrollTop: restoredTop, height: el.clientHeight },
        "sync"
      );
      refreshScrollMetrics(restoredAtBottom);
      scheduleScrollThumbFast();
      if (restoredAtBottom) {
        rememberCurrentScrollState(key, {
          atBottom: true,
          userScrolledAway: false,
          bottomStickIntent: true,
        });
      }
      const refineToAnchor = () => {
        if (restoredAtBottom || !state.anchorKey) return;
        const node = findMountedRowByKey(el, state.anchorKey);
        if (!node) return;
        const scrollerRect = el.getBoundingClientRect();
        const nodeRect = node.getBoundingClientRect();
        const delta = nodeRect.top - scrollerRect.top - anchorOffsetTop;
        if (Math.abs(delta) < 1) {
          if (scrollStateWritePauseRef.current?.key === key)
            scrollStateWritePauseRef.current = null;
          rememberCurrentScrollState(key, {
            atBottom: false,
            userScrolledAway: true,
            bottomStickIntent: false,
          });
          return;
        }
        const refinedTop = clampScrollTop(el.scrollTop + delta);
        el.scrollTop = refinedTop;
        commitViewportState(
          { scrollTop: refinedTop, height: el.clientHeight },
          "sync"
        );
        if (scrollStateWritePauseRef.current?.key === key)
          scrollStateWritePauseRef.current = null;
        rememberCurrentScrollState(key, {
          atBottom: false,
          userScrolledAway: true,
          bottomStickIntent: false,
        });
      };
      requestAnimationFrame(refineToAnchor);
      for (const delay of [60, 160, 360, 720]) {
        window.setTimeout(refineToAnchor, delay);
      }
      window.setTimeout(() => {
        const writePause = scrollStateWritePauseRef.current;
        if (writePause?.key === key) scrollStateWritePauseRef.current = null;
      }, 920);
      return true;
    },
    [
      commitViewportState,
      clearBottomSettleTimers,
      clearContentResizeSettleTimers,
      refreshScrollMetrics,
      rememberCurrentScrollState,
      rowHeightPrefix,
      rowKeys,
      rows.length,
      scheduleScrollThumbFast,
      sessionStreaming,
    ]
  );

  /**
   * 右侧快速滚动条是整块 Timeline 的“位置指示器”，不是 feed 内的一张浮卡。
   * 因为 Timeline 本身是 header / feed / bgtasks / composer 的 grid，滚动容器只占中间 1fr；
   * 如果把 thumb absolute 在 feed 里，它天然只能覆盖中间区域，看起来就像结构断层。
   * 这里测量最近的 .agent-timeline，用 fixed vars 让 thumb 视觉上从标题区贯穿到底部输入区。
   */
  const updateScrollRailBoundsNow = useCallback(() => {
    scrollRailBoundsRafRef.current = null;
    const shell = feedShellRef.current;
    if (!shell) return;
    const panel = shell.closest<HTMLElement>(".agent-timeline");
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    /* 面板隐藏中 (设置弹窗盖住 / 窗口切走) rect 全 0 — 别把垃圾值写进 CSS 变量,
     * 等 visibilitychange / RO 恢复后重测。 */
    if (rect.width <= 0 || rect.height <= 0) return;

    const geomSig = `${rect.top}|${rect.bottom}|${rect.left}|${rect.right}|${window.innerWidth}|${window.innerHeight}`;
    if (
      geomSig === scrollRailGeomSigRef.current &&
      scrollRailBoundsRef.current.right >= 0 &&
      scrollRailPendingRef.current === null
    ) {
      return;
    }

    /* 滚动条坐标必须从 Timeline 顶部开始。
     * .atl-scroll-nav 是 position:fixed，但祖先 transform/backdrop-filter 会把它
     * 劫持成相对 timeline 面板的 containing block。若仍按窗口坐标写
     * --atl-scroll-nav-top/bottom，实际渲染会被再推低一截，trackPx 用
     * window.innerHeight - top - bottom 也会虚大 → thumb 顶不到顶 / 底溢出。
     * 探测：临时写 top/bottom=0，若 rail.top≈panel.top 则已劫持，改写 panel-relative inset。 */
    const inset = 4;
    const rail = shell.querySelector<HTMLElement>(".atl-scroll-nav");
    const varHost = rail ?? shell;
    let top: number;
    let bottom: number;
    let right: number;
    if (rail) {
      const prevTopVar = varHost.style.getPropertyValue("--atl-scroll-nav-top");
      const prevBottomVar = varHost.style.getPropertyValue(
        "--atl-scroll-nav-bottom"
      );
      const prevRightVar = varHost.style.getPropertyValue(
        "--atl-scroll-nav-right"
      );
      varHost.style.setProperty("--atl-scroll-nav-top", "0px");
      varHost.style.setProperty("--atl-scroll-nav-bottom", "0px");
      varHost.style.setProperty("--atl-scroll-nav-right", "0px");
      const probeTop = rail.getBoundingClientRect().top;
      const hijacked =
        Math.abs(probeTop - rect.top) <= 2 && Math.abs(probeTop) > 2;
      if (hijacked) {
        top = inset;
        bottom = inset;
        right = 0;
      } else {
        top = Math.round(Math.max(0, rect.top + inset));
        bottom = Math.round(
          Math.max(0, window.innerHeight - rect.bottom + inset)
        );
        right = Math.round(Math.max(0, window.innerWidth - rect.right));
        /* 再测一次偏差并补偿（少数含 filter 的中间态） */
        varHost.style.setProperty("--atl-scroll-nav-top", `${top}px`);
        varHost.style.setProperty("--atl-scroll-nav-bottom", `${bottom}px`);
        varHost.style.setProperty("--atl-scroll-nav-right", `${right}px`);
        const delta = Math.round(rail.getBoundingClientRect().top - top);
        if (Math.abs(delta) >= 1) {
          top = Math.max(0, top - delta);
          bottom = Math.max(0, bottom + delta);
          right = Math.max(0, right);
        }
      }
      /* 探测期间可能改过 CSS var；未确认前先还原到已应用值，避免防抖窗口闪跳。 */
      const applied = scrollRailBoundsRef.current;
      if (applied.right >= 0) {
        varHost.style.setProperty("--atl-scroll-nav-top", `${applied.top}px`);
        varHost.style.setProperty(
          "--atl-scroll-nav-bottom",
          `${applied.bottom}px`
        );
        varHost.style.setProperty("--atl-scroll-nav-right", `${applied.right}px`);
      } else {
        if (prevTopVar)
          varHost.style.setProperty("--atl-scroll-nav-top", prevTopVar);
        if (prevBottomVar)
          varHost.style.setProperty("--atl-scroll-nav-bottom", prevBottomVar);
        if (prevRightVar)
          varHost.style.setProperty("--atl-scroll-nav-right", prevRightVar);
      }
    } else {
      top = Math.round(Math.max(0, rect.top + inset));
      bottom = Math.round(
        Math.max(0, window.innerHeight - rect.bottom + inset)
      );
      right = Math.round(Math.max(0, window.innerWidth - rect.right));
    }

    varHost.style.setProperty("--atl-scroll-nav-top", `${top}px`);
    varHost.style.setProperty("--atl-scroll-nav-bottom", `${bottom}px`);
    varHost.style.setProperty("--atl-scroll-nav-right", `${right}px`);
    const trackEl = shell.querySelector<HTMLElement>(".atl-scroll-nav__track");
    const liveTrackPx = trackEl?.getBoundingClientRect().height ?? 0;
    const height = Math.round(
      Math.max(96, liveTrackPx || Math.max(160, rect.height - 2 * inset))
    );
    scrollRailMetricsRef.current.trackPx = height;

    const prev = scrollRailBoundsRef.current;
    const next = { height, top, bottom, right };
    if (
      prev.height === height &&
      prev.top === top &&
      prev.bottom === bottom &&
      prev.right === right
    ) {
      scrollRailPendingRef.current = null;
      scrollRailGeomSigRef.current = geomSig;
      return;
    }

    const pending = scrollRailPendingRef.current;
    const matchesPending =
      !!pending &&
      Math.abs(pending.height - height) <= 2 &&
      Math.abs(pending.top - top) <= 2 &&
      Math.abs(pending.bottom - bottom) <= 2 &&
      Math.abs(pending.right - right) <= 2;
    if (prev.right >= 0 && !matchesPending) {
      scrollRailPendingRef.current = next;
      /* 未确认：还原到已应用 bounds，避免候选值提前生效造成闪跳。 */
      varHost.style.setProperty("--atl-scroll-nav-top", `${prev.top}px`);
      varHost.style.setProperty("--atl-scroll-nav-bottom", `${prev.bottom}px`);
      varHost.style.setProperty("--atl-scroll-nav-right", `${prev.right}px`);
      if (scrollRailConfirmTimeoutRef.current !== null) {
        window.clearTimeout(scrollRailConfirmTimeoutRef.current);
      }
      scrollRailConfirmTimeoutRef.current = window.setTimeout(() => {
        scrollRailConfirmTimeoutRef.current = null;
        updateScrollRailBoundsNow();
      }, 120);
      return;
    }

    scrollRailPendingRef.current = null;
    scrollRailBoundsRef.current = next;
    scrollRailGeomSigRef.current = geomSig;
    varHost.style.setProperty("--atl-scroll-nav-top", `${top}px`);
    varHost.style.setProperty("--atl-scroll-nav-bottom", `${bottom}px`);
    varHost.style.setProperty("--atl-scroll-nav-right", `${right}px`);
  }, []);

  const scheduleScrollRailBounds = useCallback(() => {
    if (scrollRailBoundsRafRef.current === null) {
      scrollRailBoundsRafRef.current = window.requestAnimationFrame(
        updateScrollRailBoundsNow
      );
    }
    /* 兜底: transition 结束后再补测一次. Debounce = 每次调用刷新 timeout,
     * 布局连续变化 (拖窗口 / 动画中的多次 RO 触发) 只会在最后一次触发后 350ms 才补测,
     * 不重复执行. */
    if (scrollRailBoundsLateTimeoutRef.current !== null) {
      window.clearTimeout(scrollRailBoundsLateTimeoutRef.current);
    }
    scrollRailBoundsLateTimeoutRef.current = window.setTimeout(() => {
      scrollRailBoundsLateTimeoutRef.current = null;
      updateScrollRailBoundsNow();
    }, 350);
  }, [updateScrollRailBoundsNow]);

  useEffect(() => {
    scheduleScrollRailBounds();
    const shell = feedShellRef.current;
    const panel = shell?.closest<HTMLElement>(".agent-timeline") ?? null;
    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            scheduleScrollRailBounds();
            scheduleRefreshScrollMetrics();
          })
        : null;
    if (panel) ro?.observe(panel);
    if (shell) ro?.observe(shell);
    window.addEventListener("resize", scheduleScrollRailBounds, {
      passive: true,
    });
    /* 窗口/弹窗来回切换: 隐藏期间测量被跳过 (rect=0 防线), 恢复可见时 RO 不一定触发
     * (尺寸没变), 这里显式补测。 */
    const onVisible = () => {
      if (document.visibilityState === "visible") scheduleScrollRailBounds();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", scheduleScrollRailBounds, { passive: true });
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", scheduleScrollRailBounds);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", scheduleScrollRailBounds);
      if (scrollRailBoundsRafRef.current !== null) {
        window.cancelAnimationFrame(scrollRailBoundsRafRef.current);
        scrollRailBoundsRafRef.current = null;
      }
      if (scrollRailBoundsLateTimeoutRef.current !== null) {
        window.clearTimeout(scrollRailBoundsLateTimeoutRef.current);
        scrollRailBoundsLateTimeoutRef.current = null;
      }
      if (scrollRailConfirmTimeoutRef.current !== null) {
        window.clearTimeout(scrollRailConfirmTimeoutRef.current);
        scrollRailConfirmTimeoutRef.current = null;
      }
    };
  }, [scheduleRefreshScrollMetrics, scheduleScrollRailBounds]);

  const userMsgCount = useMemo(
    () =>
      rows.reduce(
        (acc, r) =>
          acc + (r.kind === "message" && r.message.role === "user" ? 1 : 0),
        0
      ),
    [rows]
  );
  const userMsgSessionKey = timelineSessionScrollKey(sessionId, scrollScope);
  const lastUserMsgCountRef = useRef({
    key: userMsgSessionKey,
    count: userMsgCount,
  });
  useEffect(() => {
    const prev = lastUserMsgCountRef.current;
    if (prev.key !== userMsgSessionKey) {
      lastUserMsgCountRef.current = {
        key: userMsgSessionKey,
        count: userMsgCount,
      };
      return;
    }
    if (userMsgCount > prev.count) {
      requestAnimationFrame(() => forceScrollToBottom(true, "new-message"));
    }
    lastUserMsgCountRef.current = {
      key: userMsgSessionKey,
      count: userMsgCount,
    };
  }, [userMsgCount, userMsgSessionKey, forceScrollToBottom]);

  const bindScrollerListeners = useCallback(
    (el: HTMLElement) => {
      const boundSessionKey = currentSessionScrollKeyRef.current;
      const isBoundSessionCurrent = () =>
        currentSessionScrollKeyRef.current === boundSessionKey;
      const markScrolling = (fromUser = true) => {
        // 不切 .is-scrolling 到 shell（会炸后代选择器）。只给滚动容器自身打标,
        // 供合成层 hint 用 — 单元素 attribute, 代价远低于 class 传播。
        const wasScrolling = scrollingFlagRef.current;
        scrollingFlagRef.current = true;
        if (!wasScrolling) {
          const liveMax = Math.max(1, el.scrollHeight - el.clientHeight);
          scrollMetricsFreezeRef.current = {
            active: true,
            maxScroll:
              scrollStaticMetricsRef.current.maxScroll > 1
                ? scrollStaticMetricsRef.current.maxScroll
                : liveMax,
          };
        }
        if (el.getAttribute("data-atl-scrolling") !== "1") {
          el.setAttribute("data-atl-scrolling", "1");
        }
        if (fromUser) lastAnyScrollAtRef.current = performance.now();
        noteDebugScrollActivity();
        if (scrollPaintTimerRef.current === null) {
          /* 480ms: 滚轮惯性/触控板连续帧之间常有 200~300ms 空隙; 太短会中途解冻
           * 测高+改 maxScroll → 进度条闪成两条. */
          const SCROLL_IDLE_MS = 480;
          const settleWhenIdle = () => {
            const idleFor = performance.now() - lastAnyScrollAtRef.current;
            if (idleFor < SCROLL_IDLE_MS) {
              scrollPaintTimerRef.current = window.setTimeout(
                settleWhenIdle,
                Math.max(32, SCROLL_IDLE_MS - idleFor)
              );
              return;
            }
            scrollPaintTimerRef.current = null;
            sampleDebugScrollMutation("scroll-idle");
            scrollingFlagRef.current = false;
            el.removeAttribute("data-atl-scrolling");
            scrollMetricsFreezeRef.current.active = false;
            stopDebugFrameLoop();
            requestAnimationFrame(() => {
              refreshScrollMetrics();
              scheduleStableRowHeightSample("scroll-idle", 0);
            });
          };
          scrollPaintTimerRef.current = window.setTimeout(
            settleWhenIdle,
            SCROLL_IDLE_MS
          );
        }
      };
      const markUserScrolledAway = () => {
        markScrolling();
        armUserScrollGuard(1000);
        const now = performance.now();
        lastUserScrollAtRef.current = now;
        lastUserAwayAtRef.current = now;
        userScrolledAwayRef.current = true;
        bottomStickIntentRef.current = false;
        atBottomRef.current = false;
        librarySyncFollowBottomRef.current?.(false);
        feedShellRef.current?.classList.add("show-scroll-btn");
      };
      const onScroll = () => {
        if (!isBoundSessionCurrent()) return;
        const fromUser =
          performance.now() - lastProgrammaticBottomAtRef.current >
          PROGRAMMATIC_SCROLL_ECHO_MS;
        markScrolling(fromUser);
        commitViewportState(
          { scrollTop: el.scrollTop, height: el.clientHeight },
          "scroll"
        );
        /* 翻历史中禁止读 scrollHeight —— 强制同步布局是粘滞感主因。
         * 用冻结 maxScroll；只在靠近顶/底时读一次 live。 */
        const frozen = scrollMetricsFreezeRef.current;
        const frozenMax =
          frozen.active && frozen.maxScroll > 1
            ? frozen.maxScroll
            : Math.max(0, el.scrollHeight - el.clientHeight);
        const scrollTop = el.scrollTop;
        const nearEdge =
          scrollTop <= TIMELINE_REACH_TOP_PX + 40 ||
          scrollTop >= frozenMax - STICK_BOTTOM_THRESHOLD * 4;
        let liveMaxScroll = frozenMax;
        let liveCanScroll = frozenMax > 8;
        if (nearEdge || !frozen.active) {
          const liveScrollHeight = el.scrollHeight;
          const liveClientHeight = el.clientHeight;
          liveMaxScroll = Math.max(0, liveScrollHeight - liveClientHeight);
          liveCanScroll = liveScrollHeight > liveClientHeight + 8;
        }
        const gapToBottom = liveCanScroll ? liveMaxScroll - scrollTop : 0;
        atBottomRef.current = liveCanScroll
          ? gapToBottom <= STICK_BOTTOM_THRESHOLD
          : true;
        /* 到顶 (或接近顶) 时回捞更早历史 — prepend 到内存头部后, 用 scrollHeight 增量补偿
         * scrollTop, 让用户当前在看的那一行留在原处, 不因为上方插入老历史而跳. */
        if (
          onReachTopRef.current &&
          !reachTopLoadingRef.current &&
          !reachedStartRef.current &&
          liveCanScroll &&
          scrollTop <= TIMELINE_REACH_TOP_PX
        ) {
          reachTopLoadingRef.current = true;
          Promise.resolve(onReachTopRef.current())
            .then((res) => {
              if (res && res.reachedStart) reachedStartRef.current = true;
              if (!res || res.loaded <= 0) {
                reachTopLoadingRef.current = false;
                return;
              }
              pendingPrependRef.current = {
                loaded: res.loaded,
                anchorScrollTop: el.scrollTop,
                anchorScrollHeight: el.scrollHeight,
              };
            })
            .catch(() => {
              reachTopLoadingRef.current = false;
            });
        }
        if (atBottomRef.current) {
          if (restoredAwayScrollKeyRef.current === boundSessionKey)
            restoredAwayScrollKeyRef.current = null;
          if (restoreBottomHoldRef.current?.key === boundSessionKey)
            restoreBottomHoldRef.current = null;
          userScrolledAwayRef.current = false;
          bottomStickIntentRef.current = true;
          userScrollGuardUntilRef.current = 0;
          librarySyncFollowBottomRef.current?.(true);
          feedShellRef.current?.classList.remove("show-scroll-btn");
        }
        const sinceProgrammatic =
          performance.now() - lastProgrammaticBottomAtRef.current;
        if (
          !atBottomRef.current &&
          sinceProgrammatic > 140 &&
          !railDraggingRef.current
        ) {
          feedShellRef.current?.classList.add("show-scroll-btn");
        }
        /* 滚动中不每帧持久化 scroll state，idle 后再记，减主线程压力。 */
        if (!scrollingFlagRef.current || nearEdge) {
          rememberCurrentScrollState(boundSessionKey, {
            atBottom: atBottomRef.current,
            userScrolledAway:
              userScrolledAwayRef.current ||
              (!atBottomRef.current && sinceProgrammatic > 240),
            bottomStickIntent: bottomStickIntentRef.current,
          });
        }
        scheduleScrollThumbFast();
        scheduleDebugScrollMutation("scroll");
        /* 位置落盘 —— 见 scrollStatePersistTimerRef 处的说明 */
        if (scrollStatePersistTimerRef.current !== null) {
          window.clearTimeout(scrollStatePersistTimerRef.current);
        }
        scrollStatePersistTimerRef.current = window.setTimeout(() => {
          scrollStatePersistTimerRef.current = null;
          rememberCurrentScrollState();
        }, 220);
      };
      const onWheel = (e: WheelEvent) => {
        if (!isBoundSessionCurrent()) return;
        markScrolling();
        lastUserScrollAtRef.current = performance.now();
        /* 同样避免 wheel 路径读 scrollHeight；用冻结 max。 */
        const frozen = scrollMetricsFreezeRef.current;
        const liveMaxScroll =
          frozen.active && frozen.maxScroll > 1
            ? frozen.maxScroll
            : scrollStaticMetricsRef.current.maxScroll > 1
              ? scrollStaticMetricsRef.current.maxScroll
              : Math.max(0, el.scrollHeight - el.clientHeight);
        const liveGap = liveMaxScroll - el.scrollTop;
        if (e.deltaY < -1) {
          markUserScrolledAway();
        } else if (e.deltaY > 1) {
          if (liveGap <= STICK_BOTTOM_THRESHOLD * 2) {
            userScrolledAwayRef.current = false;
            bottomStickIntentRef.current = true;
            userScrollGuardUntilRef.current = 0;
            librarySyncFollowBottomRef.current?.(true);
          }
        }
        if (e.deltaY > 0 && liveGap < 1) {
          atBottomRef.current = true;
          userScrolledAwayRef.current = false;
          bottomStickIntentRef.current = true;
          userScrollGuardUntilRef.current = 0;
          librarySyncFollowBottomRef.current?.(true);
          feedShellRef.current?.classList.remove("show-scroll-btn");
        }
      };
      const onTouchMove = () => {
        if (!isBoundSessionCurrent()) return;
        markUserScrolledAway();
      };
      requestAnimationFrame(() => sampleDebugScrollMutation("bind"));
      el.addEventListener("scroll", onScroll, { passive: true });
      el.addEventListener("wheel", onWheel, { passive: true });
      el.addEventListener("touchmove", onTouchMove, { passive: true });
      const unbindIntent = bindUserScrollIntent(el, {
        pointerHeldRef,
        onScrollAway: () => isBoundSessionCurrent() && markUserScrolledAway(),
      });
      return () => {
        unbindIntent();
        if (scrollStatePersistTimerRef.current !== null) {
          window.clearTimeout(scrollStatePersistTimerRef.current);
          scrollStatePersistTimerRef.current = null;
        }
        el.removeEventListener("scroll", onScroll);
        el.removeEventListener("wheel", onWheel);
        el.removeEventListener("touchmove", onTouchMove);
      };
    },
    [
      armUserScrollGuard,
      refreshScrollMetrics,
      sampleDebugScrollMutation,
      scheduleDebugScrollMutation,
      scheduleScrollThumbFast,
      scheduleStableRowHeightSample,
      commitViewportState,
      rememberCurrentScrollState,
      noteDebugScrollActivity,
      stopDebugFrameLoop,
    ]
  );

  useEffect(() => {
    const el = scrollerElRef.current;
    scrollerCleanupRef.current?.();
    scrollerCleanupRef.current = el ? bindScrollerListeners(el) : null;
    if (el) {
      commitViewportState(
        { scrollTop: el.scrollTop, height: el.clientHeight },
        "resize"
      );
      requestAnimationFrame(() => refreshScrollMetrics());
    }
    return () => {
      scrollerCleanupRef.current?.();
      scrollerCleanupRef.current = null;
    };
  }, [
    bindScrollerListeners,
    refreshScrollMetrics,
    commitViewportState,
    sessionId,
  ]);

  useEffect(() => {
    return () => {
      const key = currentSessionScrollKeyRef.current;
      rememberCurrentScrollState(key);
      flushTimelineScrollStateWrite(key);
      scrollerCleanupRef.current?.();
      if (scrollPaintTimerRef.current !== null) {
        window.clearTimeout(scrollPaintTimerRef.current);
      }
      if (scrollMetricsRafRef.current !== null) {
        window.cancelAnimationFrame(scrollMetricsRafRef.current);
      }
      if (scrollThumbRafRef.current !== null) {
        window.cancelAnimationFrame(scrollThumbRafRef.current);
      }
      if (idleAutoBottomTimerRef.current !== null) {
        window.clearTimeout(idleAutoBottomTimerRef.current);
        idleAutoBottomTimerRef.current = null;
      }
      if (bottomSafeRafRef.current !== null) {
        window.cancelAnimationFrame(bottomSafeRafRef.current);
        bottomSafeRafRef.current = null;
      }
      clearBottomSettleTimers();
      clearContentResizeSettleTimers();
    };
  }, [
    clearBottomSettleTimers,
    clearContentResizeSettleTimers,
    rememberCurrentScrollState,
  ]);

  useLayoutEffect(() => {
    const nextKey = timelineSessionScrollKey(sessionId, scrollScope);
    const prevKey = currentSessionScrollKeyRef.current;
    if (prevKey === nextKey) return;
    const domStillPrevSession =
      lastCommittedSignatureRef.current === currentRowKeySignature;
    if (domStillPrevSession) {
      rememberCurrentScrollState(prevKey);
    }
    flushTimelineScrollStateWrite(prevKey);
    clearBottomSettleTimers();
    clearContentResizeSettleTimers();
    currentSessionScrollKeyRef.current = nextKey;
    loadTimelineScrollStateSync(nextKey);
    pendingSessionRestoreRef.current = {
      key: nextKey,
      previousSignature: lastCommittedSignatureRef.current,
      startedAt: performance.now(),
      skippedInitialCommit: false,
      source: "session-switch",
    };
    const saved = timelineScrollStateBySession.get(nextKey);
    if (saved && !saved.atBottom) {
      userScrolledAwayRef.current = true;
      bottomStickIntentRef.current = false;
      atBottomRef.current = false;
      librarySyncFollowBottomRef.current?.(false);
      feedShellRef.current?.classList.add("show-scroll-btn");
    } else if (saved) {
      userScrolledAwayRef.current = false;
      bottomStickIntentRef.current = true;
      atBottomRef.current = true;
      librarySyncFollowBottomRef.current?.(true);
      feedShellRef.current?.classList.remove("show-scroll-btn");
    }
  }, [
    clearBottomSettleTimers,
    clearContentResizeSettleTimers,
    currentRowKeySignature,
    rememberCurrentScrollState,
    scrollScope,
    sessionId,
  ]);

  /* 每个 commit 末尾快照当前签名 — 必须定义在"切换会话" effect **之后**
   * (React 按定义顺序跑同类 effect), 切换 effect 里读到的才是上一 commit 的签名。 */
  useLayoutEffect(() => {
    lastCommittedSignatureRef.current = currentRowKeySignature;
  });

  useEffect(() => {
    const key = timelineSessionScrollKey(sessionId, scrollScope);
    if (rows.length === 0) return;
    const pending = pendingSessionRestoreRef.current;
    const needsSessionRestore = pending?.key === key;
    if (
      needsSessionRestore &&
      pending.previousSignature === currentRowKeySignature
    ) {
      pending.skippedInitialCommit = true;
      const waitMs = 800 - (performance.now() - pending.startedAt);
      if (waitMs > 0) {
        const timer = window.setTimeout(() => {
          setDurableScrollStateVersion((version) => (version + 1) % 100000);
        }, waitMs + 16);
        return () => window.clearTimeout(timer);
      }
    }
    if (!needsSessionRestore && initialScrollResolvedKeysRef.current.has(key))
      return;
    const loadStatus = ensureDurableTimelineScrollStateLoaded(key, () => {
      setDurableScrollStateVersion((version) => (version + 1) % 100000);
    });
    if (loadStatus === "loading" && !timelineScrollStateBySession.has(key)) {
      if (pendingSessionRestoreRef.current?.key !== key) {
        pendingSessionRestoreRef.current = {
          key,
          previousSignature: "__durable_load__",
          startedAt: performance.now(),
          skippedInitialCommit: false,
          source: "durable-load",
        };
      }
      return;
    }
    if (restoreHistoryInFlightRef.current) return;
    const savedForHistory = timelineScrollStateBySession.get(key);
    if (
      persistedAnchorMissing(savedForHistory, rowKeys) &&
      onReachTopRef.current &&
      !reachedStartRef.current &&
      !restoreHistoryTriedKeysRef.current.has(key)
    ) {
      restoreHistoryTriedKeysRef.current.add(key);
      restoreHistoryInFlightRef.current = true;
      void (async () => {
        try {
          for (let n = 0; n < 8; n++) {
            if (currentSessionScrollKeyRef.current !== key) return;
            const res = await onReachTopRef.current?.();
            if (!res || res.loaded === 0 || res.reachedStart) {
              if (res?.reachedStart) reachedStartRef.current = true;
              break;
            }
          }
        } finally {
          restoreHistoryInFlightRef.current = false;
          setDurableScrollStateVersion((version) => (version + 1) % 100000);
        }
      })();
      return;
    }

    const resolveInitialScroll = () => {
      if (currentSessionScrollKeyRef.current !== key) return;
      const pendingBeforeResolve = pendingSessionRestoreRef.current;
      const cameFromSessionSwitch =
        pendingBeforeResolve?.key === key &&
        pendingBeforeResolve.source === "session-switch";
      const saved = timelineScrollStateBySession.get(key);
      pendingSessionRestoreRef.current = null;
      if (saved && restoreScrollState(key, saved)) {
        initialScrollResolvedKeysRef.current.add(key);
        return;
      }
      if (cameFromSessionSwitch) {
        const el = scrollerElRef.current;
        if (el) {
          const scrollHeight = el.scrollHeight;
          const clientHeight = el.clientHeight;
          const maxScroll = Math.max(0, scrollHeight - clientHeight);
          const canScroll = scrollHeight > clientHeight + 8;
          const gapToBottom = canScroll ? maxScroll - el.scrollTop : 0;
          const liveAtBottom =
            !canScroll || gapToBottom <= STICK_BOTTOM_THRESHOLD;
          atBottomRef.current = liveAtBottom;
          userScrolledAwayRef.current = canScroll && !liveAtBottom;
          bottomStickIntentRef.current = liveAtBottom;
          librarySyncFollowBottomRef.current?.(liveAtBottom);
          if (!liveAtBottom) {
            const now = performance.now();
            lastUserAwayAtRef.current = now;
            lastUserScrollAtRef.current = now;
            restoredAwayScrollKeyRef.current = key;
            restoreBottomHoldRef.current = {
              key,
              until: now + TIMELINE_SCROLL_RESTORE_BOTTOM_HOLD_MS,
            };
            feedShellRef.current?.classList.add("show-scroll-btn");
          } else {
            if (restoredAwayScrollKeyRef.current === key)
              restoredAwayScrollKeyRef.current = null;
            if (restoreBottomHoldRef.current?.key === key)
              restoreBottomHoldRef.current = null;
            feedShellRef.current?.classList.remove("show-scroll-btn");
          }
          commitViewportState(
            { scrollTop: el.scrollTop, height: clientHeight },
            "sync"
          );
          refreshScrollMetrics(liveAtBottom);
          scheduleScrollThumbFast();
          rememberCurrentScrollState(key, {
            atBottom: liveAtBottom,
            userScrolledAway: canScroll && !liveAtBottom,
            bottomStickIntent: liveAtBottom,
          });
        }
        initialScrollResolvedKeysRef.current.add(key);
        return;
      }
      userScrolledAwayRef.current = false;
      bottomStickIntentRef.current = true;
      atBottomRef.current = true;
      forceScrollToBottom(false);
      initialScrollResolvedKeysRef.current.add(key);
    };
    const rafId = requestAnimationFrame(resolveInitialScroll);
    return () => cancelAnimationFrame(rafId);
  }, [
    commitViewportState,
    currentRowKeySignature,
    durableScrollStateVersion,
    forceScrollToBottom,
    refreshScrollMetrics,
    rememberCurrentScrollState,
    restoreScrollState,
    rows.length,
    scheduleScrollThumbFast,
    scrollScope,
    sessionId,
  ]);
  useLayoutEffect(() => {
    const el = scrollerElRef.current;
    if (!el) return;
    const pending = pendingSessionRestoreRef.current;
    const currentKey = timelineSessionScrollKey(sessionId, scrollScope);
    /* 恢复 pending 期间一律让位 — 定位由 resolveInitialScroll 统一做, 这里的
     * preserve/贴底逻辑会跟 restore 的 rAF 抢视口 (旧条件只挡"rows 未换"的帧,
     * 同 commit 换 rows 时挡不住)。 */
    if (pending?.key === currentKey) return;
    /* 回捞历史刚把 loaded 行 prepend 到最前面 — 在 paint 前把 scrollTop 抬高这批行的高度,
     * 让用户当前在看的那行留在原处 (不因上方插入老历史而跳). 优先 scrollHeight 增量;
     * 前缀估高仅兜底 (DOM 尚未长高时). */
    const pendingPrepend = pendingPrependRef.current;
    if (pendingPrepend) {
      pendingPrependRef.current = null;
      reachTopLoadingRef.current = false;
      /* TanStack anchorTo:end + getItemKey 已负责 prepend 视口稳定；再抬 scrollTop 会双重补偿。 */
      if (libraryOwnsPrependAnchor) {
        refreshScrollMetrics(false);
        return;
      }
      const heightDelta = Math.max(
        0,
        el.scrollHeight - pendingPrepend.anchorScrollHeight
      );
      const prefixAdjust = Math.max(
        0,
        rowHeightPrefix[pendingPrepend.loaded] ?? 0
      );
      const prependAdjust = heightDelta > 0 ? heightDelta : prefixAdjust;
      if (prependAdjust > 0) {
        const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
        const baseTop =
          heightDelta > 0 ? pendingPrepend.anchorScrollTop : el.scrollTop;
        el.scrollTop = Math.max(
          0,
          Math.min(maxScroll, baseTop + prependAdjust)
        );
        commitViewportState(
          { scrollTop: el.scrollTop, height: el.clientHeight },
          "sync"
        );
        refreshScrollMetrics(false);
      } else {
        /* DOM/前缀都还没长高 — 下一帧再补一次, 避免这一帧把用户甩到顶. */
        const retryTop = pendingPrepend.anchorScrollTop;
        const retryHeight = pendingPrepend.anchorScrollHeight;
        requestAnimationFrame(() => {
          const scroller = scrollerElRef.current;
          if (!scroller) return;
          const lateDelta = Math.max(0, scroller.scrollHeight - retryHeight);
          if (lateDelta <= 0) return;
          const maxScroll = Math.max(
            0,
            scroller.scrollHeight - scroller.clientHeight
          );
          scroller.scrollTop = Math.max(
            0,
            Math.min(maxScroll, retryTop + lateDelta)
          );
          commitViewportState(
            { scrollTop: scroller.scrollTop, height: scroller.clientHeight },
            "sync"
          );
          refreshScrollMetrics(false);
        });
      }
      return;
    }
    /* TanStack followOnAppend / anchorTo:end 接管 append 与末行长高；
     * 这里再写 scrollTop 会和库抢，表现为停滑后跳到底/跳回。 */
    if (libraryOwnsPrependAnchor) {
      commitViewportState(
        { scrollTop: el.scrollTop, height: el.clientHeight },
        "resize"
      );
      refreshScrollMetrics(isLiveAtBottom(STICK_BOTTOM_THRESHOLD * 1.5));
      return;
    }
    const previousScrollTop = el.scrollTop;
    const wasLiveBottom = isLiveAtBottom(STICK_BOTTOM_THRESHOLD * 1.5);
    const shouldPreserveUserPosition =
      userScrolledAwayRef.current ||
      (!wasLiveBottom && !bottomStickIntentRef.current);
    commitViewportState(
      { scrollTop: el.scrollTop, height: el.clientHeight },
      "resize"
    );
    requestAnimationFrame(() => {
      /* 回捞历史加载窗口内 (prepend 尚未落地): 别用旧 previousScrollTop 抢滚动, 等 prepend
       * 落地时由上面的 pendingPrepend 分支在 paint 前一次性补偿. */
      if (reachTopLoadingRef.current) return;
      if (shouldPreserveUserPosition) {
        const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
        el.scrollTop = Math.max(0, Math.min(maxScroll, previousScrollTop));
        atBottomRef.current = false;
        userScrolledAwayRef.current = true;
        bottomStickIntentRef.current = false;
        librarySyncFollowBottomRef.current?.(false);
        feedShellRef.current?.classList.add("show-scroll-btn");
        refreshScrollMetrics(false);
        rememberCurrentScrollState(currentKey, {
          atBottom: false,
          userScrolledAway: true,
          bottomStickIntent: false,
        });
        return;
      }
      refreshScrollMetrics(wasLiveBottom);
      if (
        wasLiveBottom &&
        allowsBottomFollow() &&
        !isSessionRestoreBlockingBottom() &&
        !isUserScrollGuardActive()
      ) {
        if (isTimelineDebugEnabled()) {
          const gap = Math.max(
            0,
            el.scrollHeight - el.clientHeight - el.scrollTop
          );
          logTimelineJank("scroll-row-commit-follow", {
            currentKey,
            rows: rows.length,
            sessionStreaming,
            bottomFollowLease: hasBottomFollowLease(),
            wasLiveBottom,
            gap,
            scrollTop: el.scrollTop,
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
          });
        }
        scrollToBottom(false);
      }
    });
  }, [
    currentRowKeySignature,
    rows.length,
    allowsBottomFollow,
    hasBottomFollowLease,
    refreshScrollMetrics,
    commitViewportState,
    isLiveAtBottom,
    isSessionRestoreBlockingBottom,
    isUserScrollGuardActive,
    libraryOwnsPrependAnchor,
    rememberCurrentScrollState,
    rowHeightPrefix,
    scrollToBottom,
    scrollScope,
    sessionId,
    sessionStreaming,
  ]);

  /* streaming 期间持续贴底 — 原生滚动对“流式文字逐字增长”需要节流校正,
   * 且会在用户刚上滚时把 scrollTop 拉回去.
   *  旧实现每帧 scrollTo(scrollHeight), 会抢主线程并在用户刚上滚时显得粘手.
   *  这里改为 90ms 节流跟随: 足够稳地露出底部内容, 又不会跟文本渲染/terminal 输出抢帧. */
  const hasActiveStreamRow = useMemo(() => {
    const isActiveStep = (step: any) =>
      step?.status === "running" ||
      step?.status === "pending" ||
      step?.status === "awaiting" ||
      (step?.content?.type === "askUser" && step.content.status === "waiting");

    const rowHasActive = (row: Row): boolean => {
      if (row.kind === "message") return row.message.streaming === true;
      if (row.kind === "single") return isActiveStep(row.step);
      if (row.kind === "cluster" || row.kind === "group")
        return row.items.some(isActiveStep);
      if (row.kind === "activity")
        return row.hasActive || row.rows.some(rowHasActive);
      return false;
    };

    // 不能只看最后一行：PlanCard/Actions 经常在当前 activity 内部增高，后面还可能有
    // assistant placeholder / service chrome。只要当前 turn 任一可见行仍 active，就应该保持贴底意图。
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rowHasActive(rows[i])) return true;
    }
    return false;
  }, [rows]);
  const hasLiveStreamRow = sessionStreaming && hasActiveStreamRow;
  const hasLiveStreamRowRef = useRef(hasLiveStreamRow);
  hasLiveStreamRowRef.current = hasLiveStreamRow;
  useEffect(() => {
    /* 跟底意图探针 — 给 viewport window hook 的锚点保持让位用 (读实时 ref, 零延迟).
     * 意图 = 流式中 + 用户没离底 + 没在拖拽/恢复阻塞. 探针在则:
     *   · 锚点捕获跳过 (不再依赖 220ms 租约是否刚好续上)
     *   · 行高修正同帧钉底 (estimate→measure→correct 不再位移)
     * atBottomRef 是必要门: 滚动条拖动/键盘翻页不走 wheel, userScrolledAway 不会被
     * latch, 但 scroll 事件会把 atBottom 翻 false → 意图熄灭, 不抢用户滚动;
     * 而"内容被估高修正/append 推走"不产生 scroll 事件, atBottom 保持 true → 意图
     * 仍在, 照常钉底. 两种情况正好由它区分. */
    setTimelineBottomFollowIntentProbe(() => {
      if (
        hasBottomFollowLease() &&
        !userScrolledAwayRef.current &&
        !railDraggingRef.current &&
        !isUserScrollGuardActive() &&
        !isSessionRestoreBlockingBottom()
      ) {
        return true;
      }
      return (
        hasLiveStreamRowRef.current &&
        atBottomRef.current &&
        !userScrolledAwayRef.current &&
        bottomStickIntentRef.current &&
        !railDraggingRef.current &&
        !isSessionRestoreBlockingBottom()
      );
    });
    return () => setTimelineBottomFollowIntentProbe(null);
  }, [hasBottomFollowLease, isSessionRestoreBlockingBottom, isUserScrollGuardActive]);
  useEffect(() => {
    /* 动态内容贴底守护：PlanCard / Actions / markdown / diff 这些卡片会在已渲染后继续增高。
     * 这类变化不会改变 feed 自己的 clientHeight，单靠 rows.length / feed ResizeObserver 捕不到；
     * 如果用户原本在底部，增高后 gap 突然变大，旧逻辑会误判为离底，于是停在半截。
     * 这里只观察当前挂载的行，且只在“贴底意图仍成立”时校正，不抢用户翻历史。 */
    const feed = scrollerElRef.current;
    if (!feed || typeof ResizeObserver === "undefined") return;
    let disposed = false;
    const shouldFollow = () => {
      if (disposed || railDraggingRef.current || isUserScrollGuardActive())
        return false;
      if (isSessionRestoreBlockingBottom()) return false;
      return allowsBottomFollow();
    };
    const followAfterContentResize = (reason: string) => {
      if (!shouldFollow()) return;
      /* 库模式：末行流式长高由 TanStack end-anchor + measureElement 钉住，勿再写 scrollTop。 */
      if (libraryOwnsPrependAnchor) {
        refreshScrollMetrics(true);
        return;
      }
      if (contentResizeFollowRafRef.current !== null) return;
      contentResizeFollowRafRef.current = window.requestAnimationFrame(() => {
        contentResizeFollowRafRef.current = null;
        if (!shouldFollow()) return;
        if (isTimelineDebugEnabled()) {
          const gap = Math.max(
            0,
            feed.scrollHeight - feed.clientHeight - feed.scrollTop
          );
          logTimelineJank("scroll-content-resize-follow", {
            reason,
            hasActiveStreamRow,
            sessionStreaming,
            bottomFollowLease: hasBottomFollowLease(),
            userScrolledAway: userScrolledAwayRef.current,
            bottomStickIntent: bottomStickIntentRef.current,
            atBottom: atBottomRef.current,
            gap,
            scrollTop: feed.scrollTop,
            scrollHeight: feed.scrollHeight,
            clientHeight: feed.clientHeight,
          });
        }
        bottomStickIntentRef.current = true;
        scrollToBottom(false, true);
        refreshScrollMetrics(true);
        scheduleStableRowHeightSample(reason, 180);
      });
      /* 单一滚动主人: 流式期的持续贴底交给 90ms STREAM_FOLLOW_INTERVAL loop 独占.
       * 撤掉这里每次 content-resize 再叠 [80,180,360,720]ms 四个 setTimeout 各贴一次底 —
       * 流式高频 resize 下几十个重叠写入追一个一直在长的 maxScroll, 是抖动主因之一.
       * 上面那一次 rAF 合并写入保留; clear 仍调一次, 清掉其它路径遗留的 timer. */
      clearContentResizeSettleTimers();
    };
    const ro = new ResizeObserver(() => followAfterContentResize("content-resize"));
    const observedRows = new WeakSet<HTMLElement>();
    const attachVisibleRows = () => {
      /* 只挂当前 DOM 里的行 (虚拟窗口内), 离开 DOM 的节点 RO 自动停投递. */
      feed
        .querySelectorAll<HTMLElement>(
          ".atl-row-clamp[data-timeline-row-index], .atl-feed__virtual-space, .atl-feed__virtual-item, .atl-feed__virtual-slot, .atl-feed__virtual-pad, .atl-feed__footer-spacer"
        )
        .forEach((node) => {
          if (observedRows.has(node)) return;
          observedRows.add(node);
          ro.observe(node);
        });
    };
    const mo = new MutationObserver(() => {
      attachVisibleRows();
      /* 用户翻历史时不跟贴底 — MO 只负责补挂 RO; 贴底校正留给贴底意图路径. */
      if (scrollingFlagRef.current || isUserScrollGuardActive()) return;
      followAfterContentResize("content-mutation");
    });
    attachVisibleRows();
    mo.observe(feed, { childList: true, subtree: false });
    if (!scrollingFlagRef.current && !isUserScrollGuardActive()) {
      followAfterContentResize("content-bind");
    }
    return () => {
      disposed = true;
      ro.disconnect();
      mo.disconnect();
      if (contentResizeFollowRafRef.current !== null) {
        window.cancelAnimationFrame(contentResizeFollowRafRef.current);
        contentResizeFollowRafRef.current = null;
      }
      clearContentResizeSettleTimers();
    };
  }, [
    clearContentResizeSettleTimers,
    hasActiveStreamRow,
    allowsBottomFollow,
    hasBottomFollowLease,
    isUserScrollGuardActive,
    isSessionRestoreBlockingBottom,
    libraryOwnsPrependAnchor,
    refreshScrollMetrics,
    scheduleStableRowHeightSample,
    sessionStreaming,
    scrollToBottom,
    scrollingFlagRef,
  ]);

  useEffect(() => {
    let disposed = false;
    let root: HTMLElement | null = null;
    let ro: ResizeObserver | null = null;
    let mo: MutationObserver | null = null;
    const selectors = [
      ".nx-dock",
      ".atl-subagents",
      ".atl-bgtasks",
      ".atl-approve-dock",
      ".turn-summary-bar",
      ".atl-planbar",
      ".atl-composer",
      DOCKED_MASCOT_SELECTOR,
    ];

    const collectTargets = () => {
      const base =
        root ??
        scrollerElRef.current?.closest<HTMLElement>(".agent-timeline") ??
        null;
      if (!base) return [] as HTMLElement[];
      return selectors
        .flatMap((selector) =>
          Array.from(base.querySelectorAll<HTMLElement>(selector))
        )
        .filter(
          (node) =>
            node.offsetParent !== null || node.getClientRects().length > 0
        );
    };

    const updateBottomSafeNow = () => {
      if (disposed) return;
      const feed = scrollerElRef.current;
      const shell = feedShellRef.current;
      if (!feed || !shell) return;
      const feedRect = feed.getBoundingClientRect();
      let overlap = 0;
      let floatingBarsClearance = 0;
      for (const node of collectTargets()) {
        const rect = bottomChromeRect(node);
        if (rect.height <= 0) continue;
        if (countsAsFloatingBar(node)) {
          floatingBarsClearance += Math.min(72, Math.ceil(rect.height));
        }
        if (rect.bottom <= feedRect.top || rect.top >= feedRect.bottom)
          continue;
        overlap = Math.max(overlap, feedRect.bottom - rect.top);
      }
      /* 真悬浮后 composer+待审条叠在 feed 上, overlap 可达 ~220px+; 旧 180 顶会让末行仍被挡住 */
      const nextSafe = Math.max(
        24,
        Math.min(360, Math.ceil(Math.max(overlap, floatingBarsClearance) + 18))
      );
      if (Math.abs(nextSafe - lastBottomSafePxRef.current) >= 2) {
        lastBottomSafePxRef.current = nextSafe;
        shell.style.setProperty("--atl-feed-bottom-safe", `${nextSafe}px`);
      }
      const shouldKeepBottom = allowsBottomFollow();
      if (
        shouldKeepBottom &&
        !isSessionRestoreBlockingBottom() &&
        !isUserScrollGuardActive()
      ) {
        requestAnimationFrame(() => {
          if (isTimelineDebugEnabled()) {
            const gap = Math.max(
              0,
              feed.scrollHeight - feed.clientHeight - feed.scrollTop
            );
            logTimelineJank("scroll-bottom-safe-follow", {
              hasActiveStreamRow,
              sessionStreaming,
              bottomFollowLease: hasBottomFollowLease(),
              atBottom: atBottomRef.current,
              bottomStickIntent: bottomStickIntentRef.current,
              userScrolledAway: userScrolledAwayRef.current,
              gap,
              bottomSafePx: nextSafe,
            });
          }
          scrollToBottom(false, true);
        });
      }
      requestAnimationFrame(() => refreshScrollMetrics());
    };

    const scheduleBottomSafeUpdate = () => {
      if (bottomSafeRafRef.current !== null) return;
      bottomSafeRafRef.current = requestAnimationFrame(() => {
        bottomSafeRafRef.current = null;
        updateBottomSafeNow();
      });
    };

    const attach = () => {
      if (disposed) return;
      root =
        scrollerElRef.current?.closest<HTMLElement>(".agent-timeline") ?? null;
      if (!root) {
        requestAnimationFrame(attach);
        return;
      }
      ro?.disconnect();
      ro =
        typeof ResizeObserver !== "undefined"
          ? new ResizeObserver(scheduleBottomSafeUpdate)
          : null;
      if (ro) {
        ro.observe(root);
        const feed = scrollerElRef.current;
        if (feed) ro.observe(feed);
        for (const target of collectTargets()) ro.observe(target);
      }

      /* 底部 chrome 是 .atl-bottom-float 的子节点, 不是 root 的 —— 而下面 mo 用的是
       * subtree: false (故意的: timeline 流式输出时整棵子树 mutation 量极大, 不能全局监听)。
       * 结果待审条这类"绝对定位叠层"出现时: root 不 resize, feed 不 resize, root childList 也不变
       *   → 三个信号全静默 → overlap 永不重算 → 它直接盖住 timeline 最后一段。
       * 修法: 让同一个 mo 额外盯住 .atl-bottom-float 这一层的 childList。这个容器只在
       * chrome 出现/消失时变动, 成本可忽略, 又不用把 subtree 打开。 */
      const observeFloatLayer = () => {
        if (!mo || !root) return;
        const float = root.querySelector<HTMLElement>(".atl-bottom-float");
        if (float) mo.observe(float, { childList: true, subtree: false });
      };

      mo?.disconnect();
      mo =
        typeof MutationObserver !== "undefined"
          ? new MutationObserver(() => {
              if (ro) {
                for (const target of collectTargets()) ro.observe(target);
              }
              /* .atl-bottom-float 本身可能刚被挂上 (整个 timeline 重挂时), 每次都补一遍注册;
               * 对同一节点重复 observe 是幂等的 (规范: 替换已有 registration)。 */
              observeFloatLayer();
              scheduleBottomSafeUpdate();
            })
          : null;
      mo?.observe(root, {
        childList: true,
        subtree: false,
        attributes: true,
        attributeFilter: ["class", "style"],
      });
      observeFloatLayer();
      scheduleBottomSafeUpdate();
    };

    attach();
    return () => {
      disposed = true;
      ro?.disconnect();
      mo?.disconnect();
      if (bottomSafeRafRef.current !== null) {
        cancelAnimationFrame(bottomSafeRafRef.current);
        bottomSafeRafRef.current = null;
      }
    };
  }, [
    hasActiveStreamRow,
    allowsBottomFollow,
    hasBottomFollowLease,
    isSessionRestoreBlockingBottom,
    isUserScrollGuardActive,
    refreshScrollMetrics,
    sessionStreaming,
    scrollToBottom,
  ]);

  const lastHasActiveStreamRowRef = useRef({
    key: userMsgSessionKey,
    value: hasLiveStreamRow,
  });
  useEffect(() => {
    const prev = lastHasActiveStreamRowRef.current;
    if (prev.key !== userMsgSessionKey) {
      lastHasActiveStreamRowRef.current = {
        key: userMsgSessionKey,
        value: hasLiveStreamRow,
      };
      return;
    }
    const changed = hasLiveStreamRow !== prev.value;
    lastHasActiveStreamRowRef.current = {
      key: userMsgSessionKey,
      value: hasLiveStreamRow,
    };
    if (!changed) return;
    const idleFor =
      performance.now() -
      Math.max(lastUserScrollAtRef.current, lastUserAwayAtRef.current);
    const canCorrect =
      !isSessionRestoreBlockingBottom() &&
      !isUserScrollGuardActive() &&
      (bottomStickIntentRef.current ||
        atBottomRef.current ||
        !userScrolledAwayRef.current ||
        idleFor > 4500);
    if (!canCorrect) return;
    if (idleFor > 4500 || !hasLiveStreamRow) {
      userScrolledAwayRef.current = false;
      userScrollGuardUntilRef.current = 0;
    }
    if (!hasLiveStreamRow) {
      // 结束时 markdown / diff / service bar 往往还有 2~3 次高度 settle，必须跑完整到底序列。
      leaseBottomFollow(1800);
      forceScrollToBottom(false);
      return;
    }
    requestAnimationFrame(() => scrollToBottom(false, true));
  }, [
    hasLiveStreamRow,
    forceScrollToBottom,
    isSessionRestoreBlockingBottom,
    isUserScrollGuardActive,
    leaseBottomFollow,
    scrollToBottom,
    userMsgSessionKey,
  ]);

  /* streaming 持续期间的节流贴底 loop.
   * 用户刚上滚时尊重阅读；但如果运行中长时间没有任何用户滚动/拖拽，
   * 自动恢复到底部，避免“思考中 / 工具执行中”停在中段还要手动拉到底。 */
  useEffect(() => {
    if (!hasLiveStreamRow) {
      if (atBottomRef.current) {
        userScrolledAwayRef.current = false;
        bottomStickIntentRef.current = true;
      }
      if (idleAutoBottomTimerRef.current !== null) {
        window.clearTimeout(idleAutoBottomTimerRef.current);
        idleAutoBottomTimerRef.current = null;
      }
      return;
    }
    const id = window.setInterval(() => {
      const now = performance.now();
      if (isSessionRestoreBlockingBottom()) {
        /* 恢复闩不能在续跑期间永久堵死跟底: agent 自动续跑没有任何用户消息,
         * 原逻辑只有"用户手动滚到底/发消息"才解闩 → 重启+继续后新内容进来视口
         * 永远不动 ("我继续我看不到"). 与 scrolled-away 同款 4.5s 空闲豁免:
         * 恢复后用户一直没有滚动, 视为不再读历史, 解闩回到跟底. */
        if (pendingSessionRestoreRef.current?.key === currentSessionScrollKeyRef.current)
          return; // 恢复本身还没落地, 不动
        /* lastAnyScrollAt 也计入: 滚动条拖动/键盘翻页不走 wheel, 不更新 lastUserScrollAt.
         * 闩锁生效期间所有程序性贴底都被堵着, scroll 事件几乎必然来自用户 —— 有活动就不解闩. */
        const idleFor =
          now -
          Math.max(
            lastUserScrollAtRef.current,
            lastUserAwayAtRef.current,
            lastAnyScrollAtRef.current
          );
        if (
          idleFor > 4500 &&
          !isUserScrollGuardActive() &&
          !railDraggingRef.current
        ) {
          const key = currentSessionScrollKeyRef.current;
          if (restoredAwayScrollKeyRef.current === key)
            restoredAwayScrollKeyRef.current = null;
          if (restoreBottomHoldRef.current?.key === key)
            restoreBottomHoldRef.current = null;
          userScrolledAwayRef.current = false;
          bottomStickIntentRef.current = true;
          userScrollGuardUntilRef.current = 0;
          forceScrollToBottom(true);
        }
        return;
      }
      const el = scrollerElRef.current;
      if (el && userScrolledAwayRef.current && !railDraggingRef.current) {
        const frozen = scrollMetricsFreezeRef.current;
        const maxScroll =
          frozen.active && frozen.maxScroll > 1
            ? frozen.maxScroll
            : scrollStaticMetricsRef.current.maxScroll > 1
              ? scrollStaticMetricsRef.current.maxScroll
              : Math.max(0, el.scrollHeight - el.clientHeight);
        const gap = Math.max(0, maxScroll - el.scrollTop);
        const idleFor =
          now -
          Math.max(lastUserScrollAtRef.current, lastUserAwayAtRef.current);
        const guardActive = isUserScrollGuardActive();
        /* 4.5s 空闲后恢复贴底：足够尊重用户阅读，又不会让运行状态长期停在中间。
         * gap 太小则立即解除 latch；gap 很大说明用户真的在看历史，仍等 idle。 */
        if (gap <= STICK_BOTTOM_THRESHOLD * 1.5) {
          userScrolledAwayRef.current = false;
          bottomStickIntentRef.current = true;
          userScrollGuardUntilRef.current = 0;
          librarySyncFollowBottomRef.current?.(true);
        } else if (idleFor > 4500 && !guardActive) {
          userScrolledAwayRef.current = false;
          bottomStickIntentRef.current = true;
          userScrollGuardUntilRef.current = 0;
          librarySyncFollowBottomRef.current?.(true);
          forceScrollToBottom(true);
          return;
        }
      }
      /* 用户没离底、底下却多出一截 → 拉回底部 (门的说明见 bindUserScrollIntent) */
      if (
        el &&
        !userScrolledAwayRef.current &&
        bottomStickIntentRef.current &&
        !railDraggingRef.current &&
        !pointerHeldRef.current &&
        !isUserScrollGuardActive() &&
        now >= streamFollowPausedUntilRef.current &&
        now - lastUserScrollAtRef.current > 250
      ) {
        if (el.scrollHeight - el.clientHeight - el.scrollTop > STICK_BOTTOM_THRESHOLD) {
          scrollToBottom(false, true);
          return;
        }
      }
      if (libraryOwnsPrependAnchor) {
        /* 库模式由 followOnAppend 钉底；这里再读 scrollHeight / 写 scrollTop 会在滚轮帧抢 layout。 */
        return;
      }
      if (canStreamFollowBottom()) {
        scrollToBottom(false);
        return;
      }
    }, STREAM_FOLLOW_INTERVAL_MS);
    scheduleFollowBottom();
    return () => {
      window.clearInterval(id);
      if (followTimerRef.current !== null) {
        window.clearTimeout(followTimerRef.current);
        followTimerRef.current = null;
      }
    };
  }, [
    hasLiveStreamRow,
    canStreamFollowBottom,
    scheduleFollowBottom,
    scrollToBottom,
    forceScrollToBottom,
    isSessionRestoreBlockingBottom,
    isUserScrollGuardActive,
    libraryOwnsPrependAnchor,
  ]);
  const jumpToScrollRatio = useCallback(
    (clientY: number) => {
      const el = scrollerRef.current as HTMLElement | null;
      if (!el) return;
      const track = feedShellRef.current?.querySelector<HTMLElement>(
        ".atl-scroll-nav__track"
      );
      if (!track) return;
      const rect = track.getBoundingClientRect();
      scrollRailMetricsRef.current.trackPx = Math.max(96, rect.height);
      const { thumbH } = scrollRailMetricsRef.current;
      const maxTop = Math.max(1, rect.height - thumbH);
      const y = Math.max(0, Math.min(maxTop, clientY - rect.top - thumbH / 2));
      const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
      const ratio = maxTop <= 0 ? 0 : y / maxTop;
      armUserScrollGuard(1000);
      userScrolledAwayRef.current = ratio < 0.98;
      bottomStickIntentRef.current = ratio >= 0.98;
      librarySyncFollowBottomRef.current?.(ratio >= 0.98);
      if (ratio < 0.98) lastUserAwayAtRef.current = performance.now();
      if (ratio >= 0.98) {
        const key = currentSessionScrollKeyRef.current;
        if (restoredAwayScrollKeyRef.current === key)
          restoredAwayScrollKeyRef.current = null;
        if (restoreBottomHoldRef.current?.key === key)
          restoreBottomHoldRef.current = null;
      }
      atBottomRef.current = ratio >= 0.98;
      el.scrollTop = maxScroll * ratio;
      rememberCurrentScrollState(undefined, {
        atBottom: ratio >= 0.98,
        userScrolledAway: ratio < 0.98,
        bottomStickIntent: ratio >= 0.98,
      });
      scheduleScrollThumbFast();
      scheduleRefreshScrollMetrics();
    },
    [
      armUserScrollGuard,
      rememberCurrentScrollState,
      scheduleRefreshScrollMetrics,
      scheduleScrollThumbFast,
      scrollerRef,
    ]
  );

  const onScrollRailPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      railDraggingRef.current = true;
      armUserScrollGuard(1200);
      const pointerId = event.pointerId;
      const target = event.currentTarget;
      target.setPointerCapture(pointerId);
      jumpToScrollRatio(event.clientY);
      const onMove = (moveEvent: PointerEvent) =>
        jumpToScrollRatio(moveEvent.clientY);
      const onUp = () => {
        railDraggingRef.current = false;
        armUserScrollGuard(900);
        target.releasePointerCapture(pointerId);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        refreshScrollMetrics();
      };
      window.addEventListener("pointermove", onMove, { passive: true });
      window.addEventListener("pointerup", onUp, { once: true });
      window.addEventListener("pointercancel", onUp, { once: true });
    },
    [armUserScrollGuard, jumpToScrollRatio, refreshScrollMetrics]
  );

  return {
    feedShellRef,
    scrollThumbElRef,
    bottomSentinelRef,
    scrollToTop,
    forceScrollToBottom,
    onScrollRailPointerDown,
  };
}
