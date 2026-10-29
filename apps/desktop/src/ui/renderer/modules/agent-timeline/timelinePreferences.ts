import { useEffect, useState } from 'react';
import type { TimelineDensity } from './types';

const TIMELINE_DENSITY_KEY = 'neox.timeline.density';
const TIMELINE_DENSITY_EVENT = 'neox:timeline-density-change';

function normalizeTimelineDensity(value: unknown): TimelineDensity {
  return value === 'minimal' || value === 'debug' || value === 'normal'
    ? value
    : 'normal';
}

export function getTimelineDensityPreference(): TimelineDensity {
  if (typeof window === 'undefined') return 'normal';
  try {
    return normalizeTimelineDensity(window.localStorage.getItem(TIMELINE_DENSITY_KEY));
  } catch {
    return 'normal';
  }
}

export function setTimelineDensityPreference(density: TimelineDensity): void {
  const next = normalizeTimelineDensity(density);
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(TIMELINE_DENSITY_KEY, next);
    } catch {
      /* ignore per-device preference write failures */
    }
    window.dispatchEvent(new CustomEvent(TIMELINE_DENSITY_EVENT, { detail: { density: next } }));
  }
}

export function useTimelineDensityPreference(): [TimelineDensity, (density: TimelineDensity) => void] {
  const [density, setDensity] = useState<TimelineDensity>(() => getTimelineDensityPreference());

  useEffect(() => {
    const sync = () => setDensity(getTimelineDensityPreference());
    const onDensityChange = (event: Event) => {
      const next = (event as CustomEvent<{ density?: TimelineDensity }>).detail?.density;
      setDensity(normalizeTimelineDensity(next ?? getTimelineDensityPreference()));
    };
    window.addEventListener('storage', sync);
    window.addEventListener(TIMELINE_DENSITY_EVENT, onDensityChange);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener(TIMELINE_DENSITY_EVENT, onDensityChange);
    };
  }, []);

  return [density, setTimelineDensityPreference];
}

const TIMELINE_FONT_SCALE_KEY = 'neox.timeline.fontScale';
const TIMELINE_FONT_SCALE_EVENT = 'neox:timeline-font-scale-change';

export const TIMELINE_FONT_SCALE_MIN = 0.9;
export const TIMELINE_FONT_SCALE_MAX = 1.5;
export const TIMELINE_FONT_SCALE_DEFAULT = 1.1;

/** 设置页四档 — 值必须落在 [MIN, MAX] 内 */
export const TIMELINE_FONT_SCALE_STEPS = [0.95, 1.1, 1.25, 1.4] as const;

function normalizeFontScale(value: unknown): number {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
  if (!Number.isFinite(n)) return TIMELINE_FONT_SCALE_DEFAULT;
  /* 量化到 0.01 —— 避免 1.2000000000000002 这种浮点尾巴写进 localStorage / CSS */
  const clamped = Math.min(TIMELINE_FONT_SCALE_MAX, Math.max(TIMELINE_FONT_SCALE_MIN, n));
  return Math.round(clamped * 100) / 100;
}

export function getTimelineFontScalePreference(): number {
  if (typeof window === 'undefined') return TIMELINE_FONT_SCALE_DEFAULT;
  try {
    const saved = window.localStorage.getItem(TIMELINE_FONT_SCALE_KEY);
    if (saved == null) return TIMELINE_FONT_SCALE_DEFAULT;
    return normalizeFontScale(saved);
  } catch {
    return TIMELINE_FONT_SCALE_DEFAULT;
  }
}

export function setTimelineFontScalePreference(scale: number): void {
  const next = normalizeFontScale(scale);
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(TIMELINE_FONT_SCALE_KEY, String(next));
  } catch {
    /* ignore per-device preference write failures */
  }
  window.dispatchEvent(new CustomEvent(TIMELINE_FONT_SCALE_EVENT, { detail: { scale: next } }));
}

export function useTimelineFontScalePreference(): [number, (scale: number) => void] {
  const [scale, setScale] = useState<number>(() => getTimelineFontScalePreference());

  useEffect(() => {
    const sync = () => setScale(getTimelineFontScalePreference());
    const onChange = (event: Event) => {
      const next = (event as CustomEvent<{ scale?: number }>).detail?.scale;
      setScale(typeof next === 'number' ? normalizeFontScale(next) : getTimelineFontScalePreference());
    };
    window.addEventListener('storage', sync);
    window.addEventListener(TIMELINE_FONT_SCALE_EVENT, onChange);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener(TIMELINE_FONT_SCALE_EVENT, onChange);
    };
  }, []);

  return [scale, setTimelineFontScalePreference];
}

const TIMELINE_LINE_HEIGHT_KEY = 'neox.timeline.lineHeightScale';
const TIMELINE_LINE_HEIGHT_EVENT = 'neox:timeline-line-height-change';

export const TIMELINE_LINE_HEIGHT_MIN = 0.85;
export const TIMELINE_LINE_HEIGHT_MAX = 1.35;
export const TIMELINE_LINE_HEIGHT_DEFAULT = 1;

/** 设置页三档 — 值必须落在 [MIN, MAX] 内。默认 1 = 保持现有观感不变。 */
export const TIMELINE_LINE_HEIGHT_STEPS = [0.9, 1, 1.15] as const;

function normalizeLineHeight(value: unknown): number {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
  if (!Number.isFinite(n)) return TIMELINE_LINE_HEIGHT_DEFAULT;
  const clamped = Math.min(TIMELINE_LINE_HEIGHT_MAX, Math.max(TIMELINE_LINE_HEIGHT_MIN, n));
  return Math.round(clamped * 100) / 100;
}

export function getTimelineLineHeightPreference(): number {
  if (typeof window === 'undefined') return TIMELINE_LINE_HEIGHT_DEFAULT;
  try {
    const saved = window.localStorage.getItem(TIMELINE_LINE_HEIGHT_KEY);
    if (saved == null) return TIMELINE_LINE_HEIGHT_DEFAULT;
    return normalizeLineHeight(saved);
  } catch {
    return TIMELINE_LINE_HEIGHT_DEFAULT;
  }
}

export function setTimelineLineHeightPreference(scale: number): void {
  const next = normalizeLineHeight(scale);
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(TIMELINE_LINE_HEIGHT_KEY, String(next));
  } catch {
    /* ignore per-device preference write failures */
  }
  window.dispatchEvent(new CustomEvent(TIMELINE_LINE_HEIGHT_EVENT, { detail: { scale: next } }));
}

export function useTimelineLineHeightPreference(): [number, (scale: number) => void] {
  const [scale, setScale] = useState<number>(() => getTimelineLineHeightPreference());

  useEffect(() => {
    const sync = () => setScale(getTimelineLineHeightPreference());
    const onChange = (event: Event) => {
      const next = (event as CustomEvent<{ scale?: number }>).detail?.scale;
      setScale(typeof next === 'number' ? normalizeLineHeight(next) : getTimelineLineHeightPreference());
    };
    window.addEventListener('storage', sync);
    window.addEventListener(TIMELINE_LINE_HEIGHT_EVENT, onChange);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener(TIMELINE_LINE_HEIGHT_EVENT, onChange);
    };
  }, []);

  return [scale, setTimelineLineHeightPreference];
}

export type ComposerStyle = 'standard' | 'minimal';

const COMPOSER_STYLE_KEY = 'neox.composer.style';
const COMPOSER_STYLE_EVENT = 'neox:composer-style-change';

/* 只有显式存了 'standard' 才是标准形态; 没存过 (新装) / 存了别的值一律简约。 */
function normalizeComposerStyle(value: unknown): ComposerStyle {
  return value === 'standard' ? 'standard' : 'minimal';
}

export function getComposerStylePreference(): ComposerStyle {
  if (typeof window === 'undefined') return 'minimal';
  try {
    return normalizeComposerStyle(window.localStorage.getItem(COMPOSER_STYLE_KEY));
  } catch {
    return 'minimal';
  }
}

export function setComposerStylePreference(style: ComposerStyle): void {
  const next = normalizeComposerStyle(style);
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(COMPOSER_STYLE_KEY, next);
  } catch { /* ignore per-device preference write failures */ }
  window.dispatchEvent(new CustomEvent(COMPOSER_STYLE_EVENT, { detail: { style: next } }));
}

export function useComposerStylePreference(): [ComposerStyle, (style: ComposerStyle) => void] {
  const [style, setStyle] = useState<ComposerStyle>(() => getComposerStylePreference());

  useEffect(() => {
    const sync = () => setStyle(getComposerStylePreference());
    const onChange = (event: Event) => {
      const next = (event as CustomEvent<{ style?: ComposerStyle }>).detail?.style;
      setStyle(next ? normalizeComposerStyle(next) : getComposerStylePreference());
    };
    window.addEventListener('storage', sync);
    window.addEventListener(COMPOSER_STYLE_EVENT, onChange);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener(COMPOSER_STYLE_EVENT, onChange);
    };
  }, []);

  return [style, setComposerStylePreference];
}

const SHOW_REASONING_KEY = 'neox.showReasoning';
const SHOW_REASONING_EVENT = 'neox:show-reasoning-change';

export function getShowReasoningPreference(): boolean {
  //   只有显式设 '0' 才隐藏 (保留设置页 toggle 让想要 transcript-only 的人关掉)。
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(SHOW_REASONING_KEY) !== '0';
  } catch {
    return true;
  }
}

export function setShowReasoningPreference(show: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SHOW_REASONING_KEY, show ? '1' : '0');
  } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent(SHOW_REASONING_EVENT, { detail: { show } }));
}

export function useShowReasoningPreference(): [boolean, (show: boolean) => void] {
  const [show, setShow] = useState<boolean>(() => getShowReasoningPreference());

  useEffect(() => {
    const sync = () => setShow(getShowReasoningPreference());
    const onChange = (event: Event) => {
      const next = (event as CustomEvent<{ show?: boolean }>).detail?.show;
      setShow(typeof next === 'boolean' ? next : getShowReasoningPreference());
    };
    window.addEventListener('storage', sync);
    window.addEventListener(SHOW_REASONING_EVENT, onChange);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener(SHOW_REASONING_EVENT, onChange);
    };
  }, []);

  return [show, setShowReasoningPreference];
}


const CTX_RAIL_HIDDEN_KEY = 'neox.timeline.contextRailHidden';
const CTX_RAIL_HIDDEN_EVENT = 'neox:timeline-context-rail-change';

export function getContextRailHidden(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(CTX_RAIL_HIDDEN_KEY) === '1';
  } catch {
    return false;
  }
}

export function setContextRailHidden(hidden: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CTX_RAIL_HIDDEN_KEY, hidden ? '1' : '0');
  } catch {
    /* ignore per-device preference write failures */
  }
  window.dispatchEvent(new CustomEvent(CTX_RAIL_HIDDEN_EVENT, { detail: { hidden } }));
}

export function useContextRailHidden(): [boolean, (hidden: boolean) => void] {
  const [hidden, setHidden] = useState<boolean>(() => getContextRailHidden());
  useEffect(() => {
    const sync = () => setHidden(getContextRailHidden());
    /* storage 事件是给**其他窗口**的; 本窗口靠自定义事件, 两个都听才能多开同步 */
    window.addEventListener(CTX_RAIL_HIDDEN_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(CTX_RAIL_HIDDEN_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  return [hidden, setContextRailHidden];
}
