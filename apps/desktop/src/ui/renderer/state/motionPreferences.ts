import { useEffect, useState } from 'react';

export type MotionMode = 'off' | 'standard' | 'silk';

const MOTION_KEY = 'neox.ui.motion';
const MOTION_EVENT = 'neox:motion-change';
const DEFAULT_MOTION: MotionMode = 'silk';
/** 低配机首启默认档。不是 off —— 特效还在, 只是不走 silk 那套高频微交互。 */
const WEAK_MACHINE_MOTION: MotionMode = 'standard';

function normalizeMotion(value: unknown): MotionMode {
  return value === 'off' || value === 'standard' || value === 'silk' ? value : DEFAULT_MOTION;
}

export interface WeakMachineVerdict {
  weak: boolean;
  /** 给人看的一句话原因, 空串 = 没命中 */
  reason: string;
}

let weakVerdictCache: WeakMachineVerdict | null = null;

export function detectWeakMachine(): WeakMachineVerdict {
  if (weakVerdictCache) return weakVerdictCache;
  if (typeof navigator === 'undefined') {
    weakVerdictCache = { weak: false, reason: '' };
    return weakVerdictCache;
  }
  const cores = navigator.hardwareConcurrency || 0;
  const weak = cores > 0 && cores <= 4;
  weakVerdictCache = { weak, reason: weak ? `${cores} 核` : '' };
  return weakVerdictCache;
}

export function getMotionPreference(): MotionMode {
  if (typeof window === 'undefined') return DEFAULT_MOTION;
  try {
    const raw = window.localStorage.getItem(MOTION_KEY);
    /* 没存过 = 新用户, 按机器能力给默认档 (不是 off, 也不是一律 silk) */
    if (raw != null) return normalizeMotion(raw);
    return detectWeakMachine().weak ? WEAK_MACHINE_MOTION : DEFAULT_MOTION;
  } catch {
    return DEFAULT_MOTION;
  }
}

/** 当前生效的档位是不是"机器能力自动定的" (而非用户手选)。设置页用它决定显不显示那行说明。 */
export function isMotionAutoDowngraded(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    /* 用户手选过就不是自动的了 —— 以 MOTION_KEY 存在为准, 比记一个额外标记可靠 */
    if (window.localStorage.getItem(MOTION_KEY) != null) return false;
    return detectWeakMachine().weak;
  } catch {
    return false;
  }
}

/** 把档位写到 <html data-motion>。幂等, 可以随便多调。 */
export function applyMotionPreference(mode: MotionMode = getMotionPreference()): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-motion', normalizeMotion(mode));
  /* data-low-end: 标记「这台机器被自动判为低配」。styles/motion-lite.css 靠它收敛
   * 重复/装饰动画 —— 只在 standard 档生效, 用户手选 silk 就完全让位。
   * 挂在这里而不是单独一个函数, 是因为它跟档位是同一次启动判定, 分开会漏挂。 */
  try {
    document.documentElement.toggleAttribute('data-low-end', detectWeakMachine().weak);
  } catch { /* ignore */ }
}

export function setMotionPreference(mode: MotionMode): void {
  const next = normalizeMotion(mode);
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(MOTION_KEY, next);
  } catch {
    /* per-device 偏好写不进去就算了, 不该因此报错 */
  }
  applyMotionPreference(next);
  window.dispatchEvent(new CustomEvent(MOTION_EVENT, { detail: { motion: next } }));
}

const VIBRANCY_KEY = 'neox.ui.windowVibrancy';
const VIBRANCY_EVENT = 'neox:window-vibrancy-change';

export function getWindowVibrancy(): boolean {
  void VIBRANCY_KEY;
  return false;
}

/** 把偏好推给 main 进程。幂等; 非 macOS 上 main 侧直接返回 false。 */
export function applyWindowVibrancy(enabled: boolean = getWindowVibrancy()): void {
  const api = (window as any)?.neox;
  if (!api?.setWindowVibrancy) return;
  /* 关掉时给一个实色兜底 —— 只摘 vibrancy 会留下一个透明窗, 比开着还糟:
     既没有模糊, 又还走非不透明合成路径。取当前画布色最保险。 */
  const opaqueColor = (() => {
    try {
      const bg = getComputedStyle(document.body).backgroundColor;
      return bg && bg !== 'rgba(0, 0, 0, 0)' ? bg : undefined;
    } catch { return undefined; }
  })();
  void api.setWindowVibrancy({ enabled, opaqueColor }).catch(() => { /* 老版本 preload 没这个方法 */ });
  try {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-window-glass', enabled ? 'on' : 'off');
    }
  } catch { /* ignore */ }
}

export function setWindowVibrancy(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(VIBRANCY_KEY, enabled ? 'on' : 'off'); } catch { /* ignore */ }
  applyWindowVibrancy(enabled);
  window.dispatchEvent(new CustomEvent(VIBRANCY_EVENT, { detail: { enabled } }));
}

export function useWindowVibrancy(): [boolean, (v: boolean) => void] {
  const [on, setOn] = useState<boolean>(() => getWindowVibrancy());
  useEffect(() => {
    const sync = () => setOn(getWindowVibrancy());
    window.addEventListener(VIBRANCY_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(VIBRANCY_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  return [on, setWindowVibrancy];
}

export function useMotionPreference(): [MotionMode, (mode: MotionMode) => void] {
  const [motion, setMotion] = useState<MotionMode>(() => getMotionPreference());
  useEffect(() => {
    const sync = () => setMotion(getMotionPreference());
    window.addEventListener(MOTION_EVENT, sync);
    /* 多窗口: 另一个窗口改了偏好这边跟着变 */
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(MOTION_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  return [motion, setMotionPreference];
}
