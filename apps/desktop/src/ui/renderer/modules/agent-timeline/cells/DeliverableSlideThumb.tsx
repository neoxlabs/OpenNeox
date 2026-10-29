import React, { useEffect, useRef, useState } from 'react';
import { parsePptx, SlideView, type PresentationModel } from '../../surface/pptxEngine';

const cache = new Map<string, Promise<PresentationModel | null>>();

function load(path: string): Promise<PresentationModel | null> {
  let p = cache.get(path);
  if (!p) {
    p = (async () => {
      try {
        const r = await (window as any).neox?.surfaceReadFile?.(path, { encoding: 'base64' });
        const b64 = typeof r === 'string' ? r : r?.success === false ? '' : (r?.content ?? '');
        if (!b64) return null;
        const bin = atob(b64);
        const buf = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
        const pres = await parsePptx(buf.buffer);
        return pres.slides.length ? pres : null;
      } catch { return null; }
    })();
    cache.set(path, p);
  }
  return p;
}

export const DeliverableSlideThumb: React.FC<{ path: string; fallback: string }> = ({ path, fallback }) => {
  const [pres, setPres] = useState<PresentationModel | null | undefined>(undefined);
  const box = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState(162);
  useEffect(() => {
    let alive = true;
    void load(path).then((p) => { if (alive) setPres(p); });
    return () => { alive = false; };
  }, [path]);
  useEffect(() => {
    const el = box.current;
    if (el) setWidth(Math.round(el.getBoundingClientRect().width) || 162);
  }, [pres]);
  if (!pres) return <img src={fallback} alt="" draggable={false} style={pres === undefined ? { opacity: 0.5 } : undefined} />;
  return (
    <span ref={box} className="atl-deliverable__slide">
      <SlideView slide={pres.slides[0]!} presentation={pres} containerWidth={width} thumbnail />
    </span>
  );
};

export default DeliverableSlideThumb;
