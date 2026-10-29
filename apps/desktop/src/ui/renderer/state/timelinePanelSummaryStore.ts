/**
 * timelinePanelSummaryStore — 右栏 Task Detail 用的轻量摘要 (Phase A 续 / 打磨)
 *
 * 主时间线 map 一次后 publish; RightPanel 订阅摘要, 不再跑第二份 mapTimelineEntries。
 */
import { useSyncExternalStore } from 'react';
import type { StepIconKind } from '../modules/agent-timeline/types';

export type TimelinePanelRunning = {
  title: string;
  desc?: string;
  iconKind: StepIconKind;
};

export type TimelinePanelSummary = {
  sessionId: string;
  running: TimelinePanelRunning | null;
  recentTools: Array<{ kind: StepIconKind; title: string }>;
  stats: {
    total: number;
    done: number;
    running: number;
    pending: number;
    failed: number;
    pct: number;
  };
};

const EMPTY_STATS = Object.freeze({
  total: 0,
  done: 0,
  running: 0,
  pending: 0,
  failed: 0,
  pct: 0,
}) as TimelinePanelSummary['stats'];

let summary: TimelinePanelSummary | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) {
    try {
      l();
    } catch {
      /* ignore */
    }
  }
}

export function publishTimelinePanelSummary(next: TimelinePanelSummary | null): void {
  if (next === summary) return;
  if (
    next &&
    summary &&
    next.sessionId === summary.sessionId &&
    next.running?.title === summary.running?.title &&
    next.running?.iconKind === summary.running?.iconKind &&
    next.stats.total === summary.stats.total &&
    next.stats.done === summary.stats.done &&
    next.stats.running === summary.stats.running &&
    next.stats.failed === summary.stats.failed &&
    next.recentTools.length === summary.recentTools.length &&
    next.recentTools.every(
      (t, i) =>
        t.kind === summary!.recentTools[i]?.kind &&
        t.title === summary!.recentTools[i]?.title,
    )
  ) {
    return;
  }
  summary = next;
  notify();
}

export function getTimelinePanelSummary(): TimelinePanelSummary | null {
  return summary;
}

export function subscribeTimelinePanelSummary(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useTimelinePanelSummary(): TimelinePanelSummary | null {
  return useSyncExternalStore(
    subscribeTimelinePanelSummary,
    getTimelinePanelSummary,
    () => null,
  );
}

export { EMPTY_STATS };
