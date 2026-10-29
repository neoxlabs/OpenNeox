/**
 * useDensity — 高度响应式 density 模式 (Compact / Roomy 双档)
 *
 * 监听 window.innerHeight, 阈值 900px:
 *   - 高度 < 900px → compact (矮窗, 信息密度高, 当前 Neox 视觉)
 *   - 高度 ≥ 900px → roomy (高窗, 元素加 padding + 标题加大 + 中间内容居中)
 *
 * 用户可在 settings 强制 override:
 *   - 'auto' (默认): 跟随窗口高度自动切换
 *   - 'compact': 强制紧凑 (节省屏幕, 适合分屏)
 *   - 'roomy': 强制宽松 (适合大屏沉浸式)
 *
 * 实施: 写入两个 data-* 属性到 <html>:
 *   - data-density: 用户偏好 ('auto' | 'compact' | 'roomy')
 *   - data-density-active: 当前生效模式 ('compact' | 'roomy')
 *
 * CSS 端 (density.css) 用 data-density-active 决定视觉状态.
 * 拆开 preference / active 是为了让 CSS 同时知道两件事 (用户选了啥 + 实际生效啥),
 * 方便未来加 indicator "你当前在 auto 模式, 自动判定为 roomy".
 *
 * 持久化: localStorage 'neox.density.preference', settings page 改时同步.
 */

import { useEffect, useState } from 'react';

export type DensityPreference = 'auto' | 'compact' | 'roomy';
export type DensityActive = 'compact' | 'roomy';

const STORAGE_KEY = 'neox.density.preference';
const ROOMY_BREAKPOINT_PX = 800;

/** 从 localStorage 读用户偏好, 默认 'auto' */
function loadPreference(): DensityPreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'compact' || stored === 'roomy' || stored === 'auto') {
      return stored;
    }
  } catch { /* localStorage 不可用 (incognito 等), fallback */ }
  return 'auto';
}

/** 写入 localStorage */
function savePreference(pref: DensityPreference): void {
  try {
    localStorage.setItem(STORAGE_KEY, pref);
  } catch { /* 静默, 不影响功能 */ }
}

/** 根据 preference + 当前窗口高度计算 active 模式 */
function computeActive(pref: DensityPreference, windowHeight: number): DensityActive {
  if (pref === 'compact') return 'compact';
  if (pref === 'roomy') return 'roomy';
  /* auto: 看窗口高度 */
  return windowHeight >= ROOMY_BREAKPOINT_PX ? 'roomy' : 'compact';
}

/**
 * useDensity — 主 hook
 *
 * 返回当前 preference + active 状态 + setter.
 * 自动同步 <html data-density / data-density-active> 属性,
 * CSS 端用这两个属性触发样式.
 */
export function useDensity(): {
  preference: DensityPreference;
  active: DensityActive;
  setPreference: (pref: DensityPreference) => void;
} {
  const [preference, setPreferenceState] = useState<DensityPreference>(() => loadPreference());
  const [windowHeight, setWindowHeight] = useState<number>(() => {
    if (typeof window === 'undefined') return 800;
    return window.innerHeight;
  });

  /* 监听窗口高度变化 — debounce 100ms 避免 resize 风暴 */
  useEffect(() => {
    if (typeof window === 'undefined') return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const handleResize = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        setWindowHeight(window.innerHeight);
      }, 100);
    };
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      if (timer) clearTimeout(timer);
    };
  }, []);

  const active = computeActive(preference, windowHeight);

  /* 同步到 <html> 属性 — CSS 端读这两个属性 */
  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.setAttribute('data-density', preference);
    document.documentElement.setAttribute('data-density-active', active);
    document.documentElement.removeAttribute('data-density-debug');
    /* 全局变量挂 window — devtools console 可一句 verify: window.__neoxDensity */
    (window as any).__neoxDensity = { preference, active, windowHeight };
  }, [preference, active, windowHeight]);

  const setPreference = (pref: DensityPreference) => {
    setPreferenceState(pref);
    savePreference(pref);
  };

  return { preference, active, setPreference };
}

/**
 * 工具函数: 不用 hook 也能查当前 active (e.g. 非 React 代码 / 一次性查询)
 */
export function getCurrentDensityActive(): DensityActive {
  if (typeof document === 'undefined') return 'compact';
  const attr = document.documentElement.getAttribute('data-density-active');
  return attr === 'roomy' ? 'roomy' : 'compact';
}
