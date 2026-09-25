/**
 * themes — compose 主题库 · 4 套编辑级设计系统.
 *
 * 每主题定义颜色 + 字体配对 + 装饰片段 hint. 模板直接读 theme.paper/ink/accent/fonts.
 * agent 用法: `slide.background.fill = theme.paper; render(slide, tree, { theme })`.
 * (未来把 theme 挤进 render opts, 让 slide 内 node 自动读)
 */

export interface NeoxComposeTheme {
  id: string;
  name: string;
  paper: string;
  ink: string;
  muted: string;
  subtle: string;
  accent: string;
  accentSoft: string;
  accentDeep: string;
  onInk: string;
  surface: string;
  fonts: {
    displayLatin: string;
    displayEast: string;
    textLatin: string;
    textEast: string;
    numeric: string;
  };
}

/** 默认 · Warm Editorial · 暖色米底 + 亚洲赤陶橙 · 适合旅行 / 生活方式 */
export const WARM_EDITORIAL: NeoxComposeTheme = {
  id: 'warm-editorial',
  name: 'Warm Editorial',
  paper: '#FAF7F1',
  ink: '#1D2A2F',
  muted: '#6B7280',
  subtle: '#D6D3CB',
  accent: '#C05621',
  accentSoft: '#FDE68A',
  accentDeep: '#7B3510',
  onInk: '#F9FAFB',
  surface: '#F5F1E8',
  /* 高对比衬线做标题 + 几何人文无衬线做正文 —— 温和叙事的经典配对。
   * 中文标题走圆体: 它跟这套风格的 capsule 圆角形态同源, 亲和度也对得上"温和叙事"。 */
  fonts: {
    displayLatin: 'Didot',
    displayEast: 'Yuanti SC',
    textLatin: 'Avenir Next',
    textEast: 'PingFang SC',
    /* Use proportional numerals so figures and units form a compact group. */
    numeric: 'Avenir Next',
  },
};

/** Blue Corporate · 商务风蓝 · 适合汇报 / 产品发布 / 企业 pitch */
export const BLUE_CORPORATE: NeoxComposeTheme = {
  id: 'blue-corporate',
  name: 'Blue Corporate',
  paper: '#FFFFFF',
  ink: '#0F172A',
  muted: '#64748B',
  subtle: '#E2E8F0',
  accent: '#2563EB',
  accentSoft: '#DBEAFE',
  accentDeep: '#1E40AF',
  onInk: '#F8FAFC',
  surface: '#F1F5F9',
  /* Separate geometric display text from neutral body text to preserve a clear
   * hierarchy while keeping the corporate sans-serif character. */
  fonts: {
    displayLatin: 'Avenir Next',
    displayEast: 'PingFang SC',
    textLatin: 'Helvetica Neue',
    textEast: 'PingFang SC',
    /* Use proportional numerals so values and units fit naturally in cards. */
    numeric: 'Avenir Next',
  },
};

/** Elegant Editorial · 优雅暗色 · 适合品牌手册 / 深度报告 */
export const ELEGANT_EDITORIAL: NeoxComposeTheme = {
  id: 'elegant-editorial',
  name: 'Elegant Editorial',
  paper: '#F5F0E8',
  ink: '#2A1F1A',
  /* Muted text uses a darker warm neutral so small labels remain readable on
   * the paper background. */
  muted: '#7C664C',
  subtle: '#E5DDD0',
  accent: '#8B0000',
  accentSoft: '#F4E4E4',
  accentDeep: '#4A0000',
  onInk: '#F5F0E8',
  surface: '#EBE5D8',
  /* Use an available neutral sans face for body text while the serif display
   * pairing provides the formal editorial hierarchy. */
  fonts: {
    displayLatin: 'Didot',
    displayEast: 'Songti SC',
    textLatin: 'Helvetica Neue',
    textEast: 'PingFang SC',
    /* Use proportional numerals for compact value-and-unit composition. */
    numeric: 'Avenir Next',
  },
};

/** Bold Modern · 强对比现代 · 适合科技 / 创新 / 年轻品牌 */
export const BOLD_MODERN: NeoxComposeTheme = {
  id: 'bold-modern',
  name: 'Bold Modern',
  paper: '#FAFAFA',
  ink: '#0A0A0A',
  muted: '#525252',
  subtle: '#E5E5E5',
  accent: '#EF4444',
  accentSoft: '#FEE2E2',
  accentDeep: '#B91C1C',
  onInk: '#FAFAFA',
  surface: '#F4F4F5',
  /* Pair a dependable serif display face with Kaiti East Asian display text;
   * the body remains a neutral sans for legibility in formal summaries. */
  fonts: {
    displayLatin: 'Georgia',
    displayEast: 'Kaiti SC',
    textLatin: 'Helvetica Neue',
    textEast: 'PingFang SC',
    /* Use proportional numerals so large figures do not create artificial gaps. */
    numeric: 'Avenir Next',
  },
};

/** Navy Gold · 藏青 + 古铜金 · 银行 / 金融 / 年报
 *
 * The navy base carries the page while the copper accent is reserved for
 * focused rules and small highlights. Serif display text keeps the formal
 * document character, and dark-surface labels use the readable accent helper. */
export const NAVY_GOLD: NeoxComposeTheme = {
  id: 'navy-gold',
  name: 'Navy Gold',
  paper: '#FBFAF6',
  ink: '#14233C',
  muted: '#5C6576',
  subtle: '#E2DED3',
  accent: '#8C6A34',
  accentSoft: '#EEE3CF',
  accentDeep: '#5E4520',
  onInk: '#F6F2E9',
  surface: '#F3EFE6',
  fonts: {
    displayLatin: 'Didot',
    displayEast: 'Songti SC',
    textLatin: 'Helvetica Neue',
    textEast: 'PingFang SC',
    numeric: 'Avenir Next',
  },
};

export const THEMES: Record<string, NeoxComposeTheme> = {
  'warm-editorial': WARM_EDITORIAL,
  'blue-corporate': BLUE_CORPORATE,
  'elegant-editorial': ELEGANT_EDITORIAL,
  'bold-modern': BOLD_MODERN,
  'navy-gold': NAVY_GOLD,
};

/** 主题 hint · 给 agent 用 · 每主题合适场景 */
export const THEME_HINTS = {
  'warm-editorial': '旅行 / 生活方式 / 品牌手册 / 深度报告 · 温暖沉着不喧宾',
  'blue-corporate': '商务汇报 / 产品发布 / 企业 pitch · 蓝色专业信任感',
  'elegant-editorial': '品牌 / 时尚 / 手工艺 / 复古 · 暗红优雅编辑味',
  'bold-modern': '科技 / 创新 / 年轻品牌 / 潮流 · 强红黑对比现代感',
};
