/**
 * PlanStepRow — 计划里的一行, 带三个动作 (work:Q-06)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 使用两处的「计划卡」(输入框上方的计划药丸展开面板 / 时间线里的 PlanView):
 *   · 跳过 —— 这一步不做了 (状态变 skipped, 同时告诉 agent 别再执行);
 *   · 先做 —— 把它提到 in_progress, 从这儿开始;
 *   · 改名 —— 就地变输入框, 回车保存 / Esc 取消 / 失焦也保存。
 *
 * 已完成的步骤不给「跳过」—— 已经做过的事不该被改成没做。
 * 动作按钮默认半透明, 悬停这一行才完全显形: 计划是读的内容, 不是按钮集。
 */

import React, { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../hooks/useI18n';
import type { PlanUserEdit } from '../../state/planEdits';
import { formatPlanDuration, phaseLabel } from './planTiming';

const DONE = new Set(['completed', 'done']);
const SKIPPED = new Set(['skipped']);
const BAD = new Set(['failed', 'blocked']);

function statusClass(status: string): string {
  if (DONE.has(status)) return 'is-done';
  if (SKIPPED.has(status)) return 'is-skip';
  if (status === 'in_progress' || status === 'verifying') return 'is-running';
  if (BAD.has(status)) return 'is-bad';
  return 'is-pending';
}

export interface PlanStepRowProps {
  index: number;
  step: { id?: string; content?: string; status?: string; phase?: string; estimateSec?: number };
  disabled?: boolean;
  onEdit?: (edit: PlanUserEdit) => void;
  /** 已用秒数 (Q-07) —— 由 timeline 上的 plan entry 时间戳算出, 没开始过就没有 */
  elapsedSec?: number;
  /** 已用 > 2×预计 → 这一行转提醒色 */
  overEstimate?: boolean;
}

export const PlanStepRow: React.FC<PlanStepRowProps> = ({
  index, step, disabled, onEdit, elapsedSec, overEstimate,
}) => {
  const { isZh } = useI18n();
  const status = step.status ?? 'pending';
  const text = step.content ?? '';
  const phase = phaseLabel(step.phase, isZh);
  const estimate = step.estimateSec;
  const hasMeta = !!phase || !!estimate || elapsedSec !== undefined;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const commit = () => {
    const next = draft.trim();
    setEditing(false);
    if (!next || next === text) return;
    onEdit?.({ kind: 'rename', index, title: next });
  };

  const editable = !!onEdit && !disabled;
  const canSkip = editable && !DONE.has(status) && !SKIPPED.has(status);
  const canFocus = editable && !DONE.has(status) && !SKIPPED.has(status) && status !== 'in_progress';

  return (
    <li
      className={`atl-planbar__row ${statusClass(status)}${overEstimate ? ' is-over' : ''}`}
      data-plan-step={index}
    >
      <span className="atl-planbar__box" aria-hidden="true" />
      {editing ? (
        <input
          ref={inputRef}
          className="atl-planbar__edit"
          value={draft}
          aria-label={isZh ? `第 ${index + 1} 步标题` : `Step ${index + 1} title`}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            else if (e.key === 'Escape') { e.preventDefault(); setDraft(text); setEditing(false); }
          }}
        />
      ) : (
        <span className="atl-planbar__text">{text}</span>
      )}
      {!editing && hasMeta && (
        <span className={`atl-planbar__meta${overEstimate ? ' is-over' : ''}`}>
          {phase && <span className="atl-planbar__phase">{phase}</span>}
          {estimate ? (
            <span>{isZh ? `约 ${formatPlanDuration(estimate)}` : `~${formatPlanDuration(estimate)}`}</span>
          ) : null}
          {elapsedSec !== undefined ? (
            <span>{isZh ? `已用 ${formatPlanDuration(elapsedSec)}` : `${formatPlanDuration(elapsedSec)} used`}</span>
          ) : null}
        </span>
      )}
      {!editing && editable && (
        <span className="atl-planbar__acts">
          {canSkip && (
            <button
              type="button"
              className="atl-planbar__act"
              title={isZh ? `跳过第 ${index + 1} 步, 不再执行` : `Skip step ${index + 1}`}
              onClick={() => onEdit?.({ kind: 'skip', index })}
            >
              {isZh ? '跳过' : 'Skip'}
            </button>
          )}
          {canFocus && (
            <button
              type="button"
              className="atl-planbar__act"
              title={isZh ? `先做第 ${index + 1} 步` : `Do step ${index + 1} first`}
              onClick={() => onEdit?.({ kind: 'focus', index })}
            >
              {isZh ? '先做' : 'Do first'}
            </button>
          )}
          <button
            type="button"
            className="atl-planbar__act"
            title={isZh ? '改这一步的标题' : 'Rename this step'}
            onClick={() => { setDraft(text); setEditing(true); }}
          >
            {isZh ? '改名' : 'Rename'}
          </button>
        </span>
      )}
    </li>
  );
};

export default PlanStepRow;
