/**
 * PetPlanBar — 桌宠身边的 plan 进度条
 *
 * Agent 用 update_plan 工具时, 显示 "x / N 步" + 横条进度. 没 plan 时 null.
 * pointer-events:none — 进度条不挡拖拽.
 */

import React from 'react';
import { useI18n } from '../../hooks/useI18n';

interface PetPlanBarProps {
  done: number;
  total: number;
  /** 主色 — 默认琥珀色, 跟桌宠 sprite 暖色调呼应 */
  color?: string;
}

export const PetPlanBar: React.FC<PetPlanBarProps> = ({ done, total, color = '#f59e0b' }) => {
  const { isZh } = useI18n();
  if (!total) return null;
  const pct = Math.max(0, Math.min(100, (done / total) * 100));
  const isComplete = done >= total;

  return (
    <div
      style={{
        position: 'absolute',
        left: 8,
        bottom: 8,
        width: 84,
        padding: '6px 8px',
        background: 'rgba(20, 20, 24, 0.85)',
        borderRadius: 8,
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
        pointerEvents: 'none',
        userSelect: 'none',
        backdropFilter: 'blur(6px)',
      }}
    >
      <div style={{
        fontSize: 10,
        color: '#fff',
        marginBottom: 4,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}>
        <span style={{ opacity: 0.7 }}>{isZh ? '计划' : 'Plan'}</span>
        <span style={{ fontWeight: 600 }}>
          {isComplete ? '✓' : `${done}/${total}`}
        </span>
      </div>
      <div style={{
        height: 4,
        background: 'rgba(255, 255, 255, 0.15)',
        borderRadius: 2,
        overflow: 'hidden',
      }}>
        <div style={{
          width: `${pct}%`,
          height: '100%',
          background: isComplete ? '#22c55e' : color,
          transition: 'width 400ms ease-out',
          borderRadius: 2,
        }} />
      </div>
    </div>
  );
};

export default PetPlanBar;
