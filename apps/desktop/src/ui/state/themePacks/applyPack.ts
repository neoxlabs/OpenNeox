/* ============================================================
 * applyThemePack — 把 ThemePack 应用到 DOM
 *
 * 三件事:
 *   1) data-theme-pack="{id}"     — 让 CSS 文件可挂钩特殊视觉
 *   2) data-theme="{light|dark}"   — 沿用 base.css 的明暗规则
 *   3) 注入 CSS 变量到 :root.style (所有内置包统一走数据驱动)
 *   4) 壁纸: --wallpaper-image 变量, body::before 消费
 *
 * 关键设计:
 *   - 注入到 :root 的 inline style, 优先级最高
 *   - 老的 data-theme-preset 只做迁移兜底, 运行时一律清掉避免旧 CSS 误激活
 *   - 切换时先清掉旧 pack 设的 vars (避免残留)
 * ============================================================ */

import type { ThemePack, ThemePackTokens } from './types';

/* token key → CSS 变量名映射 (全套) */
const TOKEN_TO_VAR: Array<[keyof ThemePackTokens, string]> = [
  ['bgCanvas',    '--neox-bg-canvas'],
  ['bgPanel',     '--neox-bg-panel'],
  ['bgCard',      '--neox-bg-card'],
  ['bgElevated',  '--neox-bg-elevated'],
  ['bgMuted',     '--neox-bg-muted'],
  ['bgHover',     '--neox-bg-hover'],
  ['bgSunken',    '--neox-bg-sunken'],

  ['primary900',  '--neox-primary-900'],
  ['primary800',  '--neox-primary-800'],
  ['primary700',  '--neox-primary-700'],
  ['primary600',  '--neox-primary-600'],
  ['primary500',  '--neox-primary-500'],
  ['primary400',  '--neox-primary-400'],
  ['primary300',  '--neox-primary-300'],
  ['primary200',  '--neox-primary-200'],
  ['primary100',  '--neox-primary-100'],
  ['primary50',   '--neox-primary-50'],
  ['primary25',   '--neox-primary-25'],
  ['primaryRing', '--neox-primary-ring'],

  ['fgPrimary',   '--neox-fg-primary'],
  ['fgSecondary', '--neox-fg-secondary'],
  ['fgMuted',     '--neox-fg-muted'],
  ['fgHint',      '--neox-fg-hint'],
  ['fgInvert',    '--neox-fg-invert'],
  ['fgCode',      '--neox-fg-code'],

  ['line',        '--neox-line'],
  ['lineSoft',    '--neox-line-soft'],
  ['lineStrong',  '--neox-line-strong'],
  ['lineSubtle',  '--neox-line-subtle'],

  ['warn',        '--neox-warn'],
  ['warnSoft',    '--neox-warn-soft'],
  ['warnInk',     '--neox-warn-ink'],
  ['err',         '--neox-err'],
  ['errSoft',     '--neox-err-soft'],
  ['errInk',      '--neox-err-ink'],
  ['ok',          '--neox-ok'],
  ['okSoft',      '--neox-ok-soft'],
  ['okInk',       '--neox-ok-ink'],

  ['glassBg',     '--glass-bg'],
  ['glassBorder', '--glass-border'],
  ['cardBg',      '--card-bg'],
  ['cardBorder',  '--card-border'],

  ['shadow1',     '--neox-shadow-1'],
  ['shadow2',     '--neox-shadow-2'],
  ['shadow3',     '--neox-shadow-3'],
];

/* 同时把一些 legacy CSS 还在用的变量也派生过去 (text-accent / border-accent / accent-{50..900}) */
const LEGACY_VAR_MAP: Array<[keyof ThemePackTokens, string]> = [
  ['primary600',  '--text-accent'],
  ['primary600',  '--accent-500'],
  ['primary500',  '--accent-400'],
  ['primary700',  '--accent-600'],
  ['primary800',  '--accent-700'],
  ['primary900',  '--accent-800'],
  ['primary400',  '--accent-300'],
  ['primary300',  '--accent-200'],
  ['primary200',  '--accent-100'],
  ['primary100',  '--accent-50'],
  ['primary600',  '--text-accent'],
  ['bgCanvas',    '--bg-primary'],
  ['bgPanel',     '--bg-secondary'],
  ['bgElevated',  '--bg-elevated'],
  ['bgHover',     '--bg-hover'],
  ['fgPrimary',   '--text-primary'],
  ['fgSecondary', '--text-secondary'],
  ['fgMuted',     '--text-tertiary'],
  ['fgHint',      '--text-muted'],
  ['line',        '--border-default'],
  ['lineSubtle',  '--border-subtle'],
  ['shadow2',     '--shadow-md'],
  ['shadow1',     '--shadow-sm'],
  ['shadow3',     '--shadow-lg'],
];

/* 记下我们设过的所有变量, 切换时清掉 (避免上一个 pack 的色残留) */
const APPLIED_VARS = new Set<string>([
  ...TOKEN_TO_VAR.map(([, v]) => v),
  ...LEGACY_VAR_MAP.map(([, v]) => v),
  '--glass-blur',
  '--glass-saturate',
  '--wallpaper-image',
  '--theme-pack-overlay',
]);

/* 清掉 :root 上所有我们注入过的 inline CSS 变量 */
const clearInlineVars = (el: HTMLElement) => {
  for (const v of APPLIED_VARS) el.style.removeProperty(v);
};

/* 应用一个 data-driven pack 的 tokens 到 :root */
const injectTokens = (el: HTMLElement, tokens: ThemePackTokens) => {
  /* important: 压过 theme-packs.css 里 :root[data-theme-pack][data-theme=dark]
   * 的 --neox-bg-canvas:#111216 !important, 否则暮云青/海月等彩暗色全被洗成同灰. */
  for (const [k, varName] of TOKEN_TO_VAR) {
    const val = tokens[k];
    if (val != null) el.style.setProperty(varName, String(val), 'important');
  }
  for (const [k, varName] of LEGACY_VAR_MAP) {
    const val = tokens[k];
    if (val != null) el.style.setProperty(varName, String(val), 'important');
  }
};

/* 主入口 — 给定 pack, 一行应用 (所有包统一走数据驱动管线) */
export const applyThemePack = (pack: ThemePack): void => {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;

  /* 清旧 inline vars, 避免上一个包的色残留 */
  clearInlineVars(root);
  /* legacy 时代设过的 data-theme-preset 一律清除, 防止老 CSS 文件 (如还存在) 误激活 */
  root.removeAttribute('data-theme-preset');
  root.removeAttribute('data-theme-wallpaper');

  /* 1. 数据属性 */
  root.setAttribute('data-theme-pack', pack.id);
  root.setAttribute('data-theme', pack.mode);
  root.setAttribute('data-theme-wallpaper', pack.wallpaper?.kind ?? 'none');

  /* 2. 注入 tokens */
  if (pack.tokens) injectTokens(root, pack.tokens);

  /* 3. 玻璃参数 */
  root.style.setProperty('--glass-blur', `${pack.glass.blur}px`);
  root.style.setProperty('--glass-saturate', `${pack.glass.saturate}%`);

  /* 4. 壁纸 + pattern */
  if (pack.wallpaper) {
    root.style.setProperty('--wallpaper-image', pack.wallpaper.value);
    if (pack.wallpaper.overlay) {
      root.style.setProperty('--theme-pack-overlay', pack.wallpaper.overlay);
    }
  }

  try {
    window.dispatchEvent(new CustomEvent('neox:theme-pack-applied', {
      detail: { packId: pack.id, mode: pack.mode },
    }));
  } catch { /* non-browser / 测试环境 */ }
};

