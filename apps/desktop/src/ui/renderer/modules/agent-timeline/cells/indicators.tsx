/* ============================================================
 * TypingIndicator + PausedIndicator — assistant message 空 streaming 占位
 *   设计文档 §6.4 短期共存方案: 跟 StatusBar 并存, Phase 5 placeholder 去掉时这两个组件
 *   也可以一起退出. 现在保留是为了 message bubble 内的 "思考中..." 体验.
 * ============================================================ */

import React from 'react';
import { useI18n } from '../../../hooks/useI18n';
import { LiveShimmerText } from '../components/LiveShimmerText';

export const TypingIndicator: React.FC<{ label?: string }> = ({ label }) => {
  const { isZh } = useI18n();
  return (
    <div className="atl-msg__typing" role="status" aria-live="polite">
      <LiveShimmerText className="atl-msg__typing-label" text={label || (isZh ? '思考中' : 'Thinking')} live />
      <span className="atl-msg__typing-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
    </div>
  );
};

export const PausedIndicator: React.FC = () => {
  const { isZh } = useI18n();
  return (
    <div className="atl-msg__typing is-paused" role="status" aria-live="polite">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
        <rect x="3.2" y="2.5" width="1.7" height="7" rx="0.4" />
        <rect x="7.1" y="2.5" width="1.7" height="7" rx="0.4" />
      </svg>
      <span className="atl-msg__typing-label">{isZh ? '已暂停' : 'Paused'}</span>
    </div>
  );
};
