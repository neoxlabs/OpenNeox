import React, { useCallback, useEffect, useRef, useState, memo } from "react";
import TimelineStep from "../TimelineStep";
import { getStepIconInfo } from "../stepIcons";
import type { StepIconKind } from "../types";
import type { RowStep } from "../timelineRows";
import {
  rowStepId,
  rowStepStatus,
  rowStepTone,
  rowStepTitle,
  rowStepToTimelineStep,
  foldRepeatedSteps,
} from "../timelineRows";
import { IconChevronDown } from "../../shell/shellIcons";
import { useI18n } from "../../../hooks/useI18n";

const LAYOUT_ANCHOR_TRANSITION_MS = 460;

/* ============================================================
 * ClusterRow — 串行同类折叠
 *   [icon] [head · N 个]  [target1 · target2 · +K]  [▼]
 *   展开: 缩进的每条 TimelineStep
 * ============================================================ */
const ClusterRowImpl: React.FC<{
  cluster: {
    id: string;
    iconKind: StepIconKind;
    head: string;
    items: RowStep[];
  };
}> = ({ cluster }) => {
  const { isZh } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [renderBody, setRenderBody] = useState(false);
  const bodyExitTimerRef = useRef<number | null>(null);
  const { Icon, className: iconClass } = getStepIconInfo(cluster.iconKind);
  const anyFailed = cluster.items.some(
    (s) => rowStepStatus(s) === "failed" && !rowStepTone(s),
  );
  const state = anyFailed ? "failed" : "done";

  useEffect(() => {
    if (bodyExitTimerRef.current) {
      window.clearTimeout(bodyExitTimerRef.current);
      bodyExitTimerRef.current = null;
    }
    if (expanded) {
      setRenderBody(true);
      return;
    }
    bodyExitTimerRef.current = window.setTimeout(() => {
      bodyExitTimerRef.current = null;
      setRenderBody(false);
    }, LAYOUT_ANCHOR_TRANSITION_MS);
    return () => {
      if (bodyExitTimerRef.current) {
        window.clearTimeout(bodyExitTimerRef.current);
        bodyExitTimerRef.current = null;
      }
    };
  }, [expanded]);

  const toggleExpanded = useCallback(() => {
    window.dispatchEvent(new CustomEvent("neox:timeline-layout-transition", {
      detail: { source: "cluster", durationMs: LAYOUT_ANCHOR_TRANSITION_MS }
    }));
    setExpanded((v) => !v);
  }, []);

  /* 展开后同一条重复 N 次只画一条, 尾巴挂 ×N —— 判据和理由见 foldRepeatedSteps */
  const dedupedItems = React.useMemo(() => foldRepeatedSteps(cluster.items), [cluster.items]);

  const targets = cluster.items
    .map((s) => {
      const t = rowStepTitle(s);
      const i = t.indexOf(" · ");
      return i > 0 ? t.slice(i + 3) : "";
    })
    .filter(Boolean);
  const chips = targets.slice(0, 3);
  const extra = targets.length - chips.length;

  return (
    <div className={`atl-cluster is-${state}${expanded ? " is-expanded" : ""}`}>
      <div
        className="atl-cluster__row"
        role="button"
        tabIndex={0}
        onClick={toggleExpanded}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggleExpanded();
          }
        }}
        aria-expanded={expanded}
      >
        <div className={`atl-tool__icon ${iconClass} atl-cluster__icon`}>
          <Icon size={14} />
        </div>
        <div className="atl-cluster__body">
          <span className="atl-cluster__title">{cluster.head}</span>
          <span className="atl-cluster__count">{isZh ? `${cluster.items.length} 个` : `×${cluster.items.length}`}</span>
          {chips.length > 0 && (
            <span className="atl-cluster__chips">
              {chips.map((t, i) => (
                <span key={i} className="atl-cluster__chip">
                  {t}
                </span>
              ))}
              {extra > 0 && <span className="atl-cluster__more">+{extra}</span>}
            </span>
          )}
        </div>
        {anyFailed && (
          <span className="atl-cluster__badge is-failed">{isZh ? '含失败' : 'Has failures'}</span>
        )}
        <span className="atl-cluster__chevron" aria-hidden="true">
          <IconChevronDown size={12} />
        </span>
      </div>
      {renderBody && (
        <div className={`atl-cluster__body-shell${expanded ? " is-open" : " is-closing"}`}>
          <div className="atl-cluster__body-shell-inner">
            <div className="atl-cluster__body-list">
              {dedupedItems.map(({ step, count }) => (
                <div key={rowStepId(step)} className="atl-cluster__item">
                  <TimelineStep step={rowStepToTimelineStep(step)} inGroup />
                  {count > 1 && (
                    <span className="atl-cluster__repeat" title={isZh ? `这一条重复了 ${count} 次` : `Repeated ${count} times`}>
                      ×{count}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export const ClusterRow = memo(ClusterRowImpl, (prev, next) => (
  prev.cluster === next.cluster
  || (
    prev.cluster.id === next.cluster.id
    && prev.cluster.head === next.cluster.head
    && prev.cluster.iconKind === next.cluster.iconKind
    && prev.cluster.items === next.cluster.items
  )
));

export default ClusterRow;
