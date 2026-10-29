import { useCallback, useEffect, useRef, useState } from "react";
import { contentIdsOf, rowKeyOf, type Row } from "../timelineRows";
import {
  debugRowKind,
  getDebugRowLabel,
  isTimelineDebugEnabled,
  logTimelineJank,
} from "../timelineDebug";

const FRESH_CLASS_CLEAR_MS = 460;

/**
 * Freshness 追踪 — enter 动画只对【真正新增】的 row 播一次。
 * 历史 row 可能因为聚合变化重建；step 完成又会聚合成 cluster（key 变）。
 * 用底层内容 id 做 baseline，避免历史/聚合重 mount 反复播放入场动画导致闪烁。
 */
export function useTimelineFreshness({
  rows,
  rowKeys,
  sessionId,
}: {
  rows: Row[];
  rowKeys: string[];
  sessionId?: string | null;
}): (row: Row, index: number) => boolean {
  const seenContentRef = useRef<Set<string> | null>(null);
  const freshSessionRef = useRef<string | null | undefined>(undefined);
  /* 每 key 的 fresh 结论缓存 — 一旦判 fresh 就锁住, 跨 render 稳定.
   * 缺了它, 下一帧 seen 补进这行的 id 后 isRowFresh 立刻翻 false, --fresh 类在
   * 入场动画播到一半被剥, 动画被砍成 pop 闪. 460ms 后由 clear 计时器统一撤. */
  const freshDecisionRef = useRef<Map<string, boolean>>(new Map());
  const clearFreshTimerRef = useRef<number | null>(null);
  const [, forceFreshSweep] = useState(0);

  const isRowFresh = useCallback(
    (row: Row, index: number): boolean => {
      if (freshSessionRef.current !== sessionId) {
        freshSessionRef.current = sessionId;
        seenContentRef.current = null;
        freshDecisionRef.current.clear();
      }
      const key = rowKeys[index] ?? rowKeyOf(row, index);
      if (freshDecisionRef.current.get(key)) return true;
      const seen = seenContentRef.current;
      const ids = contentIdsOf(row);
      const fresh =
        seen != null && ids.length > 0 && ids.every((id) => !seen.has(id));
      if (fresh) freshDecisionRef.current.set(key, true);
      return fresh;
    },
    [sessionId, rowKeys]
  );

  useEffect(() => {
    // rows 为空时不建 baseline：冷加载历史异步灌入时，首批非空历史应全判旧。
    if (rows.length === 0) return;
    const canMarkFresh = !!seenContentRef.current;
    if (!seenContentRef.current) seenContentRef.current = new Set();
    const seen = seenContentRef.current;
    let hadFreshRow = false;
    const freshRows: Array<Record<string, unknown>> = [];
    for (let i = 0; i < rows.length; i++) {
      const ids = contentIdsOf(rows[i]);
      if (canMarkFresh && ids.length > 0 && ids.every((id) => !seen.has(id))) {
        hadFreshRow = true;
        if (isTimelineDebugEnabled() && freshRows.length < 12) {
          freshRows.push({
            index: i,
            key: rowKeys[i] ?? rowKeyOf(rows[i], i),
            kind: debugRowKind(rows[i]),
            label: getDebugRowLabel(rows[i]),
          });
        }
      }
      for (const id of ids) seen.add(id);
    }
    /* 撤掉已经离场 (不在当前 rows) 的 key 的 fresh 结论, 防止 Map 无限涨. */
    if (freshDecisionRef.current.size > 0) {
      const liveKeys = new Set<string>();
      for (let i = 0; i < rows.length; i++) {
        liveKeys.add(rowKeys[i] ?? rowKeyOf(rows[i], i));
      }
      for (const key of Array.from(freshDecisionRef.current.keys())) {
        if (!liveKeys.has(key)) freshDecisionRef.current.delete(key);
      }
    }
    if (hadFreshRow && typeof window !== "undefined") {
      logTimelineJank("fresh-row-marked", {
        rows: freshRows.length,
        examples: freshRows,
        clearMs: FRESH_CLASS_CLEAR_MS,
      });
      /* 计时器在每次 fresh 爆发时重置, 只在"最后一条 fresh row 出现 460ms 后"统一撤 fresh —
       * 那时入场动画早已放完, 撤类不会砍动画; 撤后这些行的 id 已在 seen 里, 重算即为非 fresh. */
      if (clearFreshTimerRef.current !== null) {
        window.clearTimeout(clearFreshTimerRef.current);
      }
      clearFreshTimerRef.current = window.setTimeout(() => {
        clearFreshTimerRef.current = null;
        freshDecisionRef.current.clear();
        logTimelineJank("fresh-row-cleared", {
          rows: rows.length,
          clearMs: FRESH_CLASS_CLEAR_MS,
        });
        forceFreshSweep((value) => value + 1);
      }, FRESH_CLASS_CLEAR_MS);
    }
  }, [rows, rowKeys]);

  useEffect(() => () => {
    if (clearFreshTimerRef.current !== null && typeof window !== "undefined") {
      window.clearTimeout(clearFreshTimerRef.current);
      clearFreshTimerRef.current = null;
    }
  }, []);

  return isRowFresh;
}
