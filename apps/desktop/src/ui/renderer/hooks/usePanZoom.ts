import { useCallback, useEffect, useRef, useState } from 'react';

export interface PanZoom {
  scale: number;
  x: number;
  y: number;
}

const MIN = 0.5;
const MAX = 8;
const clamp = (s: number) => Math.max(MIN, Math.min(MAX, s));

/** 以屏幕点 (相对元素中心的偏移 px, py) 为不动点缩放到 next */
export function zoomAbout(v: PanZoom, next: number, px: number, py: number): PanZoom {
  const s = clamp(next);
  const k = s / v.scale;
  return { scale: s, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
}

export function usePanZoom<T extends HTMLElement>(resetKey?: unknown) {
  const ref = useRef<T | null>(null);
  const [view, setView] = useState<PanZoom>({ scale: 1, x: 0, y: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  /* 拖拽过就吞掉紧跟着的 click (不然松手那下会被当成「点遮罩关闭」) */
  const draggedRef = useRef(false);

  useEffect(() => { setView({ scale: 1, x: 0, y: 0 }); }, [resetKey]);

  /* 元素中心在屏幕上的位置: 未变换的布局框中心 = 当前框中心 - 平移 */
  const centerOf = useCallback((el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const v = viewRef.current;
    return { cx: r.left + r.width / 2 - v.x, cy: r.top + r.height / 2 - v.y };
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const host = el.parentElement ?? el;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const { cx, cy } = centerOf(el);
        /* 跟右栏看图 (ImageSurfaceViewer) 同一档灵敏度; 单次幅度封顶 —— ctrl+鼠标滚轮一格 deltaY≈100,
         * 不封顶一格就跳三倍 */
        const d = Math.max(-40, Math.min(40, e.deltaY));
        setView((v) => zoomAbout(v, v.scale * Math.exp(-d * 0.006), e.clientX - cx, e.clientY - cy));
        return;
      }
      if (viewRef.current.scale > 1.001) {
        e.preventDefault();
        setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
      }
    };
    host.addEventListener('wheel', onWheel, { passive: false });
    return () => host.removeEventListener('wheel', onWheel);
  }, [centerOf]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0 || viewRef.current.scale <= 1.001) return;
    const start = { px: e.clientX, py: e.clientY, x: viewRef.current.x, y: viewRef.current.y };
    draggedRef.current = false;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - start.px;
      const dy = ev.clientY - start.py;
      if (Math.abs(dx) + Math.abs(dy) > 3) draggedRef.current = true;
      setView((v) => ({ ...v, x: start.x + dx, y: start.y + dy }));
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  }, []);

  const onDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const el = ref.current;
    if (!el) return;
    if (viewRef.current.scale > 1.001) { setView({ scale: 1, x: 0, y: 0 }); return; }
    const { cx, cy } = centerOf(el);
    setView((v) => zoomAbout(v, 2, e.clientX - cx, e.clientY - cy));
  }, [centerOf]);

  const zoomBy = useCallback((factor: number) => setView((v) => zoomAbout(v, v.scale * factor, 0, 0)), []);
  const reset = useCallback(() => setView({ scale: 1, x: 0, y: 0 }), []);

  const consumeDrag = useCallback(() => {
    const d = draggedRef.current;
    draggedRef.current = false;
    return d;
  }, []);

  return { ref, view, onPointerDown, onDoubleClick, zoomBy, reset, consumeDrag };
}
