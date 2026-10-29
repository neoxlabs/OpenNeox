import React from 'react';

/* ---------- network · 9 variant 合 1 ---------- */
export const NetworkView: React.FC<{
  variant: string;
  label: string;
  tone?: 'primary' | 'ok' | 'warn' | 'err';
  fields?: Array<{ k: string; v: string | number; highlight?: boolean }>;
  list?: Array<{ main: string; sub?: string; badge?: string }>;
  extra?: string;
}> = ({ variant, label, tone = 'primary', fields, list, extra }) => (
  <div className={`atl-net atl-net--${variant} is-${tone}`}>
    <div className="atl-net__head">
      <span className="atl-net__label">{label}</span>
    </div>
    {fields && fields.length > 0 && (
      <div className="atl-net__fields">
        {fields.map((f, i) => (
          <span key={i} className="atl-net__field">
            <span className="atl-net__field-k">{f.k}</span>
            <span className={`atl-net__field-v${f.highlight ? ' is-highlight' : ''}`}>{f.v}</span>
          </span>
        ))}
      </div>
    )}
    {list && list.length > 0 && (
      <ul className="atl-net__list">
        {list.map((item, i) => (
          <li key={i} className="atl-net__item">
            <span className="atl-net__item-main">{item.main}</span>
            {item.sub && <span className="atl-net__item-sub">{item.sub}</span>}
            {item.badge && <span className="atl-net__item-badge">{item.badge}</span>}
          </li>
        ))}
      </ul>
    )}
    {extra && <div className="atl-net__extra">{extra}</div>}
  </div>
);

