import React from 'react';
import './dot-spinner.css';

const DELAYS = [0, 1, 2, 1, 2, 3, 2, 3, 4];

export const DotSpinner: React.FC<{ size?: number; className?: string; title?: string }> = ({ size = 12, className, title }) => (
  <span
    className={`nx-dots${className ? ` ${className}` : ''}`}
    style={{ width: size, height: size }}
    role={title ? 'img' : undefined}
    aria-label={title}
    aria-hidden={title ? undefined : true}
  >
    {DELAYS.map((d, i) => (
      <i key={i} style={{ animationDelay: `${d * 120}ms` }} />
    ))}
  </span>
);

export default DotSpinner;
