import type { ThemePreset } from '../../state/appStore';

/* ============================================================
 * 按主题取品牌素材 (logo / 字标)
 *   字标在 assets/icons/brand/<preset>/wordmark.png; logo 各主题共用 brand/mark-color.png
 *   缺图时运行时 onError 自动回退到 chenguang.
 * ============================================================ */
const BASE = `${import.meta.env.BASE_URL}icons/brand`;
const BASE_ICONS = `${import.meta.env.BASE_URL}icons`;
const LOCKUP_BASE = `${import.meta.env.BASE_URL}brand`;
export const BRAND_FALLBACK_PRESET: ThemePreset = 'chenguang';
/* 破缓存: URL 不变时 Electron 会缓存旧 PNG, 换了素材也不重新拉. 改素材后 bump 这个版本号即可. */
const V = '20261022a';

export const brandLogoUrl = (_preset: ThemePreset): string => `${LOCKUP_BASE}/mark-ring.webp?v=${V}`;
export const brandWordmarkUrl = (preset: ThemePreset): string =>
  `${BASE}/${preset === 'liuli' ? 'chenguang' : preset}/wordmark.png?v=${V}`;

export const brandWordmarkWhiteUrl = (): string => `${BASE_ICONS}/neox-wordmark-white.png?v=${V}`;

/** vortex + neox 横版 lockup — About / 账户 hero 等用. 按明暗底选 light/dark. */
export const brandLockupUrl = (theme: 'light' | 'dark' = 'dark'): string =>
  `${LOCKUP_BASE}/lockup-${theme}.png?v=${V}`;

export const brandMarkRingUrl = (): string => `${LOCKUP_BASE}/mark-ring.webp?v=${V}`;

/** neox 字标 (原 vortex lockup 去掉 vortex 的右半, 字体不变)。light = 深字给浅底, dark = 白字给深底。 */
export const brandLockupWordmarkUrl = (theme: 'light' | 'dark' = 'dark'): string =>
  `${LOCKUP_BASE}/wordmark-${theme}.png?v=${V}`;

/** <img onError> 回退到默认主题素材 (只回退一次, 防死循环) */
export const onBrandImgError = (kind: 'logo' | 'wordmark') =>
  (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    if (img.dataset.fallback) return;
    img.dataset.fallback = '1';
    img.src = kind === 'logo'
      ? brandLogoUrl(BRAND_FALLBACK_PRESET)
      : brandWordmarkUrl(BRAND_FALLBACK_PRESET);
  };
