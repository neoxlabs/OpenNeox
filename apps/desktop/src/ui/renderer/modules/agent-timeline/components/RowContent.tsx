import React, { memo } from "react";
import TimelineStep from "../TimelineStep";
import { ClusterRow } from "./ClusterRow";
import type { Row } from "../timelineRows";
import { rowStepToTimelineStep, rowStepStatus, rowStepId } from "../timelineRows";
import { getGlobalLanguage } from "../../../hooks/useI18n";

function RowContentImpl({
  row,
  activityChild = false,
  contentOnly = false,
}: {
  row: Row;
  activityChild?: boolean;
  contentOnly?: boolean;
}): React.ReactNode {
  if (row.kind === "single") {
    return (
      <TimelineStep
        step={rowStepToTimelineStep(row.step)}
        activityChild={activityChild}
        contentOnly={contentOnly}
      />
    );
  }
  if (row.kind === "cluster") return <ClusterRow cluster={row} />;
  if (row.kind === "group") {
    const isZh = getGlobalLanguage() === "zh";
    const runningCount = row.items.filter((s) => rowStepStatus(s) === "running").length;
    const groupState = runningCount > 0 ? "running" : "done";
    return (
      <div
        className={`atl-group is-${groupState}`}
        role="group"
        aria-label={row.label}
      >
        <div className="atl-group__head">
          <span className="atl-group__rail-cap" aria-hidden="true" />
          <span className="atl-group__label">{row.label}</span>
          {runningCount > 0 && (
            <span className="atl-group__meta">{isZh ? `${runningCount} 运行中` : `${runningCount} running`}</span>
          )}
        </div>
        <div className="atl-group__body">
          {row.items.map((step) => (
            <TimelineStep key={rowStepId(step)} step={rowStepToTimelineStep(step)} inGroup />
          ))}
        </div>
      </div>
    );
  }
  return null;
}

function rowContentPropsEqual(
  prev: { row: Row; activityChild?: boolean; contentOnly?: boolean },
  next: { row: Row; activityChild?: boolean; contentOnly?: boolean },
): boolean {
  return (
    prev.row === next.row
    && !!prev.activityChild === !!next.activityChild
    && !!prev.contentOnly === !!next.contentOnly
  );
}

/** 滚动 flush 时未变 row 引用直接跳过 — row 稳定靠 stabilizeTimelineRows. */
export const RowContent = memo(RowContentImpl, rowContentPropsEqual);
