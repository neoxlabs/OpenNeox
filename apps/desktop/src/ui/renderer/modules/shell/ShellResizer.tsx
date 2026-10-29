import React, { useCallback, useEffect, useRef } from 'react';
import { getGlobalLanguage } from '../../hooks/useI18n';


/* key bump 到 v4 — Agent surface 默认从 min(560px,40vw) 改回跟 timeline 1:1 平分.
 * v3 期间若用户拖过 / 或机器上残留了偏窄的 right 值, 会继续压住新的 1:1 default.
 * v4 重置一次, 没拖过就吃 CSS calc; 用户再拖才重新持久化. */
export const RESIZER_STORAGE_KEY_SIDEBAR = 'neox-shell-sidebar-width-v4';
export const RESIZER_STORAGE_KEY_RIGHT = 'neox-shell-rightpanel-width-v4';

/* 约束 — 下限防止过窄 (sidebar 标题截光 / surface 画布无法看). 上限放宽给大屏:
 *   1:2:2 默认比例下, 3600px 屏 sidebar 720 / right 1440 都属合理, 之前 480/1200 太死.
 *   实际由 .neox-shell-available 计算的 CSS calc 不被这些 JS 约束限制 — 这里只在用户主动拖时生效. */
const SIDEBAR_MIN = 240;
const SIDEBAR_MAX = 800;
const RIGHT_MIN = 320;
const RIGHT_MAX = 2000;

/* main 列的"舒适最低宽" — composer modes 胶囊 + quota + 输入框 + tools + model chip + send
 *   都要塞下的最低值. */
const MAIN_COMFORT_MIN = 480;
/* rail 列宽 — 跟 --neox-rail-width design token 同步, 这里硬编码避免 getComputedStyle 调用.
 *   token 改了同步改这里. */
const RAIL_WIDTH = 48;

function readRailWidthPx(): number {
  if (typeof document === 'undefined') return RAIL_WIDTH;
  const shell = document.querySelector('.neox-shell');
  if (!(shell instanceof HTMLElement)) return RAIL_WIDTH;
  const raw = getComputedStyle(shell).getPropertyValue('--neox-rail-width').trim();
  const px = Number.parseFloat(raw);
  return Number.isFinite(px) ? px : RAIL_WIDTH;
}

/* 拖右 splitter 时, right 列的动态上限. 受 viewport + sidebar 占用影响 — 拖到 main 只剩
 *   当前模式的 main 舒适最低宽时就拖不动了, 不会把 main 进一步压到溢出 viewport. */
export function computeRightMaxForViewport(sidebarWidth: number): number {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1920;
  const cap = vw - readRailWidthPx() - sidebarWidth - MAIN_COMFORT_MIN;
  return Math.max(RIGHT_MIN, Math.min(RIGHT_MAX, cap));
}

/* 拖左 splitter (sidebar) 时, sidebar 列的动态上限. 同理保证 main ≥ 当前模式最低宽. */
export function computeSidebarMaxForViewport(rightWidth: number): number {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1920;
  const cap = vw - readRailWidthPx() - rightWidth - MAIN_COMFORT_MIN;
  return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, cap));
}

export function readSidebarWidth(): number | null {
  try {
    const raw = window.localStorage.getItem(RESIZER_STORAGE_KEY_SIDEBAR);
    if (!raw) return null;
    const v = Number(raw);
    return Number.isFinite(v) && v >= SIDEBAR_MIN && v <= SIDEBAR_MAX ? v : null;
  } catch { return null; }
}
export function readRightWidth(): number | null {
  try {
    const raw = window.localStorage.getItem(RESIZER_STORAGE_KEY_RIGHT);
    if (!raw) return null;
    const v = Number(raw);
    return Number.isFinite(v) && v >= RIGHT_MIN && v <= RIGHT_MAX ? v : null;
  } catch { return null; }
}

interface ResizerProps {
  side: 'sidebar' | 'right';
  /** 当前列宽 — 拖动起点; 拖动过程通过 onChange 实时回传 */
  width: number;
  onChange: (next: number) => void;
  /** 动态上限计算 — 拖动每一帧调用, 返回当前允许的最大列宽. 用于保证 main ≥ MAIN_COMFORT_MIN.
   *   不传时走 SIDEBAR_MAX / RIGHT_MAX 静态上限. */
  getDynamicMax?: () => number;
  inverted?: boolean;
}

export const ShellResizer: React.FC<ResizerProps> = ({ side, width, onChange, getDynamicMax, inverted = false }) => {
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  const min = side === 'sidebar' ? SIDEBAR_MIN : RIGHT_MIN;
  const staticMax = side === 'sidebar' ? SIDEBAR_MAX : RIGHT_MAX;

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    /* 从 DOM 读真实宽度, 不用 prop (prop 可能是默认值, 跟 CSS clamp 算出的实际宽度不一致) */
    const shell = document.querySelector('.neox-shell');
    let actualW = width;
    if (shell) {
      const target = side === 'sidebar'
        ? shell.querySelector('.neox-shell__sidebar')
        : shell.querySelector('.neox-shell__right');
      if (target) actualW = target.getBoundingClientRect().width;
    }
    dragRef.current = { startX: e.clientX, startW: actualW };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    shell?.classList.add('is-resizing');
  }, [width, side]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    /* 最小拖动阈值 3px — 防止点击误触 onChange */
    if (Math.abs(dx) < 3) return;
    const delta = side === 'sidebar' || inverted ? dx : -dx;
    const effectiveMax = getDynamicMax ? Math.min(staticMax, getDynamicMax()) : staticMax;
    const next = Math.max(min, Math.min(effectiveMax, d.startW + delta));
    onChange(next);
  }, [side, inverted, min, staticMax, getDynamicMax, onChange]);

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    document.querySelector('.neox-shell')?.classList.remove('is-resizing');
    /* 持久化最终值 */
    try {
      const key = side === 'sidebar' ? RESIZER_STORAGE_KEY_SIDEBAR : RESIZER_STORAGE_KEY_RIGHT;
      window.localStorage.setItem(key, String(width));
    } catch { /* ignore */ }
  }, [side, width]);

  const isZh = getGlobalLanguage() === 'zh';
  return (
    <div
      className={`neox-shell__resizer neox-shell__resizer--${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={side === 'sidebar'
        ? (isZh ? '调整侧栏宽度' : 'Resize sidebar')
        : (isZh ? '调整右栏宽度' : 'Resize right panel')}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    />
  );
};

/* 双击重置当前列宽 — UX: 拖飞了一键回默认.
 * 暂未挂到 UI, 但导出常量给上层 reset 用. */
/* JS 这边的 SIDEBAR_DEFAULT 只在 ResizeObserver / NeoxShell 拿不到 CSS clamp 计算值时
 *   用作"拖动起点". 用 360 (clamp 中位 ≈ 1440 屏的计算值), 即使真实 CSS 值不同, 用户
 *   拖动后会立刻 align 到鼠标位置, 起点偏差不影响最终结果. */
export const SIDEBAR_DEFAULT = 360;
export const RIGHT_DEFAULT_VAR_FALLBACK = 600;  /* 当 localStorage 没记录时, 走 CSS var 的 clamp(420,50vw,900); 这里只用于 JS 初始 state */

export default ShellResizer;
