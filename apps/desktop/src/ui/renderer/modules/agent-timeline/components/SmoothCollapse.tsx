import React, { useEffect, useRef, useState } from 'react';

const DURATION_MS = 200;

export const SmoothCollapse: React.FC<{ open: boolean; className?: string; children: React.ReactNode }> = ({ open, className, children }) => {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) { first.current = false; return; }
    window.dispatchEvent(new CustomEvent('neox:timeline-layout-transition', { detail: { source: 'smooth-collapse', durationMs: DURATION_MS + 40 } }));
    if (open) {
      setMounted(true);
      /* 先以 0fr 挂上, 下一帧再切 1fr, 过渡才有起点 */
      const raf = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
      return () => cancelAnimationFrame(raf);
    }
    setShown(false);
    const t = window.setTimeout(() => setMounted(false), DURATION_MS + 20);
    return () => window.clearTimeout(t);
  }, [open]);

  if (!mounted) return null;
  return (
    <div className={`nx-collapse${shown ? ' is-open' : ''}${className ? ` ${className}` : ''}`}>
      <div className="nx-collapse__inner">{children}</div>
    </div>
  );
};

export default SmoothCollapse;
