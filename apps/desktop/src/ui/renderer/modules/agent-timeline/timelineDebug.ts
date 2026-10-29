import type { Row } from "./timelineRows";
import { rowStepContentTypeHint, rowStepIconKind, rowStepTitle } from "./timelineRows";

type TimelineDebugWindow = Window & {
  /** Console 开关: window.__neoxTimelineDebug = true */
  __neoxTimelineDebug?: boolean;
  /** 旧调试名兼容: window.__neoxDebugTimeline = true */
  __neoxDebugTimeline?: boolean;
  /** 深度 DOM 测量: 默认关闭。开启后才做更多 row rect 采样。 */
  __neoxTimelineDeepDebug?: boolean;
  /** A/B 开关: true 时跳过右侧自定义滚动条的 per-scroll 指标写入 */
  __neoxTimelineDisableScrollRail?: boolean;
};

export function isTimelineDebugEnabled(): boolean {
  return typeof window !== "undefined" &&
    ((window as TimelineDebugWindow).__neoxTimelineDebug === true ||
      (window as TimelineDebugWindow).__neoxDebugTimeline === true);
}

export function isTimelineDeepDebugEnabled(): boolean {
  return typeof window !== "undefined" &&
    (window as TimelineDebugWindow).__neoxTimelineDeepDebug === true;
}

export function isTimelineScrollRailDebugDisabled(): boolean {
  return typeof window !== "undefined" &&
    (window as TimelineDebugWindow).__neoxTimelineDisableScrollRail === true;
}

export function logTimelineJank(event: string, payload?: Record<string, unknown>): void {
  if (!isTimelineDebugEnabled() || typeof window === "undefined") return;
  const detail = payload ?? {};
  try {
    window.dispatchEvent(
      new CustomEvent("neox:diagnostic-event", {
        detail: { source: "timelineJank", type: event, payload: detail },
      })
    );
  } catch {
    // diagnostics recorder optional
  }
  // eslint-disable-next-line no-console
  console.debug(`[TimelineJank] ${event}`, detail);
}

export function debugRowKind(row: Row | undefined): string {
  if (!row) return "unknown";
  if (row.kind === "single") return rowStepContentTypeHint(row.step) || rowStepIconKind(row.step) || "single";
  return row.kind;
}

export function getDebugRowLabel(row: Row | undefined): string {
  if (!row) return "unknown";
  if (row.kind === "message") return `${row.message.role}:${row.message.id}`;
  if (row.kind === "single") return `${rowStepContentTypeHint(row.step) || rowStepIconKind(row.step)}:${rowStepTitle(row.step)}`;
  if (row.kind === "activity") return `activity:${row.opCount}:${row.hasActive ? "active" : "done"}`;
  if (row.kind === "turn_fold") return `turnfold:${row.opCount}op:${row.fileCount}f:+${row.addCount}-${row.delCount}`;
  if (row.kind === "cluster") return `cluster:${row.head}:${row.items.length}`;
  if (row.kind === "work_progress") return `workprogress:${row.rows.length}`;
  return `group:${row.label}:${row.items.length}`;
}
