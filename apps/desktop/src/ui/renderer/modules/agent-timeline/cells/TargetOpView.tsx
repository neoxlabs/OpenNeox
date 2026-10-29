import React from 'react';
import { useI18n } from '../../../hooks/useI18n';

/**
 * TargetOpView — Target Mission 四工具的展示卡.
 *
 * 样式对齐 .atl-explore 家族 (中性 fg 3% 淡底 + radius 8 + 无 border), 铺满宽度.
 * 与 op_chip 紫色 inline 胶囊区分开 — Target 4 工具是"有实质状态的动作",
 * 值得独立铺满卡展示; op_chip 是"过场状态切换", 用小胶囊即可.
 *
 * 目标文本完整展示 (word-break 换行, 不 slice 截断). 参考图 4 explore 卡:
 * "Explore 完成 · 1 工具 · grep package\\.json 0 命中" 这种铺满淡底的既视感.
 */

type Variant = 'activate' | 'plan' | 'done_true' | 'done_false' | 'abandon';
type Tone = 'primary' | 'ok' | 'plain' | 'err';

const TargetIcon: React.FC<{ variant: Variant }> = ({ variant }) => {
  const common = {
    viewBox: '0 0 16 16',
    width: 14,
    height: 14,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  switch (variant) {
    case 'activate':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6" />
          <circle cx="8" cy="8" r="3" />
          <circle cx="8" cy="8" r="0.8" fill="currentColor" />
        </svg>
      );
    case 'plan':
      return (
        <svg {...common}>
          <rect x="3" y="3" width="10" height="11" rx="1.5" />
          <path d="M5.5 6h5M5.5 8.5h5M5.5 11h3" />
        </svg>
      );
    case 'done_true':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6" />
          <path d="M5.5 8.5l2 2 3.5-4" />
        </svg>
      );
    case 'done_false':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6" />
          <path d="M8 5v3.5l2 1.5" />
        </svg>
      );
    case 'abandon':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6" />
          <path d="M5 5l6 6M11 5l-6 6" />
        </svg>
      );
    default:
      return null;
  }
};

const LABELS: Record<Variant, { zh: string; en: string }> = {
  activate: { zh: '激活 Target', en: 'Activate Target' },
  plan:     { zh: '声明 Plan',   en: 'Declare Plan' },
  done_true:  { zh: 'Target 达成', en: 'Target Reached' },
  done_false: { zh: '继续推进',    en: 'Continuing' },
  abandon:  { zh: '放弃 Target', en: 'Abandon Target' },
};

type SubMissionStatus = 'pending' | 'in_progress' | 'completed';
const STATUS_GLYPH: Record<SubMissionStatus, string> = { pending: '○', in_progress: '◐', completed: '✓' };

export const TargetOpView: React.FC<{
  variant: Variant;
  /** label 由 mapTimeline 传, 但 UI 优先按 variant + i18n 派生 (本地化). 保留字段作为兼容 fallback. */
  label: string;
  target?: string;
  note?: string;
  subMissionCount?: number;
  completedSubMissions?: number;
  subMissions?: Array<{ id: string; description: string; successCriteria?: string; status?: SubMissionStatus }>;
  tone: Tone;
}> = ({ variant, label, target, note, subMissionCount, completedSubMissions, subMissions, tone }) => {
  const { isZh } = useI18n();
  const localizedLabel = LABELS[variant]?.[isZh ? 'zh' : 'en'] ?? label;
  // 双层规划: plan_target 卡显示宏观进度 "已完成/总数 块".
  const doneCount = typeof completedSubMissions === 'number' ? completedSubMissions : 0;
  const stepChip = typeof subMissionCount === 'number' && subMissionCount > 0
    ? isZh
      ? `${doneCount}/${subMissionCount} 块`
      : `${doneCount}/${subMissionCount} block${subMissionCount === 1 ? '' : 's'}`
    : null;
  return (
  <div className={`atl-targetop is-${tone}`}>
    <div className="atl-targetop__head">
      <span className="atl-targetop__icon" aria-hidden="true">
        <TargetIcon variant={variant} />
      </span>
      <span className="atl-targetop__label">{localizedLabel}</span>
      {stepChip && <span className="atl-targetop__chip">{stepChip}</span>}
    </div>
    {target && (
      <div className="atl-targetop__target" title={target}>
        {target}
      </div>
    )}
    {subMissions && subMissions.length > 0 && (
      <ol className="atl-targetop__steps">
        {subMissions.map((sm, i) => {
          const st: SubMissionStatus = sm.status ?? 'pending';
          return (
          <li key={sm.id || i} className={`atl-targetop__step is-${st}`}>
            <span className="atl-targetop__step-idx" aria-hidden="true">{STATUS_GLYPH[st]}</span>
            <div className="atl-targetop__step-body">
              <div className="atl-targetop__step-desc">{sm.description}</div>
              {sm.successCriteria && (
                <div className="atl-targetop__step-criteria" title={sm.successCriteria}>
                  ✓ {sm.successCriteria}
                </div>
              )}
            </div>
          </li>
          );
        })}
      </ol>
    )}
    {note && (
      <div className="atl-targetop__note" title={note}>
        {note}
      </div>
    )}
  </div>
  );
};
