import React from 'react';
import './busy-card.css';

export const BusyCard: React.FC<{
  isZh: boolean;
  /** 当前选中的模型名 (判断是不是特惠版) */
  modelName?: string | null;
  repeatCount?: number;
  lastAt?: string;
  requestId?: string;
  onDismiss: () => void;
}> = ({ isZh, modelName, repeatCount, lastAt, requestId, onDismiss }) => {
  const isPromo = !!modelName && /-promo$/i.test(modelName);
  const standardName = isPromo ? modelName!.replace(/-promo$/i, '') : null;
  const [copied, setCopied] = React.useState(false);

  const retry = () => {
    window.dispatchEvent(new CustomEvent('neox:retry-last-prompt', { detail: { from: 'busy-card' } }));
    onDismiss();
  };
  const pickModel = () => {
    window.dispatchEvent(new CustomEvent('neox:open-model-picker', { detail: { from: 'busy-card' } }));
    onDismiss();
  };
  const useStandard = () => {
    window.dispatchEvent(new CustomEvent('neox:switch-model', { detail: { name: standardName, from: 'busy-card' } }));
    onDismiss();
  };
  const copyId = () => {
    if (!requestId) return;
    try { void navigator.clipboard?.writeText(requestId); setCopied(true); window.setTimeout(() => setCopied(false), 1400); } catch { /* ignore */ }
  };

  const title = isZh ? '模型这会儿有点忙' : 'This model is busy right now';
  const desc = isPromo
    ? (isZh ? '特惠线路人多，暂时没挤上。换回标准版马上就能继续，或者稍等再试。' : 'The promo line is crowded. Switch back to the standard model to continue now, or try again shortly.')
    : (isZh ? '我们已经自动换过线路，还是没接上。稍等几秒重试，或者先换个模型继续。' : 'We already tried other routes. Retry in a few seconds, or switch to another model for now.');

  return (
    <div className="nx-busy" role="status" aria-live="polite">
      <div className="nx-busy__icon" aria-hidden>
        <span /><span /><span />
      </div>
      <div className="nx-busy__body">
        <div className="nx-busy__title">
          {title}
          {typeof repeatCount === 'number' && repeatCount > 1 && (
            <span className="nx-busy__count">
              {isZh ? `第 ${repeatCount} 次` : `${repeatCount}×`}{lastAt ? ` · ${lastAt}` : ''}
            </span>
          )}
        </div>
        <div className="nx-busy__desc">{desc}</div>
        <div className="nx-busy__actions">
          {isPromo ? (
            <>
              <button type="button" className="nx-busy__btn nx-busy__btn--primary" onClick={useStandard}>
                {isZh ? '换回标准版' : 'Use standard model'}
              </button>
              <button type="button" className="nx-busy__btn" onClick={retry}>{isZh ? '重试' : 'Retry'}</button>
              <button type="button" className="nx-busy__link" onClick={pickModel}>{isZh ? '换个模型' : 'Other models'}</button>
            </>
          ) : (
            <>
              <button type="button" className="nx-busy__btn nx-busy__btn--primary" onClick={retry}>{isZh ? '重试' : 'Retry'}</button>
              <button type="button" className="nx-busy__btn" onClick={pickModel}>{isZh ? '换个模型' : 'Switch model'}</button>
            </>
          )}
          {requestId && (
            <button type="button" className="nx-busy__id" onClick={copyId} title={isZh ? '复制请求 ID, 报障时给我们' : 'Copy request ID for support'}>
              {copied ? (isZh ? '已复制' : 'Copied') : `ID ${requestId.slice(0, 8)}`}
            </button>
          )}
        </div>
      </div>
      <button type="button" className="nx-busy__close" onClick={onDismiss} aria-label={isZh ? '关闭' : 'Dismiss'}>
        <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" /></svg>
      </button>
    </div>
  );
};
