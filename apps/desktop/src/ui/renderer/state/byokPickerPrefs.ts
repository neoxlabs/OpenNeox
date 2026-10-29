import { useEffect, useState } from 'react';

/**
 * byokPickerPrefs — BYOK provider 是否显示到模型选择器的 BYOK 菜单.
 *
 *   产品定义:
 *     · 新增 BYOK 服务商时表单默认开启显示; 老数据 / 未写入 key 也按显示处理
 *     · 用户在 设置 / API 服务商 卡片或编辑弹窗切换 "显示到 BYOK 菜单" 才会进 picker
 *     · 选择不影响 BYOK provider 本身的存在 — 配置照常, 仅控制 BYOK 菜单露出
 *
 *   存储: localStorage key `neox.byok.pin-in-picker:<providerId>` = '1' / '0' / 不存在
 *     · 不存在 = 默认显示, 避免老 BYOK provider 升级后在模型选择器里突然消失
 *     · '0' = 用户显式隐藏
 *
 *   订阅: 监听 storage 事件 + 自定义 'neox-byok-prefs-changed' 事件让 ModelPicker re-render.
 */

const KEY_PREFIX = 'neox.byok.pin-in-picker:';
const VALUE_SHOWN = '1';
const VALUE_HIDDEN = '0';

export function isByokPinned(providerId: string): boolean {
  if (typeof localStorage === 'undefined') return true;
  return localStorage.getItem(KEY_PREFIX + providerId) !== VALUE_HIDDEN;
}

export function setByokPinned(providerId: string, pinned: boolean): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(KEY_PREFIX + providerId, pinned ? VALUE_SHOWN : VALUE_HIDDEN);
  notifyByokPrefsChanged();
}

export function clearByokPinned(providerId: string): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(KEY_PREFIX + providerId);
  notifyByokPrefsChanged();
}

const MODELS_KEY_PREFIX = 'neox.byok.hidden-models:';

export function getByokHiddenModels(providerId: string): Set<string> {
  if (typeof localStorage === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(MODELS_KEY_PREFIX + providerId);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

export function setByokModelShown(providerId: string, modelName: string, shown: boolean): void {
  if (typeof localStorage === 'undefined') return;
  const cur = getByokHiddenModels(providerId);
  if (shown) cur.delete(modelName); else cur.add(modelName);
  try {
    if (cur.size === 0) localStorage.removeItem(MODELS_KEY_PREFIX + providerId);
    else localStorage.setItem(MODELS_KEY_PREFIX + providerId, JSON.stringify([...cur]));
  } catch { /* ignore */ }
  notifyByokPrefsChanged();
}

function notifyByokPrefsChanged(): void {
  /* 让所有听这个事件的 picker 重新渲染 */
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('neox-byok-prefs-changed'));
  }
}

/** React hook — 订阅一个 provider 的 pin 状态变化. 任何改动会触发组件重渲染. */
export function useByokPinned(providerId: string): boolean {
  const [pinned, setPinned] = useState<boolean>(() => isByokPinned(providerId));
  useEffect(() => {
    const onChange = () => setPinned(isByokPinned(providerId));
    window.addEventListener('neox-byok-prefs-changed', onChange);
    window.addEventListener('storage', onChange);
    return () => {
      window.removeEventListener('neox-byok-prefs-changed', onChange);
      window.removeEventListener('storage', onChange);
    };
  }, [providerId]);
  return pinned;
}

/** 兼容旧调用方: 只返回显式写入 '1' 的 providerId; 默认显示场景请直接用 isByokPinned 判定. */
export function useByokPinnedSet(): Set<string> {
  const tick = useByokPickerPrefsVersion();
  void tick;
  const set = new Set<string>();
  if (typeof localStorage !== 'undefined') {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(KEY_PREFIX)) continue;
      if (localStorage.getItem(k) === VALUE_SHOWN) {
        set.add(k.slice(KEY_PREFIX.length));
      }
    }
  }
  return set;
}

/** Hook — 只用于订阅 BYOK picker 偏好变化; 默认显示语义下, 具体 provider 仍用 isByokPinned 判定. */
export function useByokPickerPrefsVersion(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick(t => t + 1);
    window.addEventListener('neox-byok-prefs-changed', bump);
    window.addEventListener('storage', bump);
    return () => {
      window.removeEventListener('neox-byok-prefs-changed', bump);
      window.removeEventListener('storage', bump);
    };
  }, []);
  return tick;
}
