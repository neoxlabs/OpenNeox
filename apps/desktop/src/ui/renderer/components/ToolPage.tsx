import React from 'react';
import './tool-page.css';

/** 从「工具」主页点进来时, 返回按钮写「工具」(回主页) 而不是「返回任务」—— 宿主用它包住工具页 */
export const ToolBackLabelContext = React.createContext<string | null>(null);

export const ToolBackButton: React.FC<{ onBack: () => void; zh: boolean; label?: string }> = ({ onBack, zh, label }) => {
  const ctx = React.useContext(ToolBackLabelContext);
  return (
    <button type="button" className="tp-back" onClick={onBack}>
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" /></svg>
      {label ?? ctx ?? (zh ? '返回任务' : 'Back to tasks')}
    </button>
  );
};

export const ToolPageHeader: React.FC<{
  icon: string;
  title: string;
  desc: string;
  actions?: React.ReactNode;
  onBack?: () => void;
  zh: boolean;
}> = ({ icon, title, desc, actions, onBack, zh }) => (
  <>
    {onBack && <ToolBackButton onBack={onBack} zh={zh} />}
    <header className="tp-head">
      <img className="tp-head__icon" src={icon} alt="" draggable={false} />
      <div className="tp-head__text">
        <h1 className="tp-head__title">{title}</h1>
        <p className="tp-head__desc">{desc}</p>
      </div>
      {actions && <div className="tp-head__actions">{actions}</div>}
    </header>
  </>
);

export interface ToolStat { value: React.ReactNode; label: string; tone?: 'warn' | 'accent' }

export const ToolStats: React.FC<{ items: ToolStat[]; right?: React.ReactNode }> = ({ items, right }) => (
  <div className="tp-stats">
    {items.map((s) => (
      <div key={s.label} className={`tp-stats__item${s.tone ? ` is-${s.tone}` : ''}`}>
        <div className="tp-stats__value">{s.value}</div>
        <div className="tp-stats__label">{s.label}</div>
      </div>
    ))}
    {right && <div className="tp-stats__right">{right}</div>}
  </div>
);

/** 工具页里的普通按钮 / 主按钮 (蓝) —— 跟设计稿同一套 */
export const ToolButton: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }> = ({ primary, className, ...rest }) => (
  <button type="button" className={`tp-btn${primary ? ' is-primary' : ''}${className ? ` ${className}` : ''}`} {...rest} />
);
