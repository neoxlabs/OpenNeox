import React, { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../hooks/useI18n';

interface Props {
  children: React.ReactNode;
  /** popover 对齐方向, default 'left' (从 i 图标左侧延伸) */
  align?: 'left' | 'right';
}

export const SettingTip: React.FC<Props> = ({ children, align = 'left' }) => {
  const { isZh } = useI18n();
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  return (
    <span ref={wrapperRef} className="setting-tip" style={{ display: 'inline-flex', position: 'relative', verticalAlign: 'middle' }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-label={isZh ? '详细说明' : 'More details'}
        aria-expanded={open}
        title={isZh ? '详细说明' : 'More details'}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 14,
          height: 14,
          marginLeft: 6,
          padding: 0,
          border: 0,
          borderRadius: '50%',
          background: open ? 'var(--neox-primary-100, rgba(108,92,242,0.16))' : 'rgba(0,0,0,0.06)',
          color: open ? 'var(--neox-primary-600, #6c5cf2)' : 'var(--neox-fg-hint, #94a3b8)',
          cursor: 'pointer',
          fontSize: 10,
          fontWeight: 700,
          lineHeight: 1,
          fontFamily: 'serif',
          fontStyle: 'italic',
          transition: 'background 120ms, color 120ms',
        }}
      >i</button>
      {open && (
        <span
          role="tooltip"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            ...(align === 'right' ? { right: 0 } : { left: 0 }),
            zIndex: 1000,
            padding: '10px 12px',
            background: 'var(--neox-bg-card, #fff)',
            color: 'var(--neox-fg-secondary, #475569)',
            border: '1px solid var(--neox-line, rgba(15,23,42,0.08))',
            borderRadius: 8,
            fontSize: 12,
            lineHeight: 1.55,
            minWidth: 240,
            maxWidth: 380,
            boxShadow: '0 6px 24px rgba(15,23,42,0.10)',
            whiteSpace: 'normal',
            textAlign: 'left',
            fontWeight: 400,
          }}
        >
          {children}
        </span>
      )}
    </span>
  );
};

export default SettingTip;
