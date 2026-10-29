import React from 'react';
import { useI18n } from '../../../hooks/useI18n';

export const TargetContinueView: React.FC<{
  iteration?: number;
  consecutiveBlocks?: number;
  kind?: 'target' | 'verify' | 'team_spec' | 'unfinished' | 'plan';
}> = ({ iteration, consecutiveBlocks, kind }) => {
  const { isZh } = useI18n();
  const isVerify = kind === 'verify';
  const isPlan = kind === 'plan';
  const isTeam = kind === 'team_spec';
  /* Jev 收尾判定: 模型说了「接下来我去…」却没调工具就要结束 */
  const isUnfinished = kind === 'unfinished';
  const title = isVerify
    ? (isZh ? '改完还没验证 · 先跑测试' : 'Changed but unverified · run tests first')
    : isPlan
    ? (isZh ? '计划还没做完 · 继续' : 'Plan unfinished · continuing')
    : isTeam
      ? (isZh ? '团队规划还没走完 · 继续' : 'Team plan unfinished · continuing')
      : isUnfinished
        ? (isZh ? '说了下一步但停了 · 继续' : 'Stopped after announcing a step · continuing')
        : (isZh ? 'Target 未完成 · 继续推进' : 'Target still open · continuing');

  const metaParts: string[] = [];
  if (typeof consecutiveBlocks === 'number' && consecutiveBlocks > 0) {
    metaParts.push(isZh ? `第 ${consecutiveBlocks} 次续跑` : `continue #${consecutiveBlocks}`);
  }
  if (typeof iteration === 'number' && iteration > 0) {
    metaParts.push(isZh ? `轮次 ${iteration}` : `iter ${iteration}`);
  }
  const meta = metaParts.length > 0 ? metaParts.join(' · ') : null;
  const tooltip = isVerify
    ? (isZh
      ? '本轮改过文件但没跑测试：闸门拦住退出，要求先验证'
      : 'Files changed but tests never ran: the gate blocked exit and asked for verification')
    : isPlan
    ? (isZh
      ? '本轮计划还有步骤没完成就要结束，已提醒一次：接着做，或在计划里如实标出'
      : 'The plan still had open steps at turn end; reminded once to finish them or mark them honestly')
    : isTeam
      ? (isZh
        ? '团队规划三段还没走完：闸门拦住退出并继续下一步'
        : 'Team planning has unfinished stages: the gate blocked exit and continued')
      : isUnfinished
        ? (isZh
          ? '模型宣布了下一步却没调工具就要结束（Jev 判定），已提醒它直接去做'
          : 'The model announced a next step but tried to end without doing it (Jev), so it was told to go ahead')
      : (isZh
      /* 「Target Mission」是内部叫法, 中文界面统一说「目标」(跟 targetPill 的
       * 目标达成 / 目标进行中 一套)。RELEASE_SCAN #116。 */
      ? '目标仍在进行：本轮无工具调用，闸门拦住退出并继续执行'
      : 'Target Mission still active: no tool calls this turn; the gate blocked exit and continued');

  const icon = (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="8" cy="8" r="1.6" fill="currentColor" />
      <path d="M8 2.2v1.6M8 12.2v1.6M2.2 8h1.6M12.2 8h1.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );

  return (
    <div
      className="atl-compact atl-compact--divider atl-compact--target is-completed"
      role="status"
      aria-live="polite"
      title={tooltip}
    >
      <span className="atl-compact__rail atl-compact__rail--left" aria-hidden="true" />
      <span className="atl-compact__icon" aria-hidden="true">{icon}</span>
      <span className="atl-compact__title">{title}</span>
      {meta && <span className="atl-compact__meta">{meta}</span>}
      <span className="atl-compact__icon atl-compact__icon--right" aria-hidden="true">{icon}</span>
      <span className="atl-compact__rail atl-compact__rail--right" aria-hidden="true" />
    </div>
  );
};
