import React, { useCallback, useEffect, useRef } from 'react';

export interface FloatGeom { x: number; y: number; w: number; h: number }

const KEY = 'neox:surfaceFloat';
const MIN_W = 360;
const MIN_H = 260;
const EDGE = 8;

function defaultGeom(): FloatGeom {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const w = Math.round(Math.min(720, W * 0.46));
  const h = Math.round(Math.min(560, H * 0.7));
  return { x: W - w - 24, y: 64, w, h };
}

/** 窗口变小时把浮层拉回可见区, 至少露出拖动条 */
export function clampGeom(g: FloatGeom): FloatGeom {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const w = Math.max(MIN_W, Math.min(g.w, W - EDGE * 2));
  const h = Math.max(MIN_H, Math.min(g.h, H - EDGE * 2));
  const x = Math.max(EDGE, Math.min(g.x, W - w - EDGE));
  const y = Math.max(EDGE, Math.min(g.y, H - 48));
  return { x, y, w, h };
}

export function readFloatGeom(): FloatGeom {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (v && [v.x, v.y, v.w, v.h].every((n: unknown) => typeof n === 'number' && Number.isFinite(n))) return clampGeom(v);
  } catch { /* 存档坏了用默认 */ }
  return clampGeom(defaultGeom());
}

function apply(root: HTMLElement, g: FloatGeom) {
  root.style.setProperty('--sfc-float-x', `${g.x}px`);
  root.style.setProperty('--sfc-float-y', `${g.y}px`);
  root.style.setProperty('--sfc-float-w', `${g.w}px`);
  root.style.setProperty('--sfc-float-h', `${g.h}px`);
}

export const SurfaceFloatFrame: React.FC<{ rootRef: React.RefObject<HTMLDivElement | null>; zh: boolean }> = ({ rootRef, zh }) => {
  const geom = useRef<FloatGeom>(readFloatGeom());

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    apply(root, geom.current);
    const onResize = () => { geom.current = clampGeom(geom.current); apply(root, geom.current); };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      for (const k of ['x', 'y', 'w', 'h']) root.style.removeProperty(`--sfc-float-${k}`);
    };
  }, [rootRef]);

  const startDrag = useCallback((mode: 'move' | 'resize') => (e: React.PointerEvent) => {
    const root = rootRef.current;
    if (!root || e.button !== 0) return;
    e.preventDefault();
    const start = { px: e.clientX, py: e.clientY, ...geom.current };
    root.classList.add('is-surface-dragging');
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - start.px;
      const dy = ev.clientY - start.py;
      geom.current = clampGeom(mode === 'move'
        ? { ...start, x: start.x + dx, y: start.y + dy }
        : { ...start, w: start.w + dx, h: start.h + dy });
      apply(root, geom.current);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      root.classList.remove('is-surface-dragging');
      try { localStorage.setItem(KEY, JSON.stringify(geom.current)); } catch { /* 存不下只是不记住 */ }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [rootRef]);

  return (
    <>
      <div
        className="sfc-float__grip"
        onPointerDown={startDrag('move')}
        onDoubleClick={() => { const r = rootRef.current; if (!r) return; geom.current = clampGeom(defaultGeom()); apply(r, geom.current); try { localStorage.removeItem(KEY); } catch { /* ignore */ } }}
        title={zh ? '拖动 · 双击回到默认位置' : 'Drag · double-click to reset'}
        role="separator"
        aria-label={zh ? '拖动 Surface' : 'Move Surface'}
      >
        <span className="sfc-float__grip-bar" />
      </div>
      <div className="sfc-float__resize" onPointerDown={startDrag('resize')} title={zh ? '拉伸' : 'Resize'} aria-hidden="true" />
    </>
  );
};

export default SurfaceFloatFrame;
