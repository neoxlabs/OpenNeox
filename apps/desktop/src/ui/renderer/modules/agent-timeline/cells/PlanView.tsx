import React from 'react';
import type { PlanItemStatus, PlanStepRow } from '../types';
import { FilePathChip } from '../FilePathChip';
import { useI18n } from '../../../hooks/useI18n';
import { formatPlanDuration, phaseLabel, stepsMissingPhase } from '../planTiming';

const PLAN_STATUS_CLS: Record<PlanItemStatus, string> = {
  pending: 'is-pending',
  in_progress: 'is-running',
  completed: 'is-done',
  failed: 'is-fail',
  skipped: 'is-skip',
  blocked: 'is-block',
  verifying: 'is-running',
};

export const PlanView: React.FC<{ goal?: string; steps: PlanStepRow[]; planPath?: string; frozen?: boolean }> = ({ goal, steps, planPath, frozen }) => {
  const { isZh } = useI18n();
  const done = steps.filter((s) => s.status === 'completed').length;
  /* Q-09: 模型没给阶段时, 这张卡上也提一句 —— 只提示, 不拦。 */
  const missingPhase = stepsMissingPhase(steps);
  return (
    <div className={`atl-plan${frozen ? ' is-frozen' : ''}`}>
      {goal && <div className="atl-plan__goal">{goal}</div>}
      <div className="atl-plan__meta">
        <span>{done} / {steps.length} {isZh ? '已完成' : 'done'}</span>
        {/* update_plan 落盘路径 — 单击 Surface 预览, 双击编辑器, 右键菜单. 不再"plan 在哪"黑盒. */}
        {planPath && <FilePathChip path={planPath} display="plan.md" className="atl-plan__path" />}
      </div>
      <ol className="atl-plan__list">
        {missingPhase > 0 && (
          <li className="atl-plan__hint" role="note">
            {isZh
              ? `有 ${missingPhase} 步没标阶段 (读材料 / 核对 / 产出 / 自检) —— 可以让 agent 重写计划`
              : `${missingPhase} step(s) have no phase (Read / Check / Produce / Verify) — ask the agent to rewrite the plan`}
          </li>
        )}
        {steps.map((s) => (
          <li key={s.id} className={`atl-plan__row ${PLAN_STATUS_CLS[s.status]}`}>
            <span className="atl-plan__box" aria-hidden="true" />
            <span className="atl-plan__text">{s.content}</span>
            {s.phase && <span className="atl-plan__phase">{phaseLabel(s.phase, isZh)}</span>}
            {s.estimateSec ? (
              <span className="atl-plan__est">
                {isZh ? `约 ${formatPlanDuration(s.estimateSec)}` : `~${formatPlanDuration(s.estimateSec)}`}
              </span>
            ) : null}
            {s.priority && <span className="atl-plan__prio">{s.priority}</span>}
          </li>
        ))}
      </ol>
    </div>
  );
};
