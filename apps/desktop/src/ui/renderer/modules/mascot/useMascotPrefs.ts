/**
 * 角色的显示偏好 —— 藏没藏、是哪一只。
 *
 * 放 localStorage 而不是走后端设置: 这是"看着顺不顺眼"级别的个人偏好, 不需要跨设备
 * 同步, 也不值得为它加一条 IPC 和一张表。读不到就回落默认 (不显示 / 猫), 所以隐身窗口、
 * 清过站点数据、首次启动这些情况都不会出问题。
 *
 * 用事件广播而不是 Context: 角色在首屏和对话态是**两个不同的挂载点** (跟输入框一样,
 * 两态各有各的 DOM), 右键菜单在哪个上面点的, 另一个也得跟着变。为一个开关套一层
 * Provider 不划算, 一个 storage key 加一个自定义事件就够。
 */
import { useCallback, useEffect, useState } from 'react';

export type MascotSpecies = 'cat' | 'corgi';

const KEY_HIDDEN = 'neox.mascot.hidden';
const KEY_SPECIES = 'neox.mascot.species';
const KEY_STAY_PUT = 'neox.mascot.stayPut';
const CHANGED = 'neox:mascot:prefs';
const volatilePrefs = new Map<string, string>();

export interface MascotPrefs {
  hidden: boolean;
  species: MascotSpecies;
  /** 不跟着输入走动, 一直趴在角落。 */
  stayPut: boolean;
}

function read(): MascotPrefs {
  const get = (key: string) => {
    if (volatilePrefs.has(key)) return volatilePrefs.get(key);
    try { return localStorage.getItem(key); } catch { return null; }
  };
  try {
    const sp = get(KEY_SPECIES);
    const h = get(KEY_HIDDEN);
    return {
      hidden: h !== '0',
      species: sp === 'corgi' ? 'corgi' : 'cat',
      stayPut: get(KEY_STAY_PUT) === '1',
    };
  } catch {
    /* 隐身窗口 / 站点数据被禁时 localStorage 会直接抛, 不能让它把角色一起带走。 */
    return { hidden: true, species: 'cat', stayPut: false };
  }
}

export function useMascotPrefs(): MascotPrefs & {
  setHidden: (v: boolean) => void;
  setSpecies: (v: MascotSpecies) => void;
  setStayPut: (v: boolean) => void;
} {
  const [prefs, setPrefs] = useState<MascotPrefs>(read);

  useEffect(() => {
    const sync = () => setPrefs(read());
    const onStorage = (event: StorageEvent) => {
      try {
        if (event.storageArea !== window.localStorage) return;
      } catch { return; }
      if (event.key === null) volatilePrefs.clear();
      else if (event.key === KEY_HIDDEN || event.key === KEY_SPECIES || event.key === KEY_STAY_PUT) volatilePrefs.delete(event.key);
      else return;
      sync();
    };
    sync();
    window.addEventListener(CHANGED, sync);
    /* storage 事件只在**别的**标签页写入时触发, 所以同窗口靠上面那个自定义事件;
     * 这一条是为多窗口准备的。 */
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(CHANGED, sync);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const write = useCallback((k: string, v: string) => {
    volatilePrefs.set(k, v);
    try {
      localStorage.setItem(k, v);
      volatilePrefs.delete(k);
    } catch { /* The in-memory value remains authoritative for this window. */ }
    window.dispatchEvent(new CustomEvent(CHANGED));
  }, []);

  return {
    ...prefs,
    setHidden: useCallback((v: boolean) => write(KEY_HIDDEN, v ? '1' : '0'), [write]),
    setSpecies: useCallback((v: MascotSpecies) => write(KEY_SPECIES, v), [write]),
    setStayPut: useCallback((v: boolean) => write(KEY_STAY_PUT, v ? '1' : '0'), [write]),
  };
}
