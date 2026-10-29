import chalk from 'chalk';

export interface ThemeShape {
  brand: { cyan: string; blue: string; purple: string; magenta: string; pink: string };
  functional: { success: string; warning: string; error: string; info: string };
  /** faint: 最淡一级 (快捷键提示、行号、括号); 只在需要第三级时用 */
  text: { primary: string | undefined; secondary: string; dim: string; faint: string; highlight: string };
  bg: { selected: string; hover: string; card: string };
  border: { primary: string; secondary: string; accent: string };
  ui: { separator: string; prompt: string; label: string };
  logoGradient: [string, string, string, string, string, string];
  /** 陶土色: 只给启动框的框线、标志 */
  clay: string;
  /** 底板 (真彩 / 256 色才有; 16 色下为 undefined —— 量化后发灰, 不画) */
  surface: { slab?: string; sel?: string; add?: string; del?: string };
  /** Agent 身份色: 只用在「这是谁」(名字、左侧短竖条), 不表达状态 */
  identity: string[];
}

type Mode = 'light' | 'dark';

// ── 身份色: 每主题 accent (中间调) + logo 渐变 + 功能色 ──
interface Identity { accent: string; accentDark?: string; logo: [string, string, string, string, string, string]; success: string; clay?: boolean }
const IDS: Record<string, Identity> = {
  /* 默认 陶土: 钴蓝只用在进行中/输入提示符; 标志是浅陶三叶 */
  clay:  { accent: '#2F6BFF', accentDark: '#6B97FF', success: '#2F8F5B', clay: true, logo: ['#EBC9AE', '#E3B697', '#DDA886', '#D49B79', '#CB8D6B', '#C27F5D'] },
  /* 默认: 跟官方 vortex mark 同一条紫→蓝渐变 (从 mark 像素上取的色), accent 取中段紫 ——
   * 桌面端主色 #6E56FF 一族, 在深/浅底上都够对比。 */
  neox:  { accent: '#8A6CFF', success: '#3FA97A', logo: ['#9B4FFF', '#8C5CFF', '#7C69FF', '#6377FF', '#4B88FF', '#3C9BFF'] },
  slate: { accent: '#3E7CA8', success: '#3E8E6E', logo: ['#5E92BC', '#5187B0', '#477EA6', '#41769C', '#3B6C8E', '#356180'] },
  warm:  { accent: '#C2663F', success: '#7E944F', logo: ['#CE7E5E', '#C77657', '#C26F4E', '#B36548', '#A35B42', '#94523B'] },
  mono:  { accent: '#6B5FB0', success: '#5E8A66', logo: ['#8579C8', '#7B70BF', '#7065B2', '#6459A0', '#594E8D', '#4E437A'] },
  nord:  { accent: '#4C7CA8', success: '#6B8E4E', logo: ['#6A92BC', '#6189B3', '#5B82AC', '#5479A0', '#4C7094', '#446788'] },
  neon:  { accent: '#00b8d9', success: '#00a0c0', logo: ['#ff69b4', '#00d9ff', '#5555ff', '#9370db', '#ff69b4', '#7a7a7a'] },
};
const ACTIVE = (process.env.NEOX_THEME || 'clay').toLowerCase();
const ACTIVE_ID = IDS[ACTIVE] ?? IDS.clay!;
export const ACTIVE_THEME_NAME = IDS[ACTIVE] ? ACTIVE : 'clay';

/* ── 混色: 探测到的真实底色 (OSC 11) + 假定前景 → 灰阶/底板 ── */
let _bgHex: string | null = null;
const toRgb = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const toHex = (c: number[]) => '#' + c.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
/** a 占 t, b 占 1-t */
export function mixHex(a: string, b: string, t: number): string {
  const x = toRgb(a), y = toRgb(b);
  return toHex(x.map((v, i) => v * t + y[i]! * (1 - t)));
}

// ── 背景模式: 显式覆盖 > OSC探测结果 > COLORFGBG > 默认 dark ──
let _override: Mode | null = null;
function envMode(): Mode {
  const o = (process.env.NEOX_BG || '').toLowerCase();
  if (o === 'light' || o === 'dark') return o;
  const fgbg = process.env.COLORFGBG;
  if (fgbg) { const bg = parseInt(fgbg.split(';').pop() || '', 10); if (!Number.isNaN(bg)) return bg >= 7 && bg !== 8 ? 'light' : 'dark'; }
  return 'dark';
}
function currentMode(): Mode { return _override ?? envMode(); }

function build(id: Identity, mode: Mode): ThemeShape {
  // 正文 primary = undefined → 终端前景色 (永远清晰); secondary/dim 按背景走对比。
  const basic = chalk.level <= 1;
  const text = basic
    ? { primary: undefined, secondary: mode === 'light' ? 'black' : 'white', dim: 'gray', highlight: id.accent }
    : mode === 'light'
      ? { primary: undefined, secondary: '#52585F', dim: '#7C828B', highlight: id.accent }
      : { primary: undefined, secondary: '#BCC2CA', dim: '#8B919A', highlight: id.accent };
  const borderC = basic ? 'gray' : mode === 'light' ? '#C9CDD3' : '#3C414A';
  if (id.clay) return buildClay(id, mode, basic);
  return {
    brand: { cyan: id.accent, blue: id.accent, purple: id.accent, magenta: id.accent, pink: id.accent },
    functional: { success: id.success, warning: '#C98A2E', error: '#C0504A', info: id.accent },
    text: { ...text, faint: text.dim },
    bg: { selected: mode === 'light' ? '#E6EBF0' : '#2A3038', hover: mode === 'light' ? '#EEF1F4' : '#262B32', card: mode === 'light' ? '#F4F6F8' : '#1F242B' },
    border: { primary: borderC, secondary: borderC, accent: id.accent },
    ui: { separator: borderC, prompt: id.accent, label: id.accent },
    logoGradient: id.logo,
    clay: id.logo[3],
    surface: {},
    identity: [id.logo[0], id.accent, id.success, '#9B76C4', '#C29A2E'],
  };
}

/** 陶土: 灰阶、细线、底板都由前景和真实底色混出来 */
function buildClay(id: Identity, mode: Mode, basic: boolean): ThemeShape {
  const light = mode === 'light';
  const bg = _bgHex ?? (light ? '#FBFAF7' : '#1B1916');
  const fg = light ? '#23211E' : '#EDE8E0';
  const accent = light ? id.accent : (id.accentDark ?? id.accent);
  const ok = light ? '#2F8F5B' : '#5DBB86';
  const warn = light ? '#B87A1E' : '#E8A23A';
  const err = light ? '#C9443F' : '#E2706B';
  /* 框线用的陶土色跟底色再混一道 —— 纯陶土色在浅灰蓝底 (Termius) 上发红 */
  const clay = mixHex(light ? '#B9744F' : '#D49A78', bg, 0.75);
  /* 16 色: 灰阶/细线交给终端自己的 gray/white (见 build 顶部注释); 彩色仍给 hex, chalk 自己量化到最近的 ANSI 色 */
  if (basic) {
    return {
      brand: { cyan: accent, blue: accent, purple: accent, magenta: accent, pink: accent },
      functional: { success: ok, warning: warn, error: err, info: accent },
      text: { primary: undefined, secondary: light ? 'black' : 'white', dim: 'gray', faint: 'gray', highlight: accent },
      bg: { selected: accent, hover: 'gray', card: 'gray' },
      border: { primary: 'gray', secondary: 'gray', accent },
      ui: { separator: 'gray', prompt: accent, label: accent },
      logoGradient: id.logo,
      clay: light ? '#B9744F' : '#D49A78',
      surface: {},
      identity: ['#C27C5B', '#4F86F7', '#5E9F7C', '#9B76C4', '#C29A2E'],
    };
  }
  const m = (t: number) => mixHex(fg, bg, t);
  const line = m(0.3);
  return {
    brand: { cyan: accent, blue: accent, purple: accent, magenta: accent, pink: accent },
    functional: { success: ok, warning: warn, error: err, info: accent },
    text: { primary: undefined, secondary: m(0.78), dim: m(0.62), faint: m(0.48), highlight: accent },
    bg: { selected: mixHex(accent, bg, 0.14), hover: m(0.07), card: m(0.05) },
    border: { primary: line, secondary: line, accent },
    ui: { separator: line, prompt: accent, label: accent },
    logoGradient: id.logo,
    clay,
    surface: {
      slab: m(0.055),
      sel: mixHex(accent, bg, 0.15),
      add: mixHex(ok, bg, 0.14),
      del: mixHex(err, bg, 0.13),
    },
    identity: ['#C27C5B', '#4F86F7', '#5E9F7C', '#9B76C4', '#C29A2E'].map(c => mixHex(c, fg, 0.82)),
  };
}

// ── 惰性 NeoxTheme: 按当前背景模式缓存重算; setBgMode 后自动反映 ──
let _cache: ThemeShape | null = null;
let _cacheMode: Mode | null = null;
function active(): ThemeShape {
  const m = currentMode();
  if (_cache && _cacheMode === m) return _cache;
  _cache = build(_activeId, m);
  _cacheMode = m;
  return _cache;
}
export const NeoxTheme: ThemeShape = new Proxy({} as ThemeShape, {
  get: (_t, k: string) => (active() as any)[k],
  has: (_t, k) => k in active(),
  ownKeys: () => Reflect.ownKeys(active()),
  getOwnPropertyDescriptor: (_t, k) => ({ enumerable: true, configurable: true, value: (active() as any)[k] }),
});

export function setBgMode(m: Mode): void { if (m !== _override) { _override = m; _cache = null; } }
export function getBgMode(): Mode { return currentMode(); }

// ── 运行时切配色 (/theme 命令用) ──
let _activeId = ACTIVE_ID;
let _activeName = ACTIVE_THEME_NAME;
export const THEME_NAMES = ['clay', 'neox', 'slate', 'warm', 'mono', 'nord', 'neon'] as const;
export function getThemeName(): string { return _activeName; }
export function setTheme(name: string): boolean {
  const n = name.toLowerCase();
  if (!IDS[n]) return false;
  if (n !== _activeName) { _activeId = IDS[n]!; _activeName = n; _cache = null; }
  return true;
}

/** OSC-11 问终端真实背景色 → 算亮度 → setBgMode. 在 Ink 接管 stdin 前、首帧前调。~120ms 超时. */
export async function initBgDetection(): Promise<void> {
  if ((process.env.NEOX_BG || '').length) return;            // 用户显式指定就不探
  const so = process.stdout as NodeJS.WriteStream, si = process.stdin as NodeJS.ReadStream;
  if (!so.isTTY || !si.isTTY) return;
  await new Promise<void>((resolve) => {
    let buf = ''; const wasRaw = si.isRaw;
    const done = (mode: Mode | null) => {
      clearTimeout(t); si.off('data', onData); try { if (!wasRaw) si.setRawMode(false); } catch { /* */ }
      try { si.pause(); } catch { /* */ }
      if (mode) setBgMode(mode);
      resolve();
    };
    const onData = (d: Buffer) => {
      buf += d.toString('latin1');
      const m = buf.match(/\x1b\]11;rgb:([0-9a-fA-F]+)\/([0-9a-fA-F]+)\/([0-9a-fA-F]+)/);
      if (m) {
        const hi = (h: string) => parseInt(h.slice(0, 2).padEnd(2, h[0] || '0'), 16) / 255;
        const lum = 0.2126 * hi(m[1]!) + 0.7152 * hi(m[2]!) + 0.0722 * hi(m[3]!);
        /* 记下真实底色, 陶土主题的灰阶/底板按它混 */
        _bgHex = toHex([m[1]!, m[2]!, m[3]!].map(h => hi(h) * 255));
        _cache = null;
        done(lum > 0.5 ? 'light' : 'dark');
      }
    };
    const t = setTimeout(() => done(null), 120);
    try { si.setRawMode(true); } catch { /* */ }
    si.on('data', onData); si.resume();
    so.write('\x1b]11;?\x07');
  });
}

/** Helper: getColor('brand.cyan') => hex */
export function getColor(path: string): string {
  const parts = path.split('.');
  let value: any = NeoxTheme;
  for (const part of parts) { value = value?.[part]; if (value === undefined || value === null) return ACTIVE_ID.accent; }
  return value;
}
