
import { expandPack } from './expandPack';
/* 壁纸集中在这个模块 —— 极简版构建时由 vite alias 整块换掉 (见 packWallpapers.lite.ts)。 */
import {
  wpLiuli,
  wpChenguang,
  wpNuanyang,
  wpMoye,
  wpMuyunqing,
  wpDianyajin,
  wpDingxiangzi,
  wpChenshazhu,
  wpSongyanmo,
  wpWumoyan,
  wpSakura,
  wpMusanzi,
  wpQingkong,
  wpHaiyue,
  wpNeonlight,
  wpMatrix,
  wpJiguang,
  wpVaporwave,
} from './packWallpapers';
import type { ThemePack, ThemePackSeed, ThemePackTokens } from './types';

/* 一站式构造 data-driven pack */
const buildPack = (args: {
  id: string;
  name: { zh: string; en: string };
  tagline: { zh: string; en: string };
  category: ThemePack['category'];
  seed: ThemePackSeed;
  swatch?: [string, string, string];
  wallpaper?: ThemePack['wallpaper'];
  tokensOverride?: Partial<ThemePackTokens>;
  glass?: Partial<ThemePack['glass']>;
}): ThemePack => {
  const tokens = { ...expandPack(args.seed), ...(args.tokensOverride ?? {}) };
  return {
    id: args.id,
    name: args.name,
    tagline: args.tagline,
    category: args.category,
    source: 'data',
    mode: args.seed.mode,
    seed: args.seed,
    tokens,
    wallpaper: args.wallpaper!,
    glass: { blur: 12, saturate: 180, opacity: 0.78, ...(args.glass ?? {}) },
    swatch: args.swatch ?? [args.seed.canvas, tokens.bgPanel, args.seed.accent],
  };
};

/* ============================================================
 *               16 个内置 pack 集中定义 (全部 data-driven)
 * ============================================================ */

/** 全部 20 张包 (含已下线的)。只给存档迁移查 mode 用, UI 一律用 THEME_PACKS。 */
export const ALL_THEME_PACKS: ThemePack[] = [
  /* ═════════════════ 基础 Basic — 干净无图, 干活专用 (1 light + 1 dark) ═════════════════
   * 给"我就想写代码别花哨"的用户. 纯单色 + 极淡渐变, 不带图片, 不带 pattern.
   * 启动开销最低 (无图加载), 文字对比度最高, 适合长时间专注. */
  buildPack({
    id: 'liulibasic',
    name: { zh: '浅陶',   en: 'Clay' },
    tagline: { zh: '暖纸画布 · 陶土泥板',   en: 'Warm paper and clay' },
    category: 'basic',
    seed: { mode: 'light', canvas: '#f2eee8', accent: '#23211e', textPrimary: '#23211e', panel: '#f2eee8', card: '#fbfaf7' },
    swatch: ['#fbfaf7', '#f2eee8', '#23211e'],
    wallpaper: {
      kind: 'solid',
      value: '#f2eee8',
    },
    tokensOverride: {
      /* 墨色主色阶 —— 与 anye 的银灰阶对称: 暗色"越大越亮", 亮色"越大越深"。
       * 600 是填充主色 (进度条 / 实心按钮 / 选中), 取 #24292f 与 fgPrimary 同色,
       * 于是"强调"读起来就是"更黑", 而不是"另一种颜色"。
       * 700 比 600 更深供 hover/pressed; 500/400 更浅供次级强调。 */
      primary900: '#0e0d0b',
      primary800: '#171512',
      primary700: '#1d1b18',
      primary600: '#23211e',
      primary500: '#4a453f',
      primary400: '#736c63',
      primary300: 'rgba(35, 33, 30, 0.22)',
      primary200: 'rgba(35, 33, 30, 0.16)',
      primary100: 'rgba(35, 33, 30, 0.095)',
      primary50:  'rgba(35, 33, 30, 0.056)',
      primary25:  'rgba(35, 33, 30, 0.04)',
      primaryRing: 'rgba(35, 33, 30, 0.13)',
      bgCanvas: '#f2eee8',
      bgPanel: '#f2eee8',
      bgCard: '#fbfaf7',
      bgElevated: '#fdfcfa',
      bgMuted: 'rgba(60, 45, 25, 0.045)',
      bgHover: 'rgba(60, 45, 25, 0.060)',
      bgSunken: 'rgba(60, 45, 25, 0.035)',
      fgPrimary: '#23211e',
      fgSecondary: '#4a453f',
      fgMuted: '#8a847b',
      fgHint: '#a39c92',
      line: 'rgba(60, 45, 25, 0.100)',
      lineSoft: 'rgba(60, 45, 25, 0.065)',
      lineStrong: 'rgba(60, 45, 25, 0.150)',
      lineSubtle: 'rgba(60, 45, 25, 0.045)',
      glassBg: '#fbfaf7',
      glassBorder: 'rgba(60, 45, 25, 0.080)',
      cardBg: '#fbfaf7',
      cardBorder: 'rgba(60, 45, 25, 0.100)',
      shadow1: '0 1px 2px rgba(60, 45, 25, 0.06)',
      shadow2: '0 1px 2px rgba(60, 45, 25, 0.05), 0 10px 28px rgba(60, 45, 25, 0.07)',
      shadow3: '0 2px 6px rgba(60, 45, 25, 0.06), 0 24px 56px rgba(60, 45, 25, 0.12)',
    },
    glass: { blur: 0, saturate: 100, opacity: 1 },
  }),
  buildPack({
    id: 'anye',
    name: { zh: '夜陶',   en: 'Night Clay' },
    tagline: { zh: '暖炭画布 · 石墨泥板',   en: 'Warm charcoal clay' },
    category: 'basic',
    seed: { mode: 'dark', canvas: '#1b1916', accent: '#d9d2c6', textPrimary: '#ede8e0', panel: '#1b1916', card: '#24211d' },
    swatch: ['#1b1916', '#24211d', '#d9d2c6'],
    wallpaper: {
      kind: 'solid',
      value: '#1b1916',
    },
    tokensOverride: {
      bgCanvas: '#1b1916',
      bgPanel: '#1b1916',
      bgCard: '#24211d',
      bgElevated: '#2a2622',
      bgMuted: '#2c2823',
      bgHover: '#302b26',
      bgSunken: '#161411',
      primary900: '#f6f2ea',
      primary800: '#ede8e0',
      primary700: '#e3ddd2',
      primary600: '#d9d2c6',
      primary500: '#a9a196',
      primary400: '#857e74',
      primary300: 'rgba(245, 238, 226, 0.22)',
      primary200: 'rgba(245, 238, 226, 0.16)',
      primary100: 'rgba(245, 238, 226, 0.095)',
      primary50: 'rgba(245, 238, 226, 0.056)',
      primary25: 'rgba(245, 238, 226, 0.04)',
      primaryRing: 'rgba(245, 238, 226, 0.13)',
      fgPrimary: '#ede8e0',
      fgSecondary: '#cfc8bd',
      fgMuted: '#8f887e',
      fgHint: '#6e685f',
      fgInvert: '#1b1916',
      fgCode: '#e6dfd3',
      line: '#35302a',
      lineSoft: '#2a2622',
      lineStrong: '#4a443c',
      lineSubtle: '#26221e',
      glassBg: '#24211d',
      glassBorder: '#302b26',
      cardBg: '#24211d',
      cardBorder: '#35302a',
      shadow1: '0 1px 2px rgba(0, 0, 0, 0.25)',
      shadow2: '0 1px 2px rgba(0, 0, 0, 0.25), 0 12px 32px rgba(0, 0, 0, 0.30)',
      shadow3: '0 2px 6px rgba(0, 0, 0, 0.30), 0 24px 56px rgba(0, 0, 0, 0.40)',
    },
    glass: { blur: 0, saturate: 100, opacity: 1 },
  }),

  /* ═════════════════ 晨夕 Daily — 日常陪伴 (3 light + 1 dark) ═════════════════ */
  buildPack({
    id: 'liuli',
    name: { zh: '香芋啵啵',   en: 'Taro Bubble' },
    tagline: { zh: '紫蓝粉流光 · 清新香芋',   en: 'Taro bubble dreams' },
    category: 'classic',
    seed: { mode: 'light', canvas: '#bcb0e8', accent: '#7a5cd0', textPrimary: '#1f1f3f', panel: '#a08cd4', card: '#ffffff' },
    swatch: ['#b8a4e8', '#a4b8e8', '#f0b4d0'],
    wallpaper: {
      kind: 'image',
      value: `url("${wpLiuli}")`,
    },
  }),
  buildPack({
    id: 'chenguang',
    name: { zh: '海盐粉荔',   en: 'Sea Salt Lychee' },
    tagline: { zh: '粉蓝清新 · 海盐微咸',   en: 'Pink-blue with sea salt' },
    category: 'classic',
    seed: { mode: 'light', canvas: '#dcc0e0', accent: '#8b48d4', textPrimary: '#241834', panel: '#c4a4d4', card: '#ffffff' },
    swatch: ['#dcb0e0', '#f0c0d4', '#a8c8e0'],
    wallpaper: {
      kind: 'image',
      value: `url("${wpChenguang}")`,
    },
  }),
  buildPack({
    id: 'nuanyang',
    name: { zh: '橘子汽水',   en: 'Orange Soda' },
    tagline: { zh: '橘黄流光 · 心想事橙',   en: 'Orange fizz, wishes bloom' },
    category: 'classic',
    seed: { mode: 'light', canvas: '#f0c098', accent: '#d8702a', textPrimary: '#4f2e0f', panel: '#e0a878', card: '#ffffff' },
    swatch: ['#f4d088', '#f0a888', '#e0708c'],
    wallpaper: {
      kind: 'image',
      value: `url("${wpNuanyang}")`,
    },
  }),
  buildPack({
    id: 'moye',
    name: { zh: '绿豆冰沙',   en: 'Mung Bean Ice' },
    tagline: { zh: '青绿薄荷 · 冰沙清凉',   en: 'Mint mung bean ice' },
    category: 'classic',
    seed: { mode: 'light', canvas: '#a8d4c0', accent: '#3a8b6c', textPrimary: '#102820', panel: '#88c4ac', card: '#ffffff' },
    swatch: ['#b8d8c0', '#a4d4d0', '#bce0a0'],
    wallpaper: {
      kind: 'image',
      value: `url("${wpMoye}")`,
    },
  }),
  buildPack({
    id: 'muyunqing',
    name: { zh: '暮云青',   en: 'Twilight Teal' },
    tagline: { zh: '祖母绿夜 · 长夜办公',   en: 'Emerald night, long hours' },
    category: 'classic',
    seed: { mode: 'dark', canvas: '#1d5340', accent: '#7fdcb0', textPrimary: '#e0ece4', panel: '#205a45', card: '#1f5743' },
    swatch: ['#1f5743', '#1d5340', '#184535'],
    wallpaper: {
      kind: 'image',
      value: `url("${wpMuyunqing}")`,
    },
  }),

  buildPack({
    id: 'dianyajin',
    name: { zh: '典雅金',   en: 'Imperial Gold' },
    tagline: { zh: '宣纸落金 · 章法庄重',   en: 'Gold on rice paper' },
    category: 'ink',
    /* 米金 → 暖卡其, 像晨光打在宣纸边. canvas 提亮一档让卡片更透 */
    seed: { mode: 'light', canvas: '#f5e6c2', accent: '#b8862a', textPrimary: '#3a2f10', panel: '#ead5b0', card: '#fffdf6' },
    swatch: ['#f6e8c4', '#ead5b0', '#b8862a'],
    wallpaper: {
      kind: 'image',
      value: `url("${wpDianyajin}")`,
    },
  }),
  buildPack({
    id: 'dingxiangzi',
    name: { zh: '丁香紫',   en: 'Lilac' },
    tagline: { zh: '暮春紫雾 · 清雅含蓄',   en: 'Late spring lilac' },
    category: 'ink',
    /* 淡丁香 → 烟青. 紫色相 290° → 蓝青 220°, 过渡像云雾散开 */
    seed: { mode: 'light', canvas: '#ebdfec', accent: '#8a55a8', textPrimary: '#2f1f3f', panel: '#d9deec', card: '#ffffff' },
    swatch: ['#ebdfec', '#d9deec', '#8a55a8'],
    wallpaper: {
      kind: 'image',
      value: `url("${wpDingxiangzi}")`,
    },
  }),
  buildPack({
    id: 'chenshazhu',
    name: { zh: '辰砂朱',   en: 'Cinnabar' },
    tagline: { zh: '朱砂晕染 · 印泥鲜活',   en: 'Cinnabar bloom' },
    category: 'ink',
    /* 淡朱 → 奶咖. 比之前柔和很多, 像褪色印章在宣纸上 */
    seed: { mode: 'light', canvas: '#f6dccc', accent: '#b53520', textPrimary: '#3d1410', panel: '#ecd0b8', card: '#ffffff' },
    swatch: ['#f6dccc', '#ecd0b8', '#b53520'],
    wallpaper: {
      kind: 'image',
      value: `url("${wpChenshazhu}")`,
    },
  }),
  buildPack({
    id: 'songyanmo',
    name: { zh: '苍墨',   en: 'Aged Ink' },
    tagline: { zh: '文房深沉 · 老成内敛',   en: 'Studio depth, scholarly calm' },
    category: 'ink',
    /* 深墨 → 焦糖暗. dark 主题色相暖一档, 不再死黑 */
    seed: { mode: 'dark', canvas: '#1c1a16', accent: '#dcc99a', textPrimary: '#e8e4d9', panel: '#2a2820', card: '#26221b' },
    swatch: ['#1f1d18', '#2a2820', '#dcc99a'],
    wallpaper: {
      kind: 'image',
      value: `url("${wpSongyanmo}")`,
    },
  }),
  buildPack({
    id: 'wumoyan',
    name: { zh: '乌墨砚',   en: 'Ink Stone' },
    tagline: { zh: '砚台烟青 · 月光浸染',   en: 'Ink stone in moonlit smoke' },
    category: 'ink',
    seed: { mode: 'dark', canvas: '#1c3a50', accent: '#a8cee0', textPrimary: '#dee8eb', panel: '#1f4258', card: '#1d3e55' },
    swatch: ['#1f4258', '#1c3a50', '#162e40'],
    wallpaper: {
      kind: 'image',
      value: `url("${wpWumoyan}")`,
    },
  }),

  buildPack({
    id: 'sakura',
    name: { zh: '桃桃满满',   en: 'Peach Bloom' },
    tagline: { zh: '桃运满满 · 粉雪奶白',   en: 'Peach to cream' },
    category: 'aurora',
    /* 樱花粉 → 奶油. 色相 345° → 35°, 跨过红色到橙色, 像桃运转奶昔 */
    seed: { mode: 'light', canvas: '#fde2ec', accent: '#d83a78', textPrimary: '#3d1726', panel: '#fdeed4', card: '#ffffff' },
    swatch: ['#fde2ec', '#fde6e0', '#fdeed4'],
    wallpaper: {
      kind: 'image',
      value: `url("${wpSakura}")`,
    },
  }),
  buildPack({
    id: 'musanzi',
    name: { zh: '紫属于你',   en: 'All Purple, Yours' },
    tagline: { zh: '淡紫渡薄荷 · 静谧旷野',   en: 'Purple drift to mint' },
    category: 'aurora',
    /* 淡丁香紫 → 薄荷绿. 色相 295° → 130°, 像 QQ 那张图的薰衣草渡薄荷 */
    seed: { mode: 'light', canvas: '#ede1ec', accent: '#9b4ab2', textPrimary: '#2f1840', panel: '#deecd9', card: '#ffffff' },
    swatch: ['#ede1ec', '#e6e6e2', '#deecd9'],
    wallpaper: {
      kind: 'image',
      value: `url("${wpMusanzi}")`,
    },
  }),
  buildPack({
    id: 'qingkong',
    name: { zh: '蓝以为情',   en: 'Hard to Stay Blue' },
    tagline: { zh: '海蓝渐紫 · 难以为情',   en: 'Blue to lilac, hard to bear' },
    category: 'aurora',
    /* 淡天蓝 → 淡紫. 色相 210° → 270°, 像黄昏从海面退到天边 */
    seed: { mode: 'light', canvas: '#dde9f4', accent: '#3084c0', textPrimary: '#0e2942', panel: '#ebdef0', card: '#ffffff' },
    swatch: ['#dde9f4', '#e4e3f2', '#ebdef0'],
    wallpaper: {
      kind: 'image',
      value: `url("${wpQingkong}")`,
    },
  }),
  buildPack({
    id: 'haiyue',
    name: { zh: '海月寐',   en: 'Sea Moon Sleep' },
    tagline: { zh: '深海月光 · 潮汐粼粼',   en: 'Sleep in moonlit tides' },
    category: 'aurora',
    /* 深海蓝黑 → 暮蓝紫. dark 也要双色, 不要死黑 */
    seed: { mode: 'dark', canvas: '#101a26', accent: '#7fc8d0', textPrimary: '#dbe9ef', panel: '#1c2638', card: '#182634' },
    swatch: ['#14202e', '#172238', '#1a1e3a'],
    wallpaper: {
      kind: 'image',
      value: `url("${wpHaiyue}")`,
    },
  }),

  buildPack({
    id: 'neonlight',
    name: { zh: '夜霓虹',  en: 'Neon Night' },
    tagline: { zh: '紫渡蓝粉 · 雨夜霓虹',   en: 'Purple drifting to pink, rainy night' },
    category: 'cyber',
    /* 深紫 → 烟粉. 290° → 320° */
    seed: { mode: 'dark', canvas: '#1d1532', accent: '#b870e8', textPrimary: '#ece0f5', panel: '#2c2046', card: '#2e1640' },
    swatch: ['#1d1532', '#241638', '#2a1934'],
    wallpaper: {
      kind: 'image',
      value: `url("${wpNeonlight}")`,
    },
  }),
  buildPack({
    id: 'matrix',
    name: { zh: '终端微光',  en: 'Terminal Glow' },
    tagline: { zh: '深绿渡墨 · 机房薄荷',   en: 'Server room dusk, soft mint' },
    category: 'cyber',
    /* 深绿 → 墨. 145° → 165° */
    seed: { mode: 'dark', canvas: '#0f1a18', accent: '#6ed8a8', textPrimary: '#dbf2e6', panel: '#1c2a24', card: '#101e14' },
    swatch: ['#0f1a18', '#101c1a', '#101a14'],
    wallpaper: {
      kind: 'image',
      value: `url("${wpMatrix}")`,
    },
  }),
  buildPack({
    id: 'jiguang',
    name: { zh: '极光',    en: 'Aurora' },
    tagline: { zh: '北极夜空 · 蓝渡青绿',   en: 'Polar sky, blue to teal' },
    category: 'cyber',
    /* 深蓝 → 青绿. 210° → 180° */
    seed: { mode: 'dark', canvas: '#0f1a2c', accent: '#7dd4d0', textPrimary: '#e2efee', panel: '#1c2a42', card: '#1a2438' },
    swatch: ['#0f1a2c', '#101e2e', '#10222c'],
    wallpaper: {
      kind: 'image',
      value: `url("${wpJiguang}")`,
    },
  }),
  buildPack({
    id: 'vaporwave',
    name: { zh: '暮霭',    en: 'Twilight Mist' },
    tagline: { zh: '80s 暮霭 · 紫渡粉',   en: '80s mist, purple to pink' },
    category: 'cyber',
    /* 深紫 → 暗粉. 270° → 320° */
    seed: { mode: 'dark', canvas: '#1f1432', accent: '#d88ad0', textPrimary: '#f0e0ec', panel: '#321e48', card: '#3a1c50' },
    swatch: ['#1f1432', '#26152f', '#2c1530'],
    wallpaper: {
      kind: 'image',
      value: `url("${wpVaporwave}")`,
    },
  }),
];

const VISIBLE_PACK_IDS = new Set(['liulibasic', 'anye']);
export const THEME_PACKS: ThemePack[] = ALL_THEME_PACKS.filter((p) => VISIBLE_PACK_IDS.has(p.id));

/* 默认 pack — 浅陶 */
export const DEFAULT_PACK_ID = 'liulibasic';

export const CATEGORY_INFO: Record<ThemePack['category'], { zh: string; en: string; subtitle: { zh: string; en: string } }> = {
  basic: {
    zh: '基础', en: 'Basic',
    subtitle: { zh: '陶土 · 浅 / 夜', en: 'Clay · light / night' },
  },
  classic: {
    zh: '缤纷时刻', en: 'Vivid Moments',
    subtitle: { zh: '小小画板上映射生活的美好', en: 'A palette of daily moments' },
  },
  ink: {
    zh: '雅韵', en: 'Elegance',
    subtitle: { zh: '笔走纸间的东方雅', en: 'Brush on paper' },
  },
  aurora: {
    zh: '神秘美学', en: 'Mystic',
    subtitle: { zh: '每天一点甜', en: 'A daily sweetness' },
  },
  cyber: {
    zh: '幻彩机核', en: 'Iridescent',
    subtitle: { zh: '永不止境的夜流光', en: 'Endless neon flow' },
  },
};

/* 按分类聚合 — UI 渲染用 */
export const packsByCategory = (packs: ThemePack[] = THEME_PACKS): Record<ThemePack['category'], ThemePack[]> => {
  const out: Record<ThemePack['category'], ThemePack[]> = { basic: [], classic: [], ink: [], aurora: [], cyber: [] };
  for (const p of packs) out[p.category].push(p);
  return out;
};

/* by id 查找。存档里是已下线的包 → 按它的明暗落到浅陶 / 夜陶 (调用方会把新 id 写回存档)。 */
export const findPack = (id: string, packs: ThemePack[] = THEME_PACKS): ThemePack | undefined => {
  const hit = packs.find((p) => p.id === id);
  if (hit || packs !== THEME_PACKS) return hit;
  const retired = ALL_THEME_PACKS.find((p) => p.id === id);
  return retired ? THEME_PACKS.find((p) => p.mode === retired.mode) : undefined;
};
