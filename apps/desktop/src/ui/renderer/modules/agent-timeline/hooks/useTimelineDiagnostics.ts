import { useCallback, useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import type { Row } from "../timelineRows";
import {
  debugRowKind,
  getDebugRowLabel,
  isTimelineDebugEnabled,
  isTimelineDeepDebugEnabled,
  logTimelineJank,
} from "../timelineDebug";

interface ScrollStaticMetrics {
  scrollHeight: number;
  clientHeight: number;
  maxScroll: number;
  canScroll: boolean;
  longEnoughForRail: boolean;
}

interface UseTimelineDiagnosticsArgs {
  rows: Row[];
  rowKeys: string[];
  sessionId?: string | null;
  scrollerElRef: MutableRefObject<HTMLElement | null>;
  scrollingFlagRef: MutableRefObject<boolean>;
  scrollStaticMetricsRef: MutableRefObject<ScrollStaticMetrics>;
}

interface UseTimelineDiagnosticsResult {
  noteDebugScrollActivity: () => void;
  sampleDebugScrollMutation: (reason: string) => void;
  scheduleDebugScrollMutation: (reason: string) => void;
  stopDebugFrameLoop: () => void;
}

/**
 * Timeline-only diagnostic probes. These are intentionally opt-in via
 * window.__neoxTimelineDebug so production rendering pays almost nothing.
 */
export function useTimelineDiagnostics({
  rows,
  rowKeys,
  sessionId,
  scrollerElRef,
  scrollingFlagRef,
  scrollStaticMetricsRef,
}: UseTimelineDiagnosticsArgs): UseTimelineDiagnosticsResult {
  const debugRowsRef = useRef(rows);
  const debugRowKeysRef = useRef(rowKeys);
  const debugSessionRef = useRef(sessionId);
  const debugRafRef = useRef<number | null>(null);
  const debugLastFrameAtRef = useRef(0);
  const debugLastRowsSigRef = useRef("");
  const debugLastScrollRef = useRef({
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
  });
  const debugLastRowHeightsRef = useRef<Map<string, number>>(new Map());
  const debugScrollSeqRef = useRef(0);
  const debugLastMutationSampleAtRef = useRef(0);

  debugRowsRef.current = rows;
  debugRowKeysRef.current = rowKeys;
  debugSessionRef.current = sessionId;

  const sampleVisibleDebugRows = useCallback(() => {
    const scroller = scrollerElRef.current;
    if (!scroller) return [];
    const viewport = scroller.getBoundingClientRect();
    const x = Math.max(
      viewport.left + 24,
      Math.min(viewport.right - 24, viewport.left + viewport.width / 2)
    );
    const ys = [
      viewport.top + 28,
      viewport.top + viewport.height * 0.25,
      viewport.top + viewport.height * 0.5,
      viewport.top + viewport.height * 0.75,
      viewport.bottom - 28,
    ];
    const seen = new Set<string>();
    const result: Array<{
      index: number;
      key: string;
      kind: string;
      label: string;
      top: number;
      height: number;
    }> = [];
    for (const y of ys) {
      const stack = document.elementsFromPoint(x, y);
      const node = stack
        .map(
          (el) =>
            el.closest?.(
              ".atl-row-clamp[data-timeline-row-index]"
            ) as HTMLElement | null
        )
        .find(Boolean);
      if (!node) continue;
      const index = Number(node.dataset.timelineRowIndex ?? -1);
      const key =
        node.dataset.timelineRowKey ||
        debugRowKeysRef.current[index] ||
        `row-${index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const row = debugRowsRef.current[index];
      const rect = node.getBoundingClientRect();
      result.push({
        index,
        key,
        kind: debugRowKind(row),
        label: getDebugRowLabel(row),
        top: Math.round((rect.top - viewport.top) * 10) / 10,
        height: Math.round(rect.height * 10) / 10,
      });
    }
    return result;
  }, [scrollerElRef]);

  const logTimelineDebug = useCallback(
    (event: string, payload?: Record<string, unknown>) => {
      logTimelineJank(event, payload);
    },
    []
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const w = window as typeof window & {
      __neoxTimelineWatchJitter?: (durationMs?: number) => void;
      __neoxTimelineStopJitterWatch?: () => void;
    };
    w.__neoxTimelineWatchJitter = (durationMs = 5000) => {
      const feed = document.querySelector<HTMLElement>(".atl-feed");
      if (!feed) {
        // eslint-disable-next-line no-console
        console.warn("[TimelineJankProbe] .atl-feed not found");
        return;
      }
      let raf = 0;
      const startedAt = performance.now();
      const prevRows = new Map<string, { top: number; height: number }>();
      const events: Array<Record<string, unknown>> = [];
      const sample = () => {
        const viewport = feed.getBoundingClientRect();
        const rowsNow = Array.from(
          feed.querySelectorAll<HTMLElement>(
            ".atl-row-clamp[data-timeline-row-index][data-timeline-row-key]"
          )
        );
        const visible = rowsNow
          .map((node) => ({ node, rect: node.getBoundingClientRect() }))
          .filter(
            ({ rect }) =>
              rect.bottom >= viewport.top - 24 &&
              rect.top <= viewport.bottom + 24
          )
          .slice(0, 28);
        for (const { node, rect } of visible) {
          const key =
            node.dataset.timelineRowKey ||
            node.dataset.timelineRowIndex ||
            "unknown";
          const top = Math.round((rect.top - viewport.top) * 10) / 10;
          const height = Math.round(rect.height * 10) / 10;
          const prev = prevRows.get(key);
          if (prev) {
            const heightDelta = Math.round((height - prev.height) * 10) / 10;
            const topDelta = Math.round((top - prev.top) * 10) / 10;
            if (Math.abs(heightDelta) > 1.5 || Math.abs(topDelta) > 4) {
              const shell = node.querySelector<HTMLElement>(
                ".atl-tool__content-shell, .atl-activity__body-shell, .atl-cluster__body-shell"
              );
              const inner = node.querySelector<HTMLElement>(
                ".atl-tool__content-shell-inner, .atl-activity__body-shell-inner, .atl-cluster__body-shell-inner"
              );
              const rowIndex = Number(node.dataset.timelineRowIndex ?? -1);
              const row = debugRowsRef.current[rowIndex];
              events.push({
                at: Math.round((performance.now() - startedAt) * 10) / 10,
                index: rowIndex,
                key,
                kind: debugRowKind(row),
                label: getDebugRowLabel(row),
                top,
                topDelta,
                height,
                heightDelta,
                className: node.className,
                shellClass: shell?.className,
                shellRows: shell
                  ? getComputedStyle(shell).gridTemplateRows
                  : undefined,
                innerHeight: inner
                  ? Math.round(inner.getBoundingClientRect().height * 10) / 10
                  : undefined,
                scrollTop: Math.round(feed.scrollTop),
                scrollHeight: Math.round(feed.scrollHeight),
              });
              if (events.length > 120) events.shift();
            }
          }
          prevRows.set(key, { top, height });
        }
        if (performance.now() - startedAt < durationMs) {
          raf = requestAnimationFrame(sample);
        } else {
          // eslint-disable-next-line no-console
          console.table(events.slice(-60));
          // eslint-disable-next-line no-console
          console.log("[TimelineJankProbe] summary", {
            durationMs,
            events: events.length,
            scrollTop: Math.round(feed.scrollTop),
            scrollHeight: Math.round(feed.scrollHeight),
            visibleRows: visible.length,
          });
        }
      };
      w.__neoxTimelineStopJitterWatch = () => {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        // eslint-disable-next-line no-console
        console.table(events.slice(-60));
      };
      raf = requestAnimationFrame(sample);
    };
    return () => {
      delete w.__neoxTimelineWatchJitter;
      delete w.__neoxTimelineStopJitterWatch;
    };
  }, []);

  const stopDebugFrameLoop = useCallback(() => {
    if (debugRafRef.current !== null) {
      window.cancelAnimationFrame(debugRafRef.current);
      debugRafRef.current = null;
    }
    debugLastFrameAtRef.current = 0;
  }, []);

  const startDebugFrameLoop = useCallback(() => {
    if (!isTimelineDebugEnabled() || debugRafRef.current !== null) return;
    debugLastFrameAtRef.current = performance.now();
    const tick = (now: number) => {
      if (!scrollingFlagRef.current || !isTimelineDebugEnabled()) {
        debugRafRef.current = null;
        debugLastFrameAtRef.current = 0;
        return;
      }
      const dt = now - debugLastFrameAtRef.current;
      debugLastFrameAtRef.current = now;
      if (dt > 34) {
        const el = scrollerElRef.current;
        logTimelineDebug("long-frame", {
          frameMs: Math.round(dt * 10) / 10,
          sessionId: debugSessionRef.current,
          scrollTop: el ? Math.round(el.scrollTop) : null,
          scrollHeight:
            scrollStaticMetricsRef.current.scrollHeight ||
            (el ? Math.round(el.scrollHeight) : null),
          visible: isTimelineDeepDebugEnabled()
            ? sampleVisibleDebugRows().slice(0, 8)
            : [],
        });
      }
      debugRafRef.current = window.requestAnimationFrame(tick);
    };
    debugRafRef.current = window.requestAnimationFrame(tick);
  }, [
    logTimelineDebug,
    sampleVisibleDebugRows,
    scrollerElRef,
    scrollingFlagRef,
    scrollStaticMetricsRef,
  ]);

  const noteDebugScrollActivity = useCallback(() => {
    if (!isTimelineDebugEnabled()) return;
    debugScrollSeqRef.current += 1;
    startDebugFrameLoop();
  }, [startDebugFrameLoop]);

  const sampleDebugScrollMutation = useCallback(
    (reason: string) => {
      if (!isTimelineDebugEnabled()) return;
      const el = scrollerElRef.current;
      if (!el) return;
      const prev = debugLastScrollRef.current;
      const next = {
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      };
      const scrollHeightDelta = next.scrollHeight - prev.scrollHeight;
      const clientHeightDelta = next.clientHeight - prev.clientHeight;
      const scrollTopDelta = next.scrollTop - prev.scrollTop;

      const shouldCollectRows =
        isTimelineDeepDebugEnabled() ||
        Math.abs(scrollHeightDelta) > 6 ||
        Math.abs(clientHeightDelta) > 2;
      const visible = shouldCollectRows ? sampleVisibleDebugRows() : [];
      const heightChanges: Array<{
        key: string;
        index: number;
        kind: string;
        delta: number;
        height: number;
        label: string;
      }> = [];
      const lastHeights = debugLastRowHeightsRef.current;
      if (isTimelineDeepDebugEnabled()) {
        for (const row of visible) {
          const oldH = lastHeights.get(row.key);
          if (typeof oldH === "number" && Math.abs(row.height - oldH) > 3) {
            heightChanges.push({
              key: row.key,
              index: row.index,
              kind: row.kind,
              delta: Math.round((row.height - oldH) * 10) / 10,
              height: row.height,
              label: row.label,
            });
          }
          lastHeights.set(row.key, row.height);
        }
        if (lastHeights.size > 240) {
          const keep = new Set(visible.map((r) => r.key));
          for (const key of Array.from(lastHeights.keys())) {
            if (!keep.has(key)) lastHeights.delete(key);
            if (lastHeights.size <= 160) break;
          }
        }
      }

      if (
        Math.abs(scrollHeightDelta) > 6 ||
        Math.abs(clientHeightDelta) > 2 ||
        heightChanges.length > 0
      ) {
        logTimelineDebug("layout-mutated-while-scroll", {
          reason,
          seq: debugScrollSeqRef.current,
          scrollTop: Math.round(next.scrollTop),
          scrollTopDelta: Math.round(scrollTopDelta * 10) / 10,
          scrollHeightDelta: Math.round(scrollHeightDelta * 10) / 10,
          clientHeightDelta: Math.round(clientHeightDelta * 10) / 10,
          visible: visible.slice(0, 10),
          heightChanges: heightChanges.slice(0, 12),
        });
      }
      debugLastScrollRef.current = next;
    },
    [logTimelineDebug, sampleVisibleDebugRows, scrollerElRef]
  );

  const scheduleDebugScrollMutation = useCallback(
    (reason: string) => {
      if (!isTimelineDebugEnabled()) return;
      const now = performance.now();
      if (now - debugLastMutationSampleAtRef.current <= 220) return;
      debugLastMutationSampleAtRef.current = now;
      requestAnimationFrame(() => sampleDebugScrollMutation(reason));
    },
    [sampleDebugScrollMutation]
  );

  useEffect(() => {
    if (!isTimelineDebugEnabled()) return;
    const sig = rowKeys
      .map((key, index) => `${key}:${debugRowKind(rows[index])}`)
      .join("|");
    const prevSig = debugLastRowsSigRef.current;
    if (prevSig && prevSig !== sig && scrollingFlagRef.current) {
      const prevKeys = new Set(prevSig.split("|").map((x) => x.split(":")[0]));
      const added = rowKeys.filter((key) => !prevKeys.has(key)).slice(0, 12);
      logTimelineDebug("rows-updated-while-scroll", {
        sessionId,
        rowsLength: rows.length,
        added,
        tail: rows.slice(Math.max(0, rows.length - 8)).map((row, offset) => ({
          index: Math.max(0, rows.length - 8) + offset,
          key: rowKeys[Math.max(0, rows.length - 8) + offset],
          kind: debugRowKind(row),
          label: getDebugRowLabel(row),
        })),
      });
      requestAnimationFrame(() => sampleDebugScrollMutation("rows-effect"));
    }
    debugLastRowsSigRef.current = sig;
  }, [
    rows,
    rowKeys,
    sessionId,
    logTimelineDebug,
    sampleDebugScrollMutation,
    scrollingFlagRef,
  ]);

  useEffect(() => () => stopDebugFrameLoop(), [stopDebugFrameLoop]);

  return {
    noteDebugScrollActivity,
    sampleDebugScrollMutation,
    scheduleDebugScrollMutation,
    stopDebugFrameLoop,
  };
}
