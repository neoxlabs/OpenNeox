import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { WorkspaceState } from '../shared/ipc';
import { dispatchHint } from '../renderer/components/notifyEvents';
import { syncWinTitleBar } from '../renderer/utils/winTitleBarSync';
import { applyThemePack, findPack, THEME_PACKS, type ThemePack } from './themePacks';

const baseName = (p: string): string => p.split(/[/\\]/).filter(Boolean).pop() || p;

// 颜色主题
export type ColorTheme = 'violet' | 'gold' | 'pink' | 'blue' | 'green' | 'purple' | 'orange' | 'red' | 'cyan' | 'indigo' | 'teal';

// 外层结构质感: floating 保留悬浮卡片, flat 贴近 VS Code 平铺。
export type SurfaceStyle = 'floating' | 'flat';

  // 外层雾面强度: frosted=磨砂实色皮肤(壁纸不可见), clear=透出壁纸图.
export type FrostedEffect = 'frosted' | 'clear';

/** 外观来源: auto=按时在暗夜/软白间切换; manual=用户自选主题包 */
export type ThemeAppearanceMode = 'auto' | 'manual';

// 主题模式
export type DarkModePreference = 'dark' | 'midnight' | 'high-contrast' | 'light' | 'auto';

// 主题预设：用户面向的"一键风格"。每个预设隐式决定 darkMode + colorTheme + 特殊视觉。
//   chenguang  晨光   —— 亮色 · 暖金调
//   moye       墨夜   —— 深色 · 靛蓝调
//   nuanyang   暖阳   —— 亮色 · 奶油暖黄 / 温润日光
//   liuli      浅白   —— 亮色 · 中性白底
export type ThemePreset = 'chenguang' | 'moye' | 'nuanyang' | 'liuli';

export interface ThemePresetInfo {
  id: ThemePreset;
  name: string;        // 中文名
  desc: string;        // 一句话说明
  darkMode: DarkModePreference;
  colorTheme: ColorTheme;
  // 卡片预览用的两个色: 主色 + 辅色
  swatch: [string, string];
}

export const THEME_PRESETS: ThemePresetInfo[] = [
  { id: 'liuli',     name: '浅白', desc: '轻白界面 · 清爽专注',     darkMode: 'light',    colorTheme: 'violet', swatch: ['#ffffff', '#f2f3f3'] },
  { id: 'chenguang', name: '晨光', desc: '清晨柔光 · 亮色品牌紫',   darkMode: 'light',    colorTheme: 'violet', swatch: ['#f4f5fb', '#6E56FF'] },
  { id: 'moye',      name: '墨夜', desc: '深夜墨色 · 沉静靛蓝',     darkMode: 'midnight', colorTheme: 'indigo', swatch: ['#1f2126', '#7986cb'] },
  { id: 'nuanyang',  name: '暖阳', desc: '奶油暖橙 · 温润日光',     darkMode: 'light',    colorTheme: 'orange', swatch: ['#fdf7ea', '#ed8a2e'] },
];

// 实际应用的明暗模式
export type ResolvedDarkMode = 'dark' | 'light';

// 主题配置
export interface ThemeConfig {
  colorTheme: ColorTheme;
  darkModePreference: DarkModePreference;
}

// 颜色主题定义（用于预览卡片）
export interface ColorThemeInfo {
  id: ColorTheme;
  name: string;
  primaryColor: string;
  accentColor: string;
}

export const COLOR_THEMES: ColorThemeInfo[] = [
  { id: 'violet', name: '品牌紫', primaryColor: '#6E56FF', accentColor: '#8974FF' },
  { id: 'gold', name: '暗金', primaryColor: '#c9a227', accentColor: '#ddb52f' },
  { id: 'pink', name: '粉红', primaryColor: '#e91e63', accentColor: '#f48fb1' },
  { id: 'blue', name: '天蓝', primaryColor: '#2196f3', accentColor: '#64b5f6' },
  { id: 'green', name: '翠绿', primaryColor: '#4caf50', accentColor: '#81c784' },
  { id: 'purple', name: '紫罗兰', primaryColor: '#9c27b0', accentColor: '#ba68c8' },
  { id: 'orange', name: '橙色', primaryColor: '#ff9800', accentColor: '#ffb74d' },
  { id: 'red', name: '中国红', primaryColor: '#d32f2f', accentColor: '#ef5350' },
  { id: 'cyan', name: '青色', primaryColor: '#00bcd4', accentColor: '#4dd0e1' },
  { id: 'indigo', name: '靛蓝', primaryColor: '#3f51b5', accentColor: '#7986cb' },
  { id: 'teal', name: '蓝绿', primaryColor: '#009688', accentColor: '#4db6ac' },
];

/** 把 #rrggbb 解析成 [r,g,b]. 不合法字符串回退 [0,0,0]. */
function hexToRgb(hex: string): [number, number, number] {
  const m = hex.replace('#', '').trim();
  if (m.length !== 6) return [0, 0, 0];
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  return [Number.isFinite(r) ? r : 0, Number.isFinite(g) ? g : 0, Number.isFinite(b) ? b : 0];
}

/** 从 11 个内置 COLOR_THEMES 里挑跟给定 hex 最接近的一个 (RGB Euclidean).
 * 给 setThemePack 用 — 切包时自动对齐 accent picker, 避免"暖色包但 CTA 还是绿"现象. */
export function pickNearestColorTheme(targetHex: string): ColorTheme | null {
  const [tr, tg, tb] = hexToRgb(targetHex);
  let bestId: ColorTheme | null = null;
  let bestDist = Infinity;
  for (const t of COLOR_THEMES) {
    const [r, g, b] = hexToRgb(t.primaryColor);
    const d = (r - tr) ** 2 + (g - tg) ** 2 + (b - tb) ** 2;
    if (d < bestDist) {
      bestDist = d;
      bestId = t.id;
    }
  }
  return bestId;
}

interface AppStoreValue {
  // 主题相关
  darkMode: ResolvedDarkMode;          // 实际使用的明暗模式
  darkModePreference: DarkModePreference; // 用户的明暗模式偏好
  colorTheme: ColorTheme;              // 当前颜色主题
  themePreset: ThemePreset;            // 当前一键风格预设 (legacy, 仅 4 个值)
  themePackId: string;                 // 当前 ThemePack id (16+ 包 + 自定义), 超级调色盘新增
  themePack: ThemePack;                // 当前 ThemePack 完整对象 (含 tokens/wallpaper/glass)
  /** 自动(按时黑白) vs 主题选择(自选包) */
  themeAppearanceMode: ThemeAppearanceMode;
  surfaceStyle: SurfaceStyle;          // 外层结构质感: 悬浮卡片 / 平铺
  frostedEffect: FrostedEffect;        // 外层雾面: 磨砂 / 透出壁纸
  /** 可选毛玻璃侧栏 (默认关) — 透出窗口 vibrancy, 不影响主题配色本身 */
  sidebarGlass: boolean;
  setDarkModePreference: (pref: DarkModePreference) => void;
  setColorTheme: (theme: ColorTheme) => void;
  /** 用户是否**主动挑过**强调色。false = 当前生效的是主题包自带的主色。
   *  取色板必须读它: 只看 colorTheme 的值会在"没选过"时给一个并没有生效的颜色打勾
   *  (引导页就是这么显示成靛蓝、而界面实际是墨色的)。 */
  accentExplicit: boolean;
  /** 退回跟随主题包的主色 (清掉"主动选过"标记)。 */
  resetColorTheme: () => void;
  setThemePreset: (preset: ThemePreset) => void;
  setThemePack: (packId: string) => void;
  setThemeAppearanceMode: (mode: ThemeAppearanceMode) => void;
  setSurfaceStyle: (style: SurfaceStyle) => void;
  setFrostedEffect: (effect: FrostedEffect) => void;
  setSidebarGlass: (on: boolean) => void;
  toggleDarkMode: () => void;

  // 兼容旧 API
  theme: ResolvedDarkMode;
  themePreference: DarkModePreference;
  setTheme: (theme: DarkModePreference) => void;
  toggleTheme: () => void;

  // 工作区
  workspace: WorkspaceState | null;
  setWorkspace: (workspace: WorkspaceState | null) => void;
  // 多根工作区: 给当前工作区增/删一个项目根 (primary root 不可删), 自动持久化。
  addWorkspaceRoot: (rootPath: string) => Promise<void>;
  removeWorkspaceRoot: (rootPath: string) => Promise<void>;
  // 工作区实体: 重命名当前工作区 (持久化 + 立即刷新显示名)。
  renameWorkspace: (name: string) => Promise<void>;
  // 别处已经写盘改了某个工作区 (侧栏工作区管理): primary 是当前工作区就同步进状态, 让 runtime 立刻拿到新根
  applyWorkspacePatch: (primary: string, patch: { roots?: string[]; name?: string }) => void;
}

const DARK_MODE_STORAGE_KEY = 'neox-darkmode';
const COLOR_THEME_STORAGE_KEY = 'neox-color-theme';
const ACCENT_EXPLICIT_STORAGE_KEY = 'neox-accent-explicit';

function hasExplicitAccent(): boolean {
  if (typeof window === 'undefined') return false;
  try { return window.localStorage.getItem(ACCENT_EXPLICIT_STORAGE_KEY) === '1'; }
  catch { return false; }
}

function markAccentExplicit(): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(ACCENT_EXPLICIT_STORAGE_KEY, '1'); } catch { /* 隐私模式 */ }
}

/** 退回"跟随主题包" —— 把主动选过的标记清掉, 主题包自己的主色重新说了算。 */
function clearAccentExplicit(): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.removeItem(ACCENT_EXPLICIT_STORAGE_KEY); } catch { /* 隐私模式 */ }
}
const THEME_PRESET_STORAGE_KEY = 'neox-theme-preset';
const THEME_PACK_STORAGE_KEY = 'neox-theme-pack';
const THEME_APPEARANCE_MODE_STORAGE_KEY = 'neox-theme-appearance-mode';
const SURFACE_STYLE_STORAGE_KEY = 'neox-surface-style';
const FROSTED_EFFECT_STORAGE_KEY = 'neox-frosted-effect';
const SIDEBAR_GLASS_STORAGE_KEY = 'neox-sidebar-glass';
const LEGACY_GLASS_OFF_STORAGE_KEY = 'neox-glass-off';

/** 自动模式下的黑白包: 白天软白 / 夜晚暗夜 */
const AUTO_LIGHT_PACK_ID = 'liulibasic';
const AUTO_DARK_PACK_ID = 'anye';
/** 本地时间 [6, 18) 用浅色, 其余用深色 */
const AUTO_DAY_HOUR_START = 6;
const AUTO_DAY_HOUR_END = 18;

const isValidThemeAppearanceMode = (val: string | null): val is ThemeAppearanceMode => {
  return val === 'auto' || val === 'manual';
};

const packIdForLocalTime = (date: Date = new Date()): string => {
  const hour = date.getHours();
  return (hour >= AUTO_DAY_HOUR_START && hour < AUTO_DAY_HOUR_END)
    ? AUTO_LIGHT_PACK_ID
    : AUTO_DARK_PACK_ID;
};

const isAutoBwPack = (packId: string | null | undefined): boolean => {
  return packId === AUTO_LIGHT_PACK_ID || packId === AUTO_DARK_PACK_ID;
};

const LEGACY_PRESET_TO_PACK: Record<ThemePreset, string> = {
  liuli: 'liulibasic',
  chenguang: 'chenguang',
  moye: 'anye',
  nuanyang: 'nuanyang',
};

const LEGACY_PACK_TO_PRESET: Partial<Record<string, ThemePreset>> = {
  liulibasic: 'liuli',
  liuli: 'liuli',
  chenguang: 'chenguang',
  anye: 'moye',
  nuanyang: 'nuanyang',
};

const AppStoreContext = createContext<AppStoreValue | null>(null);

const isValidDarkModePreference = (val: unknown): val is DarkModePreference => {
  return val === 'dark' || val === 'midnight' || val === 'high-contrast' || val === 'light' || val === 'auto';
};

const isValidColorTheme = (val: unknown): val is ColorTheme => {
  return COLOR_THEMES.some(t => t.id === val);
};

const isValidSurfaceStyle = (val: unknown): val is SurfaceStyle => {
  return val === 'floating' || val === 'flat';
};

const isValidFrostedEffect = (val: unknown): val is FrostedEffect => {
  return val === 'frosted' || val === 'clear';
};

const isValidThemePreset = (val: unknown): val is ThemePreset => {
  return THEME_PRESETS.some(p => p.id === val);
};

const resolvePackIdFromLegacyPreset = (legacyPreset: unknown): string | null => {
  if (legacyPreset === 'nailong') return 'nuanyang';
  if (isValidThemePreset(legacyPreset)) return LEGACY_PRESET_TO_PACK[legacyPreset];
  if (typeof legacyPreset === 'string' && findPack(legacyPreset)) return legacyPreset;
  return null;
};

const getCompatiblePresetForPack = (pack: ThemePack): ThemePreset => {
  return LEGACY_PACK_TO_PRESET[pack.id] ?? (pack.mode === 'dark' ? 'moye' : 'liuli');
};

const usesLockedPackAccent = (pack: ThemePack): boolean => {
  return pack.id === 'anye';
};

const getInitialDarkModePreference = (): DarkModePreference => {
  if (typeof window === 'undefined') return 'auto';
  const saved = window.localStorage.getItem(DARK_MODE_STORAGE_KEY);
  if (isValidDarkModePreference(saved)) {
    return saved;
  }
  return 'auto';
};

const getInitialColorTheme = (): ColorTheme => {
  if (typeof window === 'undefined') return 'violet';
  const saved = window.localStorage.getItem(COLOR_THEME_STORAGE_KEY);
  if (isValidColorTheme(saved)) {
    return saved;
  }
  return 'violet';   // 默认强调色 = 品牌紫 (跟 logo / 默认主题一致)
};

const getInitialThemePreset = (): ThemePreset => {
  if (typeof window === 'undefined') return 'liuli';
  const savedPack = window.localStorage.getItem(THEME_PACK_STORAGE_KEY);
  const pack = savedPack ? findPack(savedPack) : undefined;
  if (pack) return getCompatiblePresetForPack(pack);
  const saved = window.localStorage.getItem(THEME_PRESET_STORAGE_KEY);
  if (saved === 'nailong') return 'nuanyang';
  if (isValidThemePreset(saved)) {
    return saved;
  }
  return 'liuli';
};

/* 超级调色盘: 取初始 pack id.
 * 优先级: localStorage 'neox-theme-pack' → 兼容 'neox-theme-preset' → 按时间自动黑白.
 * legacy preset "moye" 现在映射到真正的暗夜包 "anye", 避免跟新版浅色 moye 包冲突.
 */
const getInitialThemePackId = (): string => {
  if (typeof window === 'undefined') return AUTO_DARK_PACK_ID;
  const saved = window.localStorage.getItem(THEME_PACK_STORAGE_KEY);
  if (saved && findPack(saved)) return saved;
  const legacyPackId = resolvePackIdFromLegacyPreset(window.localStorage.getItem(THEME_PRESET_STORAGE_KEY));
  if (legacyPackId) {
    window.localStorage.setItem(THEME_PACK_STORAGE_KEY, legacyPackId);
    return legacyPackId;
  }
  return AUTO_DARK_PACK_ID;
};

/** 外观模式初始值: 有存档用存档; 否则彩色包视为「主题选择」, 黑白/未设走「自动」. */
const getInitialThemeAppearanceMode = (): ThemeAppearanceMode => {
  if (typeof window === 'undefined') return 'manual';
  const saved = window.localStorage.getItem(THEME_APPEARANCE_MODE_STORAGE_KEY);
  if (isValidThemeAppearanceMode(saved)) return saved;
  const packId = window.localStorage.getItem(THEME_PACK_STORAGE_KEY);
  if (packId && findPack(packId) && !isAutoBwPack(packId)) return 'manual';
  return 'manual';
};

const getInitialResolvedDarkMode = (): ResolvedDarkMode => {
  const initialPack = findPack(getInitialThemePackId());
  return initialPack?.mode === 'dark' ? 'dark' : 'light';
};

const getInitialSurfaceStyle = (): SurfaceStyle => 'flat';

const getInitialFrostedEffect = (): FrostedEffect => 'frosted';

const getInitialSidebarGlass = (): boolean => false;

export const AppStoreProvider = ({ children }: { children: ReactNode }) => {
  const [darkModePreference, setDarkModePrefState] = useState<DarkModePreference>(getInitialDarkModePreference);
  const [themePreset, setThemePresetState] = useState<ThemePreset>(getInitialThemePreset);
  const [themePackId, setThemePackIdState] = useState<string>(getInitialThemePackId);
  const themePack = useMemo<ThemePack>(() => findPack(themePackId) ?? THEME_PACKS[0], [themePackId]);
  const [themeAppearanceMode, setThemeAppearanceModeState] = useState<ThemeAppearanceMode>(getInitialThemeAppearanceMode);
  const [resolvedDarkMode, setResolvedDarkMode] = useState<ResolvedDarkMode>(getInitialResolvedDarkMode);
  const [colorTheme, setColorThemeState] = useState<ColorTheme>(getInitialColorTheme);
  /* 用 state 而不是每次读 localStorage: 否则"选了跟当前同一个强调色"时 colorTheme 没变,
   * effect 不重跑, 覆盖就不会生效 —— 用户点了却没反应。 */
  const [accentExplicit, setAccentExplicit] = useState<boolean>(hasExplicitAccent);
  const [surfaceStyle, setSurfaceStyleState] = useState<SurfaceStyle>(getInitialSurfaceStyle);
  const [frostedEffect, setFrostedEffectState] = useState<FrostedEffect>(getInitialFrostedEffect);
  const [sidebarGlass, setSidebarGlassState] = useState<boolean>(getInitialSidebarGlass);
  const [workspace, setWorkspaceState] = useState<WorkspaceState | null>(null);
  // 使用 ref 来追踪是否已从后端加载，避免保存 effect 用旧值覆盖
  const hasLoadedFromBackend = React.useRef(false);
  const [isInitialized, setIsInitialized] = useState(false);
  const themeAppearanceModeRef = React.useRef(themeAppearanceMode);
  themeAppearanceModeRef.current = themeAppearanceMode;

  // 启动时从后端加载主题设置
  useEffect(() => {
    // 没有 Electron API 时（开发模式），只使用 localStorage，不触发保存
    if (typeof window === 'undefined' || !window.neox?.getLastState) {
      console.log('[AppStore] No Electron API, using localStorage only (dev mode)');
      hasLoadedFromBackend.current = false; // 标记为未从后端加载，阻止保存到后端
      setIsInitialized(true);
      return;
    }

    window.neox.getLastState()
      .then((state) => {
        console.log('[AppStore] Loaded state from backend:', state);
        if (state) {
          // 优先使用后端保存的值
          if (isValidDarkModePreference(state.darkModePreference)) {
            setDarkModePrefState(state.darkModePreference);
            window.localStorage.setItem(DARK_MODE_STORAGE_KEY, state.darkModePreference);
          }
          if (isValidColorTheme(state.colorTheme)) {
            setColorThemeState(state.colorTheme);
            window.localStorage.setItem(COLOR_THEME_STORAGE_KEY, state.colorTheme);
          }
          /* 超级调色盘: 后端的 themePackId 优先 (SQLite 真相)
           * 自动外观模式下不吃后端包 — 由按时黑白逻辑接管, 避免旧彩色包盖掉自动. */
          if (themeAppearanceModeRef.current !== 'auto') {
            const backendPackId = state.themePackId;
            const backendPack = backendPackId ? findPack(backendPackId) : undefined;
            if (backendPack) {
              const compatiblePreset = getCompatiblePresetForPack(backendPack);
              setThemePackIdState(backendPack.id);
              setThemePresetState(compatiblePreset);
              window.localStorage.setItem(THEME_PACK_STORAGE_KEY, backendPack.id);
              window.localStorage.setItem(THEME_PRESET_STORAGE_KEY, compatiblePreset);
            } else {
              const legacyPackId = resolvePackIdFromLegacyPreset(state.themePreset);
              const legacyPack = legacyPackId ? findPack(legacyPackId) : undefined;
              if (legacyPack) {
                const compatiblePreset = getCompatiblePresetForPack(legacyPack);
                setThemePackIdState(legacyPack.id);
                setThemePresetState(compatiblePreset);
                window.localStorage.setItem(THEME_PACK_STORAGE_KEY, legacyPack.id);
                window.localStorage.setItem(THEME_PRESET_STORAGE_KEY, compatiblePreset);
                const api = window.neox as { setThemePack?: (id: string) => Promise<void> } | undefined;
                api?.setThemePack?.(legacyPack.id).catch((err: Error) => {
                  console.warn('[AppStore] Failed to migrate legacy themePreset to themePack:', err);
                });
              }
            }
          } else {
            const defaultPack = findPack(AUTO_DARK_PACK_ID);
            if (defaultPack) {
              const compatiblePreset = getCompatiblePresetForPack(defaultPack);
              setThemePackIdState(defaultPack.id);
              setThemePresetState(compatiblePreset);
              setDarkModePrefState(defaultPack.mode);
              window.localStorage.setItem(THEME_PACK_STORAGE_KEY, defaultPack.id);
              window.localStorage.setItem(THEME_PRESET_STORAGE_KEY, compatiblePreset);
            }
          }
        }
        hasLoadedFromBackend.current = true;
        setIsInitialized(true);
      })
      .catch((err: Error) => {
        console.warn('[AppStore] Failed to load theme from backend:', err);
        hasLoadedFromBackend.current = true;
        setIsInitialized(true);
      });
  }, []);

  /* resolvedDarkMode 现在以 themePack.mode 为真相源 (统一 16 张包).
   * 老的 themePreset 派生路径作废 — 它停留在 'liuli' 不会随 setThemePack 更新,
   * 会让组件读到错的 darkMode 状态. */
  useEffect(() => {
    setResolvedDarkMode(themePack.mode === 'dark' ? 'dark' : 'light');
  }, [themePack]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    root.setAttribute('data-surface-style', surfaceStyle);
    if (surfaceStyle === 'flat') {
      root.setAttribute('data-glass-off', '');
    } else {
      root.removeAttribute('data-glass-off');
    }
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(LEGACY_GLASS_OFF_STORAGE_KEY, surfaceStyle === 'flat' ? '1' : '0');
    }
  }, [surfaceStyle]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.setAttribute('data-frosted-effect', frostedEffect);
  }, [frostedEffect]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    if (sidebarGlass) {
      root.setAttribute('data-sidebar-glass', 'on');
      /* 全主题: 左栏走系统 vibrancy / Win Acrylic 时 html/body 必须透底 (跟 Welcome 同原理).
       * inline 兜底防被主题包实色规则盖回. */
      root.style.setProperty('background', 'transparent', 'important');
      root.style.setProperty('background-color', 'transparent', 'important');
      if (document.body) {
        document.body.style.setProperty('background', 'transparent', 'important');
        document.body.style.setProperty('background-color', 'transparent', 'important');
      }
    } else {
      root.removeAttribute('data-sidebar-glass');
      root.style.removeProperty('background');
      root.style.removeProperty('background-color');
      if (document.body) {
        document.body.style.removeProperty('background');
        document.body.style.removeProperty('background-color');
      }
    }
    /* Win: 立刻同步 Acrylic / 实色窗底 (MutationObserver 也会抓, 这里再钉一次防首帧黑底) */
    syncWinTitleBar();
  }, [sidebarGlass]);

  const colorThemeRef = React.useRef(colorTheme);
  React.useEffect(() => { colorThemeRef.current = colorTheme; }, [colorTheme]);
  const themePackIdRef = React.useRef(themePackId);
  React.useEffect(() => { themePackIdRef.current = themePackId; }, [themePackId]);

  const applyAccentOverride = useCallback((accent: ColorTheme) => {
    if (typeof document === 'undefined') return;
    const c = COLOR_THEMES.find(t => t.id === accent);
    if (!c) return;
    const root = document.documentElement;
    root.style.setProperty('--neox-primary-600', c.primaryColor);
    root.style.setProperty('--neox-primary-700', `color-mix(in srgb, ${c.primaryColor}, #000 18%)`);
    root.style.setProperty('--neox-primary-500', `color-mix(in srgb, ${c.primaryColor}, #fff 14%)`);
  }, []);

  // 应用主题到 DOM (legacy 字段, applyThemePack 已经设过 data-theme/data-theme-pack,
  // 但 [data-darkmode] / [data-color-theme] 还有别的 CSS 在用, 保留)
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-darkmode', darkModePreference);
      document.documentElement.setAttribute('data-color-theme', colorTheme);
      /* 只有用户主动挑过强调色才覆盖主题包的主色。没挑过就让包自己的中性主色留着 ——
       * 默认值 'violet' 不等于"他要紫色", 见 ACCENT_EXPLICIT_STORAGE_KEY。 */
      if (!usesLockedPackAccent(themePack) && accentExplicit) {
        applyAccentOverride(colorTheme);
      } else if (themePack?.tokens) {
        const root = document.documentElement;
        const t = themePack.tokens;
        if (t.primary500) root.style.setProperty('--neox-primary-500', t.primary500);
        if (t.primary600) root.style.setProperty('--neox-primary-600', t.primary600);
        if (t.primary700) root.style.setProperty('--neox-primary-700', t.primary700);
      }
      /* 注意: data-theme / data-theme-pack 由 applyThemePack 统一管理, 这里不再 set,
       * 否则会跟 data pack 的 remove 操作打架, 让 sakura/neonlight 的非 legacy 包
       * 在切换瞬间又被刷成 themePreset 的 liuli/moye 值, 触发错误 CSS. */
    }
  }, [darkModePreference, colorTheme, themePack, applyAccentOverride, accentExplicit]);

  /* 超级调色盘: pack 是 16 张内置 + 自定义包的源色注入入口.
   * applyThemePack 会:
   *   - 设 data-theme-pack / data-theme, 并清理 legacy data-theme-preset
   *   - 注入 inline CSS 变量 (--neox-bg-*, --neox-primary-*, ...)
   *   - 设壁纸 var(--wallpaper-image) 给 body::before 消费
   * 所有 pack 都走同一条数据驱动管线. */
  useEffect(() => {
    applyThemePack(themePack);
    if (usesLockedPackAccent(themePack)) {
      return;
    }
    if (!accentExplicit) return;

    if (themePack.seed?.accent) {
      const nearest = pickNearestColorTheme(themePack.seed.accent);
      if (nearest && nearest !== colorThemeRef.current) {
        setColorThemeState(nearest);
        if (typeof window !== 'undefined') {
          window.localStorage.setItem(COLOR_THEME_STORAGE_KEY, nearest);
        }
        applyAccentOverride(nearest);
        return;
      }
    }
    // pack 刚写完它自带的 primary, 立刻用用户当前 accent 覆盖, 让强调色胜出 (见上注).
    applyAccentOverride(colorThemeRef.current);
  }, [themePack, applyAccentOverride, accentExplicit]);

  // 追踪上一次保存的值，避免重复保存相同的值
  const lastSavedRef = React.useRef<{ darkMode: DarkModePreference; color: ColorTheme } | null>(null);

  // 保存主题偏好到 localStorage 和后端（只在初始化完成后且值确实改变时保存）
  useEffect(() => {
    if (typeof window === 'undefined' || !isInitialized || !hasLoadedFromBackend.current) return;

    // 检查值是否真的改变了
    const lastSaved = lastSavedRef.current;
    if (lastSaved && lastSaved.darkMode === darkModePreference && lastSaved.color === colorTheme) {
      return; // 值没变，不保存
    }

    console.log('[AppStore] Saving theme preference:', { darkModePreference, colorTheme });
    window.localStorage.setItem(DARK_MODE_STORAGE_KEY, darkModePreference);
    window.localStorage.setItem(COLOR_THEME_STORAGE_KEY, colorTheme);

    // 同步保存到后端持久化
    if (window.neox?.setThemePreference) {
      window.neox.setThemePreference(darkModePreference, colorTheme).catch((err: Error) => {
        console.warn('[AppStore] Failed to save theme preference:', err);
      });
    }

    lastSavedRef.current = { darkMode: darkModePreference, color: colorTheme };
  }, [darkModePreference, colorTheme, isInitialized]);

  const setDarkModePreference = useCallback((next: DarkModePreference) => {
    setDarkModePrefState(next);
  }, []);

  const resetColorTheme = useCallback(() => {
    clearAccentExplicit();
    setAccentExplicit(false);
  }, []);

  const setColorTheme = useCallback((next: ColorTheme) => {
    /* 这是两个强调色选择器 (Welcome / Onboarding) 唯一的入口, 所以"主动选过"就打在这里。
     * setThemePreset 走的是 setColorThemeState, 不经过这里 —— 选预设不算主动选强调色,
     * 那是包决定的颜色, 不是用户对强调色的表态。 */
    markAccentExplicit();
    setAccentExplicit(true);
    setColorThemeState(next);
  }, []);

  // 选预设 = 一键应用 legacy 入口, 内部转到统一 themePack 管线.
  const setThemePreset = useCallback((next: ThemePreset) => {
    const info = THEME_PRESETS.find(p => p.id === next);
    if (!info) return;
    const packId = LEGACY_PRESET_TO_PACK[next];
    setThemePresetState(next);
    setThemePackIdState(packId);
    setDarkModePrefState(info.darkMode);
    setColorThemeState(info.colorTheme);
    /* 主动选预设 → 「主题选择」 */
    setThemeAppearanceModeState('manual');
    themeAppearanceModeRef.current = 'manual';
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(THEME_PRESET_STORAGE_KEY, next);
      window.localStorage.setItem(THEME_PACK_STORAGE_KEY, packId);
      window.localStorage.setItem(THEME_APPEARANCE_MODE_STORAGE_KEY, 'manual');
      const api = window.neox as { setThemePack?: (id: string) => Promise<void> } | undefined;
      api?.setThemePack?.(packId).catch((err: Error) => {
        console.warn('[AppStore] Failed to persist themePack from themePreset:', err);
      });
      /* 同步落 main (SQLite ui:themePreset) — 让下次 BrowserWindow.backgroundColor 拿到对的色,
       * 不会闪到默认 IDEA Darcula. 失败 silently log, localStorage 仍是兜底. */
      if (window.neox?.setThemePreset) {
        window.neox.setThemePreset(next).catch((err: Error) => {
          console.warn('[AppStore] Failed to persist themePreset to main:', err);
        });
      }
    }
  }, []);

  /* 超级调色盘 — 切包入口 (16 张内置 + 自定义).
   * 16 张包全部数据驱动, 不再有 legacy 分支. setThemePack 是唯一入口,
   * darkModePref/themePreset 等老 state 仅向后兼容, 不影响实际渲染.
   * fromAuto=true 时不切到「主题选择」(自动按时换包内部调用). */
  const applyThemePackId = useCallback((nextPackId: string, opts?: { fromAuto?: boolean }) => {
    const pack = findPack(nextPackId);
    if (!pack) return;
    const compatiblePreset = getCompatiblePresetForPack(pack);
    setThemePackIdState(nextPackId);
    setThemePresetState(compatiblePreset);
    /* 同步 dark mode pref 跟 pack.mode 一致 — 让 [data-darkmode] 属性也对 */
    setDarkModePrefState(pack.mode);
    /* 用户主动选包 → 退出自动模式 */
    if (!opts?.fromAuto && themeAppearanceModeRef.current === 'auto') {
      setThemeAppearanceModeState('manual');
      themeAppearanceModeRef.current = 'manual';
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(THEME_APPEARANCE_MODE_STORAGE_KEY, 'manual');
      }
    }
    if (!usesLockedPackAccent(pack)) {
      const nearest = pack.seed?.accent ? pickNearestColorTheme(pack.seed.accent) : null;
      if (nearest && nearest !== colorThemeRef.current) {
        setColorThemeState(nearest);
        if (typeof window !== 'undefined') {
          window.localStorage.setItem(COLOR_THEME_STORAGE_KEY, nearest);
        }
      }
    }
    /* 持久化 */
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(THEME_PACK_STORAGE_KEY, nextPackId);
      window.localStorage.setItem(THEME_PRESET_STORAGE_KEY, compatiblePreset);
      const api = window.neox as { setThemePack?: (id: string) => Promise<void> } | undefined;
      if (api?.setThemePack) {
        api.setThemePack(nextPackId).catch((err: Error) => {
          console.warn('[AppStore] Failed to persist themePack to main:', err);
        });
      }
      /* 同步一个兼容 preset 给旧组件/旧版本兜底.
       * 新版浅色 moye 会写 liuli, 不再写 legacy "moye", 避免无 themePack 时误迁移到暗夜 anye. */
      window.neox?.setThemePreset?.(compatiblePreset).catch(() => undefined);
    }
  }, []);

  const setThemePack = useCallback((nextPackId: string) => {
    applyThemePackId(nextPackId);
  }, [applyThemePackId]);

  const setThemeAppearanceMode = useCallback((next: ThemeAppearanceMode) => {
    setThemeAppearanceModeState(next);
    themeAppearanceModeRef.current = next;
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(THEME_APPEARANCE_MODE_STORAGE_KEY, next);
    }
    if (next === 'auto') {
      applyThemePackId(packIdForLocalTime(), { fromAuto: true });
    }
  }, [applyThemePackId]);

  /* 自动模式: 按时在暗夜 / 软白间切换; 整点边界 + 回到前台时再对一次. */
  useEffect(() => {
    if (themeAppearanceMode !== 'auto') return;
    const sync = () => {
      const nextId = packIdForLocalTime();
      if (themePackIdRef.current === nextId) return;
      applyThemePackId(nextId, { fromAuto: true });
    };
    sync();
    const timer = window.setInterval(sync, 60_000);
    const onVis = () => { if (document.visibilityState === 'visible') sync(); };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [themeAppearanceMode, applyThemePackId]);

  /* 界面结构 / 雾面 / 侧栏毛玻璃都已下线 (见 getInitialSurfaceStyle): setter 保留签名但不再切换 */
  const setSurfaceStyle = useCallback((_next: SurfaceStyle) => {
    void setSurfaceStyleState; void SURFACE_STYLE_STORAGE_KEY;
  }, []);

  const setFrostedEffect = useCallback((_next: FrostedEffect) => {
    void setFrostedEffectState; void FROSTED_EFFECT_STORAGE_KEY;
  }, []);

  const setSidebarGlass = useCallback((on: boolean) => {
    setSidebarGlassState(on);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(SIDEBAR_GLASS_STORAGE_KEY, on ? '1' : '0');
    }
  }, []);

  // 切换明暗模式: light <-> dark（主界面只在两个模式间切换）
  const toggleDarkMode = useCallback(() => {
    setDarkModePrefState((prev) => {
      // 如果当前是 auto，根据实际显示的主题切换到相反的模式
      if (prev === 'auto') {
        return resolvedDarkMode === 'dark' ? 'light' : 'dark';
      }
      // light <-> dark 切换
      return prev === 'light' ? 'dark' : 'light';
    });
  }, [resolvedDarkMode]);

  const setWorkspace = useCallback((next: WorkspaceState | null) => {
    setWorkspaceState(next);
  }, []);

  // 多根: 给当前工作区加一个根目录 (去重, primary 恒首位), 持久化到 main。
  const addWorkspaceRoot = useCallback(async (rootPath: string) => {
    let primary: string | null = null;
    let nextRoots: string[] = [];
    let duplicate = false;
    setWorkspaceState((prev) => {
      if (!prev) return prev;
      primary = prev.path;
      const cur = (prev.roots && prev.roots.length > 0) ? prev.roots : [prev.path];
      if (cur.includes(rootPath)) { nextRoots = cur; duplicate = true; return prev; }
      nextRoots = [...cur, rootPath];
      return { ...prev, roots: nextRoots };
    });
    if (duplicate) { dispatchHint(`「${baseName(rootPath)}」已在工作区中`, 'info'); return; }
    if (primary && nextRoots.length > 0 && typeof window !== 'undefined' && window.neox?.setWorkspaceRoots) {
      try {
        const persisted = await window.neox.setWorkspaceRoots(primary, nextRoots);
        // main 归一化后回写 (路径 realpath 化可能与本地不同)
        setWorkspaceState((prev) => (prev && prev.path === primary ? { ...prev, roots: persisted } : prev));
        dispatchHint(`已添加「${baseName(rootPath)}」到工作区`, 'success');
      } catch (err) {
        console.warn('[AppStore] addWorkspaceRoot persist failed:', err);
        dispatchHint('添加文件夹失败', 'warning');
      }
    }
  }, []);

  // 工作区实体: 重命名当前工作区。
  const renameWorkspace = useCallback(async (name: string) => {
    let primary: string | null = null;
    setWorkspaceState((prev) => { primary = prev?.path ?? null; return prev; });
    if (!primary || typeof window === 'undefined' || !window.neox?.setWorkspaceName) return;
    try {
      const finalName = await window.neox.setWorkspaceName(primary, name);
      setWorkspaceState((prev) => (prev && prev.path === primary ? { ...prev, name: finalName } : prev));
    } catch (err) {
      console.warn('[AppStore] renameWorkspace failed:', err);
    }
  }, []);

  const applyWorkspacePatch = useCallback((primary: string, patch: { roots?: string[]; name?: string }) => {
    setWorkspaceState((prev) => (prev && prev.path === primary
      ? { ...prev, ...(patch.roots ? { roots: patch.roots } : {}), ...(patch.name ? { name: patch.name } : {}) }
      : prev));
  }, []);

  // 多根: 从当前工作区移除一个根 (primary 不可移除)。
  const removeWorkspaceRoot = useCallback(async (rootPath: string) => {
    let primary: string | null = null;
    let nextRoots: string[] = [];
    setWorkspaceState((prev) => {
      if (!prev) return prev;
      if (rootPath === prev.path) return prev; // primary 不可删
      primary = prev.path;
      const cur = (prev.roots && prev.roots.length > 0) ? prev.roots : [prev.path];
      nextRoots = cur.filter((r) => r !== rootPath);
      return { ...prev, roots: nextRoots };
    });
    if (primary && typeof window !== 'undefined' && window.neox?.setWorkspaceRoots) {
      try {
        const persisted = await window.neox.setWorkspaceRoots(primary, nextRoots);
        setWorkspaceState((prev) => (prev && prev.path === primary ? { ...prev, roots: persisted } : prev));
        dispatchHint(`已从工作区移除「${baseName(rootPath)}」`, 'success');
      } catch (err) {
        console.warn('[AppStore] removeWorkspaceRoot persist failed:', err);
        dispatchHint('移除失败', 'warning');
      }
    }
  }, []);

  const value = useMemo<AppStoreValue>(
    () => ({
      // 新 API
      darkMode: resolvedDarkMode,
      darkModePreference,
      colorTheme,
      themePreset,
      themePackId,
      themePack,
      themeAppearanceMode,
      surfaceStyle,
      frostedEffect,
      sidebarGlass,
      setDarkModePreference,
      setColorTheme,
      accentExplicit,
      resetColorTheme,
      setThemePreset,
      setThemePack,
      setThemeAppearanceMode,
      setSurfaceStyle,
      setFrostedEffect,
      setSidebarGlass,
      toggleDarkMode,

      // 兼容旧 API
      theme: resolvedDarkMode,
      themePreference: darkModePreference,
      setTheme: setDarkModePreference,
      toggleTheme: toggleDarkMode,

      workspace,
      setWorkspace,
      addWorkspaceRoot,
      removeWorkspaceRoot,
      renameWorkspace,
      applyWorkspacePatch,
    }),
    [resolvedDarkMode, darkModePreference, colorTheme, accentExplicit, resetColorTheme, themePreset, themePackId, themePack, themeAppearanceMode, surfaceStyle, frostedEffect, sidebarGlass, setDarkModePreference, setColorTheme, setThemePreset, setThemePack, setThemeAppearanceMode, setSurfaceStyle, setFrostedEffect, setSidebarGlass, toggleDarkMode, workspace, setWorkspace, addWorkspaceRoot, removeWorkspaceRoot, renameWorkspace, applyWorkspacePatch],
  );

  return <AppStoreContext.Provider value={value}>{children}</AppStoreContext.Provider>;
};

export const useAppStore = (): AppStoreValue => {
  const ctx = useContext(AppStoreContext);
  if (!ctx) {
    throw new Error('useAppStore must be used within an AppStoreProvider');
  }
  return ctx;
};
