
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { defaultIsZh } from '../../hooks/useI18n';

export interface CompareImage { url: string; path: string }

interface Props {
  open: boolean;
  images: CompareImage[];
  zh?: boolean;
  onClose: () => void;
  /** 保留 keepIdx 这张, 其余由调用方删除并更新 turn. */
  onKeepOne: (keepIdx: number) => void;
  /** 用这张继续改 (打开编辑器). */
  onEditOne: (img: CompareImage) => void;
}

export const ImageCompareGrid: React.FC<Props> = ({ open, images, zh = defaultIsZh(), onClose, onKeepOne, onEditOne }) => {
  const [sel, setSel] = useState<number | null>(null);

  useEffect(() => { if (open) setSel(images.length === 1 ? 0 : null); }, [open, images.length]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || images.length === 0) return null;

  const cols = images.length <= 2 ? images.length : images.length <= 4 ? 2 : 3;

  return createPortal(
    <div onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 2147483000, background: 'rgba(0,0,0,0.72)', backdropFilter: 'blur(3px)', WebkitBackdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 36 }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: '90vw', maxHeight: '86vh', background: 'var(--neox-bg-card, #fff)', borderRadius: 16, boxShadow: '0 30px 80px rgba(0,0,0,0.4)', padding: 18 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--neox-fg-primary)' }}>{zh ? '并排挑一张' : 'Pick your favorite'}</span>
          <span style={{ fontSize: 12, color: 'var(--neox-fg-secondary, #9ca3af)' }}>{zh ? `共 ${images.length} 张 · 点选` : `${images.length} images`}</span>
          <div style={{ flex: 1 }} />
          <button type="button" onClick={onClose} title={zh ? '全部保留并关闭 (Esc)' : 'Keep all & close (Esc)'}
            style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--neox-fg-secondary, #9ca3af)', fontSize: 13, padding: '2px 6px' }}>
            {zh ? '全部保留' : 'Keep all'} ✕
          </button>
        </div>

        <div style={{ overflowY: 'auto', display: 'grid', gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: 10 }}>
          {images.map((img, i) => (
            <button key={img.path || i} type="button" onClick={() => setSel(i)}
              style={{ position: 'relative', display: 'block', padding: 0, border: sel === i ? '3px solid var(--neox-primary-500, #3b82f6)' : '3px solid transparent', borderRadius: 12, overflow: 'hidden', cursor: 'pointer', background: 'var(--neox-bg-subtle, rgba(0,0,0,0.04))', boxSizing: 'border-box' }}>
              <img src={img.url} alt={`#${i + 1}`} style={{ width: '100%', height: 'auto', display: 'block', maxHeight: '58vh', objectFit: 'contain' }} />
              <span style={{ position: 'absolute', top: 8, left: 8, fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 999, background: 'rgba(17,24,39,0.6)', color: '#fff' }}>#{i + 1}</span>
              {sel === i && (
                <span style={{ position: 'absolute', top: 8, right: 8, width: 22, height: 22, borderRadius: '50%', background: 'var(--neox-primary-500, #3b82f6)', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                </span>
              )}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" disabled={sel == null} onClick={() => sel != null && onEditOne(images[sel])}
            style={{ padding: '9px 16px', borderRadius: 10, cursor: sel != null ? 'pointer' : 'default', border: '1px solid var(--neox-line, rgba(0,0,0,0.12))', background: 'transparent', color: sel != null ? 'var(--neox-fg-primary)' : 'var(--neox-fg-hint, #c4c4c8)', fontSize: 13.5, fontWeight: 500 }}>
            {zh ? '继续改这张' : 'Refine this one'}
          </button>
          <button type="button" disabled={sel == null} onClick={() => sel != null && onKeepOne(sel)}
            title={zh ? '其余几张将被删除' : 'Others will be deleted'}
            style={{ padding: '9px 18px', borderRadius: 10, cursor: sel != null ? 'pointer' : 'default', border: 'none', background: sel != null ? 'linear-gradient(135deg,#3b82f6,#2563eb)' : 'var(--neox-bg-subtle, rgba(0,0,0,0.08))', color: '#fff', fontSize: 13.5, fontWeight: 600, boxShadow: sel != null ? '0 4px 14px rgba(37,99,235,0.35)' : 'none' }}>
            {zh ? '只保留这张' : 'Keep only this'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default ImageCompareGrid;
