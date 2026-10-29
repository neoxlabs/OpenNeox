import React, { useEffect, useMemo } from 'react';
import { useI18n } from '../../hooks/useI18n';
import type { DockPill } from './dock/dockTypes';
import { useTeamPlan, useTeamExec, hydrateTeamPlan, getTeamPlanSnapshot, teamStageMeta } from '../../state/teamPlanStore';
import { openTeamSurface } from '../../state/teamRunStore';

const TeamIcon = (): React.ReactElement => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden>
    <circle cx="5.4" cy="6" r="2.1" stroke="currentColor" strokeWidth="1.3" />
    <circle cx="10.8" cy="6" r="1.7" stroke="currentColor" strokeWidth="1.3" />
    <path d="M1.8 13c0-2 1.6-3.3 3.6-3.3s3.6 1.3 3.6 3.3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    <path d="M10.4 9.9c1.9 0 3.4 1.2 3.4 3.1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
);

export function useTeamPill(activeSessionId?: string | null): DockPill | null {
  const { isZh } = useI18n();
  const plan = useTeamPlan(activeSessionId);
  const exec = useTeamExec(activeSessionId);
  /* 切会话 / 刷新后从库里重建 —— 内存 store 只是缓存 */
  useEffect(() => {
    let alive = true;
    void hydrateTeamPlan(activeSessionId).then(() => {
      if (!alive || !activeSessionId) return;
      const p = getTeamPlanSnapshot(activeSessionId);
      if (p?.teamId) openTeamSurface(activeSessionId, { teamId: p.teamId, goal: p.goal, reveal: true });
    });
    return () => { alive = false; };
  }, [activeSessionId]);

  return useMemo(() => {
    if (!plan) return null;
    const meta = teamStageMeta(plan, isZh);
    const ready = plan.stage === 'ready';
    const claimed = new Set(plan.claims.flatMap((c) => c.requirementIds));
    const assignedCount = plan.requirements.filter((r) => claimed.has(r.id)).length;
    const p = exec ? {
      done: exec.tasks.filter((t) => t.state === 'done').length,
      failed: exec.tasks.filter((t) => t.state === 'failed').length,
      total: exec.tasks.length,
    } : null;
    const execRunning = exec?.status === 'running' || exec?.status === 'paused';
    const execFinished = exec?.status === 'done' || exec?.status === 'failed';
    const label = execFinished
      ? (p!.failed > 0
        ? (isZh ? `团队完工 · ${p!.failed} 条失败` : `Team done · ${p!.failed} failed`)
        : (isZh ? '团队已完工' : 'Team finished'))
      : execRunning
        ? (isZh ? '团队执行中' : 'Team running')
        : ready ? (isZh ? '团队方案就绪' : 'Team plan ready')
          : (isZh ? `团队 · ${meta.label}` : `Team · ${meta.label}`);
    return {
      id: `team:${plan.sessionId}`,
      tone: execFinished && p!.failed > 0 ? 'warn' : (execFinished || ready) ? 'ok' : 'running',
      icon: <TeamIcon />,
      label,
      meta: p ? `${p.done}/${p.total}` : (ready ? undefined : meta.step),
      weight: 18,
      updatedAt: Math.max(plan.updatedAt, exec?.updatedAt ?? 0),
      ariaLabel: [isZh ? '团队' : 'Team', meta.label, meta.detail].filter(Boolean).join(' · '),
      panel: (
        <div className="nx-team-panel">
          {/* 头: 这是什么 + 走到哪一步 —— 一坨灰方块里最该先看到的两件事 */}
          <div className="nx-team-panel__head">
            <span className={`nx-team-panel__stage is-${plan.stage}`}>
              <span className="nx-team-panel__dot" aria-hidden="true" />
              {meta.step} {meta.label}
            </span>
            <span className="nx-team-panel__counts">
              {isZh ? `${plan.requirements.length} 条需求 · ${plan.roster.length} 人` : `${plan.requirements.length} reqs · ${plan.roster.length} people`}
            </span>
          </div>

          {/* 身: 目标原文, 最多三行 */}
          <div className="nx-team-panel__goal" title={plan.goal}>{plan.goal}</div>

          {/* 进度: 已分配 / 总数, 一条细进度条比一行数字直观 */}
          {plan.requirements.length > 0 && (
            <div className="nx-team-panel__prog">
              <div className="nx-team-panel__bar">
                <span style={{ width: `${Math.round((assignedCount / plan.requirements.length) * 100)}%` }} />
              </div>
              <span className="nx-team-panel__prog-txt">
                {isZh ? `已分配 ${assignedCount}/${plan.requirements.length}` : `${assignedCount}/${plan.requirements.length} assigned`}
              </span>
            </div>
          )}

          {/* 脚: 唯一的动作 */}
          <button
            type="button"
            className="nx-team-panel__open"
            onClick={() => openTeamSurface(plan.sessionId, { teamId: plan.teamId, goal: plan.goal, reveal: true })}
          >
            {isZh ? '打开团队看板' : 'Open team board'}
            <span aria-hidden="true">→</span>
          </button>
        </div>
      ),
    };
  }, [plan, exec, isZh]);
}
