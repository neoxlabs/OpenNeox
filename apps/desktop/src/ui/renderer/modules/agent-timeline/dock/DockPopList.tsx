import React from 'react';
import type { DockTone } from './dockTypes';

export interface DockPopAction {
  id: string;
  label: string;
  danger?: boolean;
  onClick: () => void;
}

export interface DockPopRowData {
  id: string;
  tone: DockTone;
  lead: React.ReactNode;
  title: string;
  /** 名字后面的灰字 (模型 / pid / exit) */
  note?: string;
  /** 第二行: 说明文字 (任务描述) */
  desc?: string;
  /** 第三行: 等宽尾巴 (命令 / 最后一行输出) */
  mono?: string;
  meta?: string;
  actions?: DockPopAction[];
  onOpen?: () => void;
}

export const DockPopList: React.FC<{ rows: DockPopRowData[]; empty?: string }> = ({ rows, empty }) => {
  if (rows.length === 0) return empty ? <div className="nx-pop__empty">{empty}</div> : null;
  return (
    <ul className="nx-pop__list">
      {rows.map((r) => (
        <li
          key={r.id}
          className={`nx-pop__row is-${r.tone}${r.onOpen ? ' is-link' : ''}`}
          role={r.onOpen ? 'button' : undefined}
          tabIndex={r.onOpen ? 0 : undefined}
          onClick={r.onOpen}
          onKeyDown={r.onOpen ? (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) r.onOpen?.(); } : undefined}
        >
          {/* 第一行: 头 · 名字 · 灰字 · 计时 · 动作; 说明和命令另起, 从名字那一列铺到右边 */}
          <div className="nx-pop__top">
            <span className="nx-pop__lead" aria-hidden="true">{r.lead}<i className="nx-pop__dot" /></span>
            <span className="nx-pop__line">
              <span className="nx-pop__title">{r.title}</span>
              {r.note && <span className="nx-pop__note">{r.note}</span>}
            </span>
            {r.meta && <span className="nx-pop__meta">{r.meta}</span>}
            {r.actions && r.actions.length > 0 && (
              <span className="nx-pop__acts">
                {r.actions.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    className={`nx-pop__act${a.danger ? ' is-danger' : ''}`}
                    onClick={(e) => { e.stopPropagation(); a.onClick(); }}
                  >
                    {a.label}
                  </button>
                ))}
              </span>
            )}
          </div>
          {(r.desc || r.mono) && (
            <div className="nx-pop__sub">
              {r.desc && <span className="nx-pop__desc">{r.desc}</span>}
              {r.mono && <code className="nx-pop__mono">{r.mono}</code>}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
};

/** 弹层底部一排文字按钮 (靠右) */
export const DockPopFoot: React.FC<{ actions: DockPopAction[]; hint?: string }> = ({ actions, hint }) => (
  <div className="nx-pop__foot">
    {hint && <span className="nx-pop__hint">{hint}</span>}
    {actions.map((a) => (
      <button key={a.id} type="button" className={`nx-pop__act${a.danger ? ' is-danger' : ''}`} onClick={a.onClick}>
        {a.label}
      </button>
    ))}
  </div>
);

/** 几个 tone 合成一个: 失败 > 等你 > 跑着 > 中断 > 收尾 > 中性 */
export function worstTone(tones: DockTone[]): DockTone {
  const order: DockTone[] = ['err', 'attention', 'running', 'warn', 'ok', 'muted'];
  for (const t of order) if (tones.includes(t)) return t;
  return 'muted';
}

/** 终端小图标 (后台命令) */
export const TerminalGlyph: React.FC = () => (
  <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2.4" />
    <path d="M4.6 6.4 6.6 8l-2 1.6M8.4 10h3" />
  </svg>
);

/** 子 Agent 兜底图标 (认不出模型品牌时) */
export const AgentGlyph: React.FC = () => (
  <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="8" cy="5.6" r="2.6" />
    <path d="M3 13.6c.6-2.4 2.6-3.8 5-3.8s4.4 1.4 5 3.8" />
  </svg>
);

/** 监控 (眼睛) */
export const EyeGlyph: React.FC = () => (
  <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M1.8 8C3.4 4.9 5.6 3.6 8 3.6s4.6 1.3 6.2 4.4C12.6 11.1 10.4 12.4 8 12.4S3.4 11.1 1.8 8Z" />
    <circle cx="8" cy="8" r="2" />
  </svg>
);
