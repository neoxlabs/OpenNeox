import { useCallback, useEffect, useMemo, useRef } from "react";
import type { MutableRefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Row } from "../timelineRows";
import {
  TIMELINE_FULL_RENDER_MAX,
  TIMELINE_ROW_ESTIMATE_DEFAULT,
  TIMELINE_WINDOW_SOFT_MIN,
  shouldWindowTimeline,
} from "../timelineRows";
import {
  estimateRowHeightWithGeometry,
  isTimelineGeometryReady,
  rememberMeasuredRowHeight,
  rowGeometryKind,
} from "../rowHeightGeometry";
import {
  shouldRestoreLiveSessionToBottom,
  timelineRowSizeCacheForSession,
  timelineScrollStateBySession,
  timelineSessionScrollKey,
} from "./timelineScrollStatePersist";

export const TIMELINE_TURN_PENDING_KEY = "__atl_turn_pending__";
export const TIMELINE_TURN_PENDING_ESTIMATE = 36;
const MAX_CACHED_ROW_PX = 8000;
const STREAM_TICK_REMEASURE_MS = 1000;
const FORCE_REMEASURE_REASONS = new Set(["stream-end", "hydrate", "stream-tick"]);

export function readRoBlockSize(entry?: ResizeObserverEntry): number {
  if (!entry) return 0;
  const boxes = entry.borderBoxSize as unknown;
  const box = Array.isArray(boxes) || (boxes != null && typeof (boxes as { length?: number }).length === "number")
    ? (boxes as ResizeObserverSize[])[0]
    : (boxes as ResizeObserverSize | undefined);
  if (box && typeof box.blockSize === "number" && box.blockSize > 0) {
    return box.blockSize;
  }
  const h = entry.contentRect?.height;
  return typeof h === "number" && h > 0 ? h : 0;
}

export function resolveVirtualRowSize(input: {
  scrolling: boolean;
  fromRo: number;
  cached?: number;
  offsetHeight?: number;
  estimate: number;
}): number {
  if (input.fromRo > 0) return input.fromRo;
  /* offsetHeight 只在调用方允许读布局时传入 (静止, 或强制校准). */
  if (typeof input.offsetHeight === "number" && input.offsetHeight > 0) {
    return input.offsetHeight;
  }
  if (typeof input.cached === "number" && input.cached > 0) return input.cached;
  return input.estimate;
}

interface UseTimelineVirtualizerArgs {
  rows: Row[];
  rowKeys: string[];
  scrollerElRef: MutableRefObject<HTMLElement | null>;
  scrollingFlagRef?: MutableRefObject<boolean>;
  sessionId?: string | null;
  scrollScope?: string;
  sessionStreaming?: boolean;
  /** 末尾「正在思考」占位, 算进虚拟列表, 避免它落在 totalSize 大空白后面。 */
  trailingSlotCount?: number;
}

interface UseTimelineVirtualizerResult {
  windowingActive: boolean;
  virtualizer: ReturnType<typeof useVirtualizer<HTMLElement, Element>> | null;
  /** 同一帧关掉/打开钉底跟随。上滑必须立刻切到 start-anchor，等下一轮 React 渲染会跟流式抢。 */
  syncFollowBottom: (follow: boolean) => void;
  measureElement: (node: Element | null) => void;
  virtualItems: Array<{
    index: number;
    key: string | number | bigint;
    start: number;
    size: number;
  }>;
  totalSize: number;
  rowHeightPrefix: number[];
  commitViewportState: (
    _next: { scrollTop: number; height: number },
    _mode?: "scroll" | "resize" | "sync"
  ) => void;
  scheduleStableRowHeightSample: (reason: string, delay?: number) => void;
  scrollToIndex: (
    index: number,
    opts?: { align?: "start" | "center" | "end" | "auto"; behavior?: ScrollBehavior }
  ) => void;
  scrollToEnd: (opts?: { behavior?: ScrollBehavior }) => void;
}

/**
 * Timeline 虚拟化 — @tanstack/react-virtual Chat 模式（简洁版）。
 * 不做 overflow 裁剪槽 / directDomUpdates：那套会切碎卡片、比自研还难受。
 */
export function useTimelineVirtualizer({
  rows,
  rowKeys,
  scrollerElRef,
  scrollingFlagRef,
  sessionId,
  scrollScope,
  sessionStreaming = false,
  trailingSlotCount = 0,
}: UseTimelineVirtualizerArgs): UseTimelineVirtualizerResult {
  const count = rows.length;
  const trailing = trailingSlotCount > 0 ? 1 : 0;
  const virtualCount = count + trailing;
  /* 中型会话也开窗: geometryReady 不再门控 (样本只能开窗后才有). */
  const windowingActive =
    shouldWindowTimeline(count, isTimelineGeometryReady()) ||
    count > TIMELINE_FULL_RENDER_MAX;
  const enabled = windowingActive && count >= TIMELINE_WINDOW_SOFT_MIN;

  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const keysRef = useRef(rowKeys);
  keysRef.current = rowKeys;
  /* 贴底用 end-anchor；用户上滑必须改 start，否则末行长高会把视口往下拽。 */
  const followBottomRef = useRef(true);

  const sizeByKeyRef = useRef<Map<string, number>>(new Map());
  const sizeSessionRef = useRef<string | null | undefined>(undefined);
  const sizeCacheKey = timelineSessionScrollKey(sessionId, scrollScope);
  if (sizeSessionRef.current !== sizeCacheKey) {
    sizeSessionRef.current = sizeCacheKey;
    sizeByKeyRef.current = timelineRowSizeCacheForSession(sizeCacheKey);
    const saved = timelineScrollStateBySession.get(sizeCacheKey);
    const lastRowKey = rowKeys[rowKeys.length - 1];
    followBottomRef.current = shouldRestoreLiveSessionToBottom({
      sessionStreaming,
      saved,
      lastRowKey,
    })
      ? true
      : saved
        ? saved.atBottom || !saved.userScrolledAway
        : true;
  }

  const estimateSize = useCallback((index: number) => {
    if (index >= rowsRef.current.length) return TIMELINE_TURN_PENDING_ESTIMATE;
    const key = keysRef.current[index];
    if (key) {
      const cached = sizeByKeyRef.current.get(key);
      if (typeof cached === "number" && cached > 0) return cached;
    }
    const row = rowsRef.current[index];
    if (!row) return TIMELINE_ROW_ESTIMATE_DEFAULT;
    return estimateRowHeightWithGeometry(row);
  }, []);

  const getItemKey = useCallback(
    (index: number) =>
      index >= keysRef.current.length
        ? TIMELINE_TURN_PENDING_KEY
        : (keysRef.current[index] ?? index),
    []
  );

  const rememberSize = useCallback((index: number, height: number) => {
    if (!(height > 0)) return;
    const clamped = Math.min(height, MAX_CACHED_ROW_PX);
    const key =
      index >= keysRef.current.length
        ? TIMELINE_TURN_PENDING_KEY
        : keysRef.current[index];
    if (key) sizeByKeyRef.current.set(key, clamped);
    const row = rowsRef.current[index];
    if (row) rememberMeasuredRowHeight(rowGeometryKind(row), clamped);
  }, []);

  const measureItemSize = useCallback(
    (element: Element, entry?: ResizeObserverEntry) => {
      const index = Number((element as HTMLElement).dataset?.index);
      if (!Number.isFinite(index) || index < 0) return TIMELINE_ROW_ESTIMATE_DEFAULT;
      const scrolling = !!scrollingFlagRef?.current;
      const key =
        index >= keysRef.current.length
          ? TIMELINE_TURN_PENDING_KEY
          : keysRef.current[index];
      const cached = key ? sizeByKeyRef.current.get(key) : undefined;
      const fromRo = readRoBlockSize(entry);
      const offsetHeight =
        !scrolling && element instanceof HTMLElement ? element.offsetHeight : 0;
      const next = resolveVirtualRowSize({
        scrolling,
        fromRo,
        cached,
        offsetHeight,
        estimate: estimateSize(index),
      });
      if (next > 0 && next !== cached) rememberSize(index, next);
      return next;
    },
    [estimateSize, rememberSize, scrollingFlagRef]
  );

  const followBottom = followBottomRef.current;
  const virtualizer = useVirtualizer({
    count: enabled ? virtualCount : 0,
    getScrollElement: () => scrollerElRef.current,
    estimateSize,
    getItemKey,
    measureElement: measureItemSize,
    anchorTo: followBottom ? "end" : "start",
    followOnAppend: enabled ? followBottom : false,
    /* 流式期 sync=true 会 flushSync 整棵 timeline，滚轮被卡住一拍。 */
    useFlushSync: false,
    scrollEndThreshold: 80,
    /* 8 会在快速换片时一次挂 20+ 张重卡（含 max-height 内部滚动的代码块）。 */
    overscan: 3,
    paddingStart: 16,
    enabled,
  });

  const syncFollowBottom = useCallback(
    (follow: boolean) => {
      followBottomRef.current = follow;
      if (!enabled) return;
      const nextAnchor = follow ? "end" : "start";
      const nextFollow = follow;
      if (
        virtualizer.options.anchorTo === nextAnchor &&
        virtualizer.options.followOnAppend === nextFollow
      ) {
        return;
      }
      virtualizer.setOptions({
        ...virtualizer.options,
        anchorTo: nextAnchor,
        followOnAppend: nextFollow,
      });
    },
    [enabled, virtualizer]
  );

  const measureElement = useCallback(
    (node: Element | null) => {
      if (!enabled) return;
      virtualizer.measureElement(node);
    },
    [enabled, virtualizer]
  );

  const virtualItems = enabled ? virtualizer.getVirtualItems() : [];
  const totalSize = enabled ? virtualizer.getTotalSize() : 0;

  const rowHeightPrefix = useMemo(() => {
    const prefix = new Array<number>(count + 1);
    prefix[0] = 0;
    let acc = 0;
    for (let i = 0; i < count; i++) {
      const key = rowKeys[i];
      const cached = key ? sizeByKeyRef.current.get(key) : undefined;
      const measured = enabled
        ? virtualizer.measurementsCache[i]?.size
        : undefined;
      const h =
        typeof cached === "number" && cached > 0
          ? cached
          : typeof measured === "number" && measured > 0
            ? measured
            : estimateRowHeightWithGeometry(rows[i]!);
      acc += h;
      prefix[i + 1] = acc;
    }
    return prefix;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count, rows, enabled, totalSize, rowKeys]);

  const scheduleStableRowHeightSample = useCallback(
    (_reason: string, delay = 0) => {
      if (!enabled) return;
      const run = () => {
        const force = FORCE_REMEASURE_REASONS.has(_reason);
        if (!force && scrollingFlagRef?.current) return;
        const root = scrollerElRef.current;
        if (!root) return;
        /* 强制校准必须走 resizeItem: tanstack 的 measureElement 在 isScrolling
         * 时会直接 return, 跟流 90ms 贴底会把折叠后的真高一直丢掉. */
        if (force) {
          for (const item of virtualizer.getVirtualItems()) {
            const node = root.querySelector(`[data-index="${item.index}"]`);
            if (!(node instanceof HTMLElement)) continue;
            const h = Math.round(node.offsetHeight);
            if (!(h > 0) || h === Math.round(item.size)) continue;
            rememberSize(item.index, h);
            virtualizer.resizeItem(item.index, h);
          }
          return;
        }
        for (const item of virtualizer.getVirtualItems()) {
          const node = root.querySelector(`[data-index="${item.index}"]`);
          if (node) virtualizer.measureElement(node);
        }
      };
      if (delay > 0) window.setTimeout(run, delay);
      else run();
    },
    [enabled, rememberSize, scrollingFlagRef, scrollerElRef, virtualizer]
  );

  const streamingRef = useRef(sessionStreaming);
  useEffect(() => {
    const was = streamingRef.current;
    streamingRef.current = sessionStreaming;
    if (was && !sessionStreaming) {
      scheduleStableRowHeightSample("stream-end", 80);
    }
  }, [scheduleStableRowHeightSample, sessionStreaming]);

  const hydratedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    if (hydratedForRef.current === sizeCacheKey) return;
    hydratedForRef.current = sizeCacheKey;
    scheduleStableRowHeightSample("hydrate", 80);
  }, [enabled, scheduleStableRowHeightSample, sizeCacheKey]);

  useEffect(() => {
    if (!enabled || !sessionStreaming) return;
    const id = window.setInterval(() => {
      scheduleStableRowHeightSample("stream-tick", 0);
    }, STREAM_TICK_REMEASURE_MS);
    return () => window.clearInterval(id);
  }, [enabled, scheduleStableRowHeightSample, sessionStreaming]);

  const commitViewportState = useCallback(
    (
      _next: { scrollTop: number; height: number },
      _mode?: "scroll" | "resize" | "sync"
    ) => {},
    []
  );

  const scrollToIndex = useCallback(
    (
      index: number,
      opts?: {
        align?: "start" | "center" | "end" | "auto";
        behavior?: ScrollBehavior;
      }
    ) => {
      if (!enabled) {
        const el = scrollerElRef.current;
        if (!el) return;
        el.scrollTo({
          top: Math.max(0, rowHeightPrefix[index] ?? 0),
          behavior: opts?.behavior ?? "auto",
        });
        return;
      }
      virtualizer.scrollToIndex(index, {
        align: opts?.align ?? "center",
        behavior: opts?.behavior ?? "auto",
      });
    },
    [enabled, rowHeightPrefix, scrollerElRef, virtualizer]
  );

  const scrollToEnd = useCallback(
    (opts?: { behavior?: ScrollBehavior }) => {
      if (!enabled) {
        const el = scrollerElRef.current;
        if (!el) return;
        const max = Math.max(0, el.scrollHeight - el.clientHeight);
        if (opts?.behavior && opts.behavior !== "auto") {
          el.scrollTo({ top: max, behavior: opts.behavior });
        } else {
          el.scrollTop = max;
        }
        return;
      }
      virtualizer.scrollToEnd({ behavior: opts?.behavior ?? "auto" });
    },
    [enabled, scrollerElRef, virtualizer]
  );

  return {
    windowingActive: enabled,
    virtualizer: enabled ? virtualizer : null,
    syncFollowBottom,
    measureElement,
    virtualItems,
    totalSize,
    rowHeightPrefix,
    commitViewportState,
    scheduleStableRowHeightSample,
    scrollToIndex,
    scrollToEnd,
  };
}
