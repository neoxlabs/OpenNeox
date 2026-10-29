import { useEffect, useState } from 'react';

export const SURFACE_MAIN_MIN = 480;
export const SURFACE_SPLIT_MIN = 320;

/** 侧栏没拖过时的默认宽, 跟 shell.css `clamp(280px, available / 5, 480px)` 一致 */
export function defaultSidebarWidth(available: number): number {
  return Math.max(280, Math.min(480, available / 5));
}

export function surfaceFitsBeside(viewportW: number, sidebarW: number | null, sidebarCollapsed: boolean): boolean {
  const side = sidebarCollapsed ? 0 : (sidebarW ?? defaultSidebarWidth(viewportW));
  return viewportW - side - SURFACE_MAIN_MIN >= SURFACE_SPLIT_MIN;
}

function useViewportWidth(): number {
  const [w, setW] = useState(() => (typeof window === 'undefined' ? 1920 : window.innerWidth));
  useEffect(() => {
    let raf = 0;
    const on = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; setW(window.innerWidth); });
    };
    window.addEventListener('resize', on, { passive: true });
    return () => { window.removeEventListener('resize', on); if (raf) cancelAnimationFrame(raf); };
  }, []);
  return w;
}

/** 并排版面放不下画布时返回 true —— 调用方这一次不显示画布 */
export function useSurfaceAutoFloat(sideBySide: boolean, sidebarW: number | null, sidebarCollapsed: boolean): boolean {
  const vw = useViewportWidth();
  return sideBySide && !surfaceFitsBeside(vw, sidebarW, sidebarCollapsed);
}
