
import React, { useEffect, useState } from 'react';
import { CATEGORIES, fillFromCategory, type ShowcaseCategory } from './ImageDiscoveryLanding';
import { defaultIsZh } from '../../hooks/useI18n';

interface Props { zh?: boolean; }

/* 单张灵感卡. */
const RailCard: React.FC<{ c: ShowcaseCategory; img?: string; zh: boolean }> = ({ c, img, zh }) => (
  <button
    type="button"
    className="neox-insp-card"
    title={zh ? c.labelZh : c.labelEn}
    onClick={() => fillFromCategory(c)}
    style={{
      position: 'relative', flexShrink: 0, width: 116, height: 116, borderRadius: 14,
      overflow: 'hidden', border: 'none', padding: 0, cursor: 'pointer',
      background: img ? '#00000008' : c.gradient,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}
  >
    {img
      ? <img src={img} alt={c.labelZh} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
      : <span style={{ fontSize: 30, filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.15))' }}>{c.emoji}</span>}
    <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: '48%', background: 'linear-gradient(to top, rgba(0,0,0,0.52), transparent)', pointerEvents: 'none' }} />
    <span style={{ position: 'absolute', left: 9, bottom: 8, fontSize: 12, fontWeight: 600, color: '#fff', letterSpacing: '0.01em', textShadow: '0 1px 3px rgba(0,0,0,0.35)' }}>
      {zh ? c.labelZh : c.labelEn}
    </span>
  </button>
);

/* 一条 marquee 行: 内容复制两份, translateX -50% 无缝循环. reverse=反方向. */
const RailRow: React.FC<{ items: ShowcaseCategory[]; showcase: Record<string, string>; zh: boolean; reverse?: boolean; duration: number }> = ({ items, showcase, zh, reverse, duration }) => (
  <div className="neox-insp-row" style={{ overflow: 'hidden', maskImage: 'linear-gradient(to right, transparent, #000 7%, #000 93%, transparent)', WebkitMaskImage: 'linear-gradient(to right, transparent, #000 7%, #000 93%, transparent)' }}>
    <div
      className="neox-insp-track"
      style={{ display: 'flex', gap: 10, width: 'max-content', animation: `neox-insp-scroll ${duration}s linear infinite`, animationDirection: reverse ? 'reverse' : 'normal' }}
    >
      {[...items, ...items].map((c, i) => (
        <RailCard key={`${c.key}-${i}`} c={c} img={showcase[c.key]} zh={zh} />
      ))}
    </div>
  </div>
);

export const ImageInspirationRail: React.FC<Props> = ({ zh = defaultIsZh() }) => {
  const [showcase, setShowcase] = useState<Record<string, string>>({});
  useEffect(() => {
    let alive = true;
    const api = (window as unknown as { neox?: { imageShowcase?: () => Promise<Record<string, string>> } }).neox;
    if (api?.imageShowcase) {
      void api.imageShowcase().then((m) => { if (alive && m) setShowcase(m); }).catch(() => { /* noop */ });
    }
    return () => { alive = false; };
  }, []);

  return (
    <div className="neox-insp-rail" style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 10, justifyContent: 'center', minHeight: 0 }}>
      <style>{`
        @keyframes neox-insp-scroll { from { transform: translateX(0); } to { transform: translateX(-50%); } }
        .neox-insp-rail:hover .neox-insp-track { animation-play-state: paused; }
        .neox-insp-card { transition: transform .16s ease; }
        .neox-insp-card:hover { transform: translateY(-3px) scale(1.03); z-index: 2; }
      `}</style>
      <div style={{ fontSize: 12, color: 'var(--neox-fg-secondary, #9ca3af)', textAlign: 'center' }}>
        {zh ? '试试这些方向 · 点一下自动填入描述' : 'Try a direction — click to prefill'}
      </div>
      <RailRow items={CATEGORIES} showcase={showcase} zh={zh} duration={64} />
    </div>
  );
};

export default ImageInspirationRail;
