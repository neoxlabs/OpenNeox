/* ============================================================
 * 超级调色盘 (Theme Pack) — 类型定义
 *
 * 一个 ThemePack 是产品级"主题包": 用户挑卡片不调参数, 同时绑死
 *   surface (canvas/panel/card)
 *   accent (primary + hover + fg)
 *   text (primary/secondary/muted)
 *   wallpaper (gradient/mesh/image, 玻璃层下面的视觉底)
 *   glass (blur + saturate + opacity)
 *
 * 16 张内置包 + 4 类 + N 张用户自定义包, 详见 内部设计文档
 * ============================================================ */

/* 5 大分类 — UI 上每类一排卡片 */
export type ThemePackCategory =
  | 'basic'     // 基础   — 默认浅/暗, 干净无图, 干活专用
  | 'classic'   // 经典   — 不会出错的默认选择
  | 'ink'       // 水墨国风 — 高级东方美学
  | 'aurora'    // 晨昏   — 治愈系渐变
  | 'cyber';    // 赛博   — 极客 / 夜猫子专属

export type ThemePackSource = 'data';

/* 包的明暗基调 — 决定 [data-theme] 属性 + 默认 text 对比规则 */
export type ThemePackMode = 'light' | 'dark';

/* 壁纸: 玻璃层下面的"底" */
export interface ThemePackWallpaper {
  kind: 'solid' | 'gradient' | 'mesh' | 'image';
  value: string;          // CSS color / gradient 字符串 / SVG data URL / asset path
  overlay?: string;       // 可选叠加图案 (樱花/水墨笔触, 5-10% opacity)
}

/* 派生后的完整 token 集合 — 一一对应 CSS var (--neox-*) */
export interface ThemePackTokens {
  // Surface
  bgCanvas: string;       // 主背景 (chat / IDE editor 底)
  bgPanel: string;        // sidebar / 次级面板
  bgCard: string;         // 卡片 / 输入框 —— **半透明**, 靠壁纸透出来做玻璃
  bgElevated: string;
  bgMuted: string;        // tag / chip 软底
  bgHover: string;
  bgSunken: string;       // 凹陷 / 代码块底

  // Accent (强调) — 完整 ramp 一次给齐, 派生函数自动生成
  primary900: string;
  primary800: string;
  primary700: string;
  primary600: string;
  primary500: string;
  primary400: string;
  primary300: string;
  primary200: string;
  primary100: string;
  primary50: string;
  primary25: string;
  primaryRing: string;    // rgba 形式, 用于 focus ring

  // Text
  fgPrimary: string;
  fgSecondary: string;
  fgMuted: string;
  fgHint: string;
  fgInvert: string;       // accent 上的前景
  fgCode: string;         // 代码强调字

  // Lines / Borders
  line: string;
  lineSoft: string;
  lineStrong: string;
  lineSubtle: string;

  // Semantic (语义色) — 三档全色 + ink
  warn: string;       warnSoft: string;       warnInk: string;
  err: string;        errSoft: string;        errInk: string;
  ok: string;         okSoft: string;         okInk: string;

  // Glass surface (玻璃面板用)
  glassBg: string;        // rgba (半透明)
  glassBorder: string;    // rgba
  cardBg: string;
  cardBorder: string;

  // Shadow
  shadow1: string;
  shadow2: string;
  shadow3: string;
}

/* 用户面向的"源色" — 写 pack 时只给这一组, expandPack() 自动派生全套 tokens.
 * 这是 pack 定义的极简表面 (16 包总共 ~150 个色值, 不是 16×40). */
export interface ThemePackSeed {
  mode: ThemePackMode;
  // 5 个真正需要设计师选的源色
  canvas: string;         // 主背景
  accent: string;         // 强调色 (按钮/链接/选中)
  textPrimary: string;    // 主文本
  // 可选: 不给则按 mode 派生
  panel?: string;
  card?: string;
}

/* 一个完整的主题包 */
export interface ThemePack {
  id: string;
  name: { zh: string; en: string };
  tagline: { zh: string; en: string };        // 一句话副标题, 卡片底部
  category: ThemePackCategory;
  source: ThemePackSource;
  mode: ThemePackMode;

  /* legacy-css pack 不需要 tokens (CSS 文件自己定); data pack 必须有 */
  seed?: ThemePackSeed;
  tokens?: ThemePackTokens;                   // 派生缓存, 也允许手动覆盖任意键

  wallpaper?: ThemePackWallpaper;

  glass: {
    blur: number;          // px
    saturate: number;      // %
    opacity: number;       // 0-1
  };

  /* 卡片预览三色条 (UI 用) */
  swatch: [string, string, string];

  /* 是否用户自定义 (来自 HSL picker), 可删除可重命名 */
  isCustom?: boolean;
}

/* ===== 不变量 (invariants) — 测试守住 =====
 *   - text.primary vs surface.canvas 对比度 ≥ 4.5 (WCAG AA)
 *   - glass.blur ∈ [8, 16] — 上限 16 防 GPU tile memory 爆 (沉淀过的性能 patch)
 *   - dark 模式下 surface RGB 必须 R=G=B 中性灰 (沉淀经验: 蓝偏会被读成"还是发蓝")
 */
