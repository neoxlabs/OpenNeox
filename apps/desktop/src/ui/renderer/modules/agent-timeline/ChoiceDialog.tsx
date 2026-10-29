import React from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../../hooks/useI18n';

export type ChoiceOption<T extends string> = {
  id: T;
  art: string;
  name: string;
  /** 名字下面一行: 最想让人记住的那句 (占用 / 能力) */
  lead?: string;
  /** 0~1 的比例条, 不传就不画 */
  bar?: number;
  points: string[];
  /** 危险档: 选中描边和「当前」标用警示色 */
  tone?: 'danger';
  /** 点不了的档 (比如云端还没开放): 卡片灰着, 用 disabledNote 说清为什么 */
  disabled?: boolean;
  disabledNote?: string;
};

export function ChoiceDialog<T extends string>({
  title,
  sub,
  options,
  current,
  onPick,
  onClose,
  foot,
  cols,
}: {
  title: string;
  sub?: string;
  options: Array<ChoiceOption<T>>;
  current: T;
  /** 返回 Promise 时失败会显示在底部; 选中当前档不回调 */
  onPick: (id: T) => void | Promise<void>;
  onClose: () => void;
  foot?: string;
  /** 一行最多几张, 多出来的折到下一行 (档数不固定时用, 比如回复风格带自定义项); 缺省 = 全部一行 */
  cols?: number;
}): React.ReactElement {
  const { isZh } = useI18n();
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const pick = (id: T) => {
    setErr(null);
    if (id === current) return;
    Promise.resolve(onPick(id)).catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
  };

  return createPortal(
    <div className="nx-choice" role="presentation">
      <div className="nx-choice__scrim" onMouseDown={onClose} aria-hidden="true" />
      <div
        className="nx-choice__card"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ ['--nx-choice-cols' as string]: Math.min(options.length, cols ?? options.length) }}
      >
        <button type="button" className="nx-choice__close" onClick={onClose} aria-label={isZh ? '关闭' : 'Close'}>
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
        <h3 className="nx-choice__title">{title}</h3>
        {sub ? <p className="nx-choice__sub">{sub}</p> : null}
        <div className="nx-choice__opts" role="radiogroup" aria-label={title}>
          {options.map((o) => {
            const on = current === o.id;
            return (
              <button
                key={o.id}
                type="button"
                role="radio"
                aria-checked={on}
                aria-disabled={o.disabled || undefined}
                disabled={o.disabled}
                title={o.disabled ? o.disabledNote : undefined}
                className={`nx-choice__opt${on ? ' is-on' : ''}${o.tone ? ` is-${o.tone}` : ''}${o.disabled ? ' is-disabled' : ''}`}
                onClick={() => pick(o.id)}
              >
                <span className="nx-choice__stage" aria-hidden="true">
                  <span className="nx-choice__glow" />
                  <img className="nx-choice__art" src={o.art} alt="" draggable={false} />
                </span>
                <span className="nx-choice__head">
                  <span className="nx-choice__name">{o.name}</span>
                  {on ? <span className="nx-choice__check">{isZh ? '当前' : 'Current'}</span> : null}
                  {o.disabled && !on ? <span className="nx-choice__check is-muted">{o.disabledNote ?? (isZh ? '不可用' : 'Unavailable')}</span> : null}
                </span>
                {o.lead ? <span className="nx-choice__lead">{o.lead}</span> : null}
                {typeof o.bar === 'number' ? (
                  <span className="nx-choice__bar" aria-hidden="true"><i style={{ width: `${Math.round(o.bar * 100)}%` }} /></span>
                ) : null}
                <ul className="nx-choice__points">
                  {o.points.map((p) => <li key={p}>{p}</li>)}
                </ul>
              </button>
            );
          })}
        </div>
        {err || foot ? (
          <p className={`nx-choice__foot${err ? ' is-error' : ''}`}>
            {err ? (isZh ? `没切成: ${err}` : `Couldn't switch: ${err}`) : foot}
          </p>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
