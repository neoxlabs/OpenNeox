import React from 'react';
import type { CodeLine } from '../types';
import { useI18n } from '../../../hooks/useI18n';
import { CopyIconButton } from '../../../components/CopyIconButton';

export const CodeView: React.FC<{
  lines: CodeLine[];
  progress?: number;
  progressText?: string;
}> = ({ lines, progress, progressText }) => {
  const { isZh } = useI18n();
  const hasText = lines.some((l) => !l.text.startsWith('__IMG__'));
  /* 渲染期标记 —— 替代 `.atl-code:has(.atl-code__img)` (滚动期 :has 祖先重算, work:M-03) */
  const hasImage = lines.some((l) => l.text.startsWith('__IMG__'));
  const imageAttr = hasImage ? { 'data-has-image': '1' } : {};
  return (
    <div className="atl-code" {...imageAttr}>
      {hasText && (
        <CopyIconButton
          className="atl-code__copy"
          getText={() => lines.filter((l) => !l.text.startsWith('__IMG__')).map((l) => l.text).join('\n')}
        />
      )}
      <div className="atl-code__lines" {...imageAttr}>
        {lines.map((l, i) => {
          if (l.text.startsWith('__IMG__')) {
            return <img key={i} src={l.text.slice(7)} className="atl-code__img" alt="screenshot" />;
          }
          const cls = l.kind && l.kind !== 'normal' ? l.kind : '';
          return (
            <span key={i} className={cls}>
              {l.text}
              {'\n'}
            </span>
          );
        })}
      </div>
      {typeof progress === 'number' && (
        <div className="atl-progress">
          <div className="atl-progress__head">
            <span>{progressText ?? (isZh ? '执行中' : 'Running')}</span>
            <span className="atl-progress__pct">{Math.round(progress)}%</span>
          </div>
          <div
            className="atl-progress__bar"
            aria-valuenow={progress}
            aria-valuemin={0}
            aria-valuemax={100}
            role="progressbar"
          >
            <div
              className="atl-progress__fill"
              style={{ width: `${Math.max(0, Math.min(100, progress))}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
};
