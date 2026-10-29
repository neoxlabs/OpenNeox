import React from 'react';

/** 行宽用固定序列而不是随机 —— 随机会让每次重挂载的骨架形状都变, 视觉上像在抖。 */
const ROWS: Array<{ side: 'user' | 'agent' | 'tool'; widths: number[] }> = [
  { side: 'user',  widths: [46] },
  { side: 'agent', widths: [92, 78, 61] },
  { side: 'tool',  widths: [38] },
  { side: 'agent', widths: [88, 54] },
  { side: 'user',  widths: [33] },
  { side: 'agent', widths: [95, 83, 70, 44] },
];

export const TimelineSkeleton: React.FC = () => (
  <div className="atl-skel" aria-busy="true" aria-live="polite">
    {ROWS.map((row, i) => (
      <div key={i} className={`atl-skel__row atl-skel__row--${row.side}`}>
        {row.side === 'tool' && <span className="atl-skel__dot" />}
        <div className="atl-skel__lines">
          {row.widths.map((w, j) => (
            <span key={j} className="atl-skel__line" style={{ width: `${w}%` }} />
          ))}
        </div>
      </div>
    ))}
  </div>
);

export default TimelineSkeleton;
