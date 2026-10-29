/* 聚光卡 —— 上半部分一张插画 (带光晕和一点漂浮), 下半部分一个标题 + 一句话 + 按钮。
 *
 *   入场: 卡片从下方弹上来, 插画晚一拍浮起, 文字逐行淡入; 之后插画慢慢上下飘。
 *   出场: 缩一点 + 淡出, 动画结束才真正卸载 (onClosed)。
 *   减弱动效 (系统设置 / data-motion=reduced) 下只剩淡入淡出, 见 spotlight.css。
 */
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SpotlightCardDef, SpotlightKind } from './spotlightCards';
import './spotlight.css';

export type SpotlightCloseReason = 'dismiss' | 'cta' | 'off';

const KIND_LABEL: Record<SpotlightKind, { zh: string; en: string }> = {
  tip: { zh: '小技巧', en: 'Tip' },
  new: { zh: '新功能', en: 'New' },
  promo: { zh: '活动', en: 'Offer' },
};

const EXIT_MS = 180;

export const SpotlightCard: React.FC<{
  card: SpotlightCardDef;
  zh: boolean;
  /** 用户点了哪儿 —— 立刻回调 (记"看过"、执行 CTA 不用等动画) */
  onAction: (reason: SpotlightCloseReason) => void;
  /** 出场动画播完, 可以卸载了 */
  onClosed: () => void;
}> = ({ card, zh, onAction, onClosed }) => {
  const [leaving, setLeaving] = useState(false);
  /* 焦点给卡片本身, 不给主按钮 —— 程序聚焦的按钮会挂一圈焦点环, 一打开就像"已经被选中了" */
  const cardRef = useRef<HTMLDivElement | null>(null);
  const t = (s: { zh: string; en: string }) => (zh ? s.zh : s.en);
  const titleId = `nx-spot-title-${card.id}`;

  const close = (reason: SpotlightCloseReason) => {
    if (leaving) return;
    setLeaving(true);
    onAction(reason);
    window.setTimeout(onClosed, EXIT_MS);
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    cardRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      closeRef.current('dismiss');
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  return createPortal(
    <div className={`nx-spot${leaving ? ' is-leaving' : ''}`} data-kind={card.kind}>
      <div className="nx-spot__scrim" onMouseDown={() => close('dismiss')} aria-hidden="true" />
      <div ref={cardRef} tabIndex={-1} className="nx-spot__card" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="nx-spot__stage" aria-hidden="true">
          <span className="nx-spot__glow" />
          <span className="nx-spot__dots" />
          <img className="nx-spot__art" src={card.image} alt="" draggable={false} />
        </div>
        <button
          type="button"
          className="nx-spot__close"
          onClick={() => close('dismiss')}
          aria-label={zh ? '关闭' : 'Close'}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
        <div className="nx-spot__body">
          <span className="nx-spot__tag">{t(KIND_LABEL[card.kind])}</span>
          <h3 className="nx-spot__title" id={titleId}>{t(card.title)}</h3>
          <p className="nx-spot__text">{t(card.body)}</p>
          <div className="nx-spot__actions">
            <button type="button" className="nx-spot__off" onClick={() => close('off')}>
              {zh ? '不再提示' : "Don't show tips"}
            </button>
            <span className="nx-spot__spacer" />
            {card.cta ? (
              <>
                <button type="button" className="nx-spot__btn nx-spot__btn--ghost" onClick={() => close('dismiss')}>
                  {zh ? '知道了' : 'Got it'}
                </button>
                <button type="button" className="nx-spot__btn nx-spot__btn--primary" onClick={() => close('cta')}>
                  {t(card.cta.label)}
                </button>
              </>
            ) : (
              <button type="button" className="nx-spot__btn nx-spot__btn--primary" onClick={() => close('dismiss')}>
                {zh ? '知道了' : 'Got it'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
};
