import { useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { shellPerf } from "../../../perf/shellPerf";
import type { Row } from "../timelineRows";
import { rowHasWaitingAsk } from "../timelineRows";
import { isTimelineUserScrollGuardActive } from "../timelineScrollGuard";

const USER_SCROLL_IDLE_MS = 240;

interface UseDeferredTimelineRowsArgs {
  computedRows: Row[];
  sessionId?: string | null;
}

interface UseDeferredTimelineRowsResult {
  rows: Row[];
  rowsLengthRef: MutableRefObject<number>;
  scrollingFlagRef: MutableRefObject<boolean>;
}

/**
 * Keeps the rendered timeline stable while the user is actively scrolling.
 *
 * Streaming/tool updates can change row composition and row heights. Committing
 * those changes mid-wheel creates scrollHeight jumps, which users perceive as
 * rebound or uneven scroll speed. This hook snapshots rows during the short
 * user-scroll guard window, then flushes the latest model once scrolling settles.
 *
 * 例外: 含 waiting ask_user 的模型变更必须立刻 commit. ask 是阻塞交互, 若被滚动
 * defer 压住, 用户会看到"卡片不渲染/点不了", 打断后滚动停了才突然出现.
 */
function rowsHaveWaitingAsk(rows: Row[]): boolean {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rowHasWaitingAsk(rows[i])) return true;
  }
  return false;
}

/** 末尾那条是不是用户消息 —— 用户刚发的东西必须立刻上屏, 见 justSentUserMessage。 */
function endsWithUserMessage(rows: Row[]): boolean {
  const last = rows[rows.length - 1];
  return !!last && last.kind === "message" && last.message.role === "user";
}

function justSentUserMessage(prev: Row[], next: Row[]): boolean {
  return next.length > prev.length && endsWithUserMessage(next) && !endsWithUserMessage(prev);
}

export function useDeferredTimelineRows({
  computedRows,
  sessionId,
}: UseDeferredTimelineRowsArgs): UseDeferredTimelineRowsResult {
  const scrollingFlagRef = useRef(false);
  const pendingRowsRef = useRef<Row[] | null>(null);
  const pendingRowsTimerRef = useRef<number | null>(null);
  const displayedSessionRef = useRef<string | null | undefined>(sessionId);
  const [rows, setRows] = useState<Row[]>(computedRows);
  /* 已上屏的那一份 —— justSentUserMessage 要跟它比。用 ref 而不是把 rows 加进 effect
   * 依赖: 加依赖会让每次 commit 自己再触发一轮 effect, 白跑且容易抖。 */
  const displayedRowsRef = useRef<Row[]>(computedRows);
  const commitRows = (next: Row[]) => { displayedRowsRef.current = next; setRows(next); };
  const rowsLengthRef = useRef(rows.length);
  /* 长度必须跟**实际渲染的那一份**一致, 否则切换帧里下游 (虚拟化/滚动锚点) 会按旧长度算 */
  rowsLengthRef.current = displayedSessionRef.current === sessionId ? rows.length : computedRows.length;

  useEffect(() => {
    const sessionChanged = displayedSessionRef.current !== sessionId;
    if (sessionChanged) {
      displayedSessionRef.current = sessionId;
      pendingRowsRef.current = null;
      if (pendingRowsTimerRef.current !== null) {
        window.clearTimeout(pendingRowsTimerRef.current);
        pendingRowsTimerRef.current = null;
      }
      shellPerf.mark("timeline.rows-session-reset", {
        sessionId,
        rows: computedRows.length,
      });
      commitRows(computedRows);
      return;
    }

    const flush = () => {
      if (scrollingFlagRef.current || isTimelineUserScrollGuardActive()) {
        /* waiting ask / 用户刚发的消息 都别再 defer — 阻塞交互与直接操作反馈
         * 都优先于滚动稳定. */
        const next = pendingRowsRef.current;
        if (next && (rowsHaveWaitingAsk(next) || justSentUserMessage(displayedRowsRef.current, next))) {
          pendingRowsRef.current = null;
          pendingRowsTimerRef.current = null;
          shellPerf.mark("timeline.rows-flush-blocking-ask", {
            sessionId,
            rows: next.length,
          });
          commitRows(next);
          return;
        }
        pendingRowsTimerRef.current = window.setTimeout(
          flush,
          USER_SCROLL_IDLE_MS
        );
        return;
      }
      const next = pendingRowsRef.current;
      pendingRowsRef.current = null;
      pendingRowsTimerRef.current = null;
      if (next) {
        shellPerf.mark("timeline.rows-flush-after-scroll", {
          sessionId,
          rows: next.length,
        });
        commitRows(next);
      }
    };

    /* 阻塞 ask / 用户刚发的消息 立刻上屏, 不走滚动 defer. */
    if (rowsHaveWaitingAsk(computedRows) || justSentUserMessage(displayedRowsRef.current, computedRows)) {
      pendingRowsRef.current = null;
      if (pendingRowsTimerRef.current !== null) {
        window.clearTimeout(pendingRowsTimerRef.current);
        pendingRowsTimerRef.current = null;
      }
      shellPerf.mark("timeline.rows-commit-blocking-ask", {
        sessionId,
        rows: computedRows.length,
      });
      commitRows(computedRows);
      return;
    }

    if (scrollingFlagRef.current || isTimelineUserScrollGuardActive()) {
      pendingRowsRef.current = computedRows;
      shellPerf.mark("timeline.rows-deferred-during-scroll", {
        sessionId,
        rows: computedRows.length,
      });
      if (pendingRowsTimerRef.current === null) {
        pendingRowsTimerRef.current = window.setTimeout(
          flush,
          USER_SCROLL_IDLE_MS
        );
      }
      return;
    }

    shellPerf.mark("timeline.rows-commit", {
      sessionId,
      rows: computedRows.length,
    });
    commitRows(computedRows);
  }, [computedRows, sessionId]);

  useEffect(
    () => () => {
      if (pendingRowsTimerRef.current !== null) {
        window.clearTimeout(pendingRowsTimerRef.current);
      }
    },
    []
  );

  const rowsBelongToCurrentSession = displayedSessionRef.current === sessionId;
  return {
    rows: rowsBelongToCurrentSession ? rows : computedRows,
    rowsLengthRef,
    scrollingFlagRef,
  };
}
