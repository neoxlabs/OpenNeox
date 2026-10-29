import React from 'react';
import ringUrl from '../../assets/brand/motion-ring.webp?inline';
import ballUrl from '../../assets/brand/motion-ball.webp?inline';
import './neox-mark-motion.css';

export type NeoxMarkState = 'idle' | 'think' | 'work' | 'done' | 'wait';

export const NeoxMarkMotion: React.FC<{ state: NeoxMarkState; size?: number; className?: string; title?: string }> = ({
  state, size = 30, className, title,
}) => (
  <span
    className={`nx-mk is-${state}${className ? ` ${className}` : ''}`}
    style={{ ['--s' as string]: `${size}px` }}
    role={title ? 'img' : undefined}
    aria-label={title}
    aria-hidden={title ? undefined : true}
  >
    <span className="nx-mk__halo" />
    <img className="nx-mk__ring" src={ringUrl} alt="" draggable={false} decoding="sync" />
    <span className="nx-mk__sweep" />
    <span className="nx-mk__orbit"><span className="nx-mk__ball"><img src={ballUrl} alt="" draggable={false} decoding="sync" /></span></span>
  </span>
);

export default NeoxMarkMotion;
