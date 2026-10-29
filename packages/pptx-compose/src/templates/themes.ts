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
  panel?: string;
  onPanel?: string;
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
  fonts: {
    displayLatin: 'Avenir Next',
    displayEast: 'PingFang SC',
    textLatin: 'Helvetica Neue',
    textEast: 'PingFang SC',
    numeric: 'Avenir Next',
  },
};

/** Elegant Editorial · 优雅暗色 · 适合品牌手册 / 深度报告 */
export const ELEGANT_EDITORIAL: NeoxComposeTheme = {
  id: 'elegant-editorial',
  name: 'Elegant Editorial',
  paper: '#F5F0E8',
  ink: '#2A1F1A',
  muted: '#7C664C',
  subtle: '#E5DDD0',
  accent: '#8B0000',
  accentSoft: '#F4E4E4',
  accentDeep: '#4A0000',
  onInk: '#F5F0E8',
  surface: '#EBE5D8',
  fonts: {
    displayLatin: 'Didot',
    displayEast: 'Songti SC',
    textLatin: 'Helvetica Neue',
    textEast: 'PingFang SC',
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
  fonts: {
    displayLatin: 'Georgia',
    displayEast: 'Kaiti SC',
    textLatin: 'Helvetica Neue',
    textEast: 'PingFang SC',
    numeric: 'Avenir Next',
  },
};

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

export const FRESH_GREEN: NeoxComposeTheme = {
  id: 'fresh-green',
  name: 'Fresh Green',
  paper: '#F7FBF6',
  ink: '#14322A',
  muted: '#4F6B5E',
  subtle: '#DCEADF',
  accent: '#1F8A5B',
  accentSoft: '#D8F0E3',
  accentDeep: '#0F5C3C',
  onInk: '#F6FBF7',
  surface: '#EDF6EF',
  /* 标题走圆体 (和 capsule 形态同源), 正文走黑体保可读; 数字用几何无衬线,
   * 避免等宽字体把 "1" 占满一格、数字和单位之间空一大截。 */
  fonts: {
    displayLatin: 'Avenir Next',
    displayEast: 'Yuanti SC',
    textLatin: 'Helvetica Neue',
    textEast: 'PingFang SC',
    numeric: 'Avenir Next',
  },
};

export const TECH_DARK: NeoxComposeTheme = {
  id: 'tech-dark',
  name: 'Tech Dark',
  paper: '#0E1420',
  ink: '#E8F0FA',
  muted: '#9FB0C9',
  subtle: '#22314A',
  accent: '#38BDF8',
  accentSoft: '#16394A',
  accentDeep: '#0B6E8F',
  onInk: '#0A1018',
  surface: '#141C2B',
  /* 深色底上的"反色块"取比纸底更浅一层的蓝灰, 不是 ink (ink 是浅字色 ——
   * 拿它当底色会画出一块刺眼的白板)。 */
  panel: '#1B2740',
  onPanel: '#E8F0FA',
  /* 标题拉丁用几何无衬线 (Avenir Next), 正文换中性无衬线, 层级靠骨架差而不是字号;
   * 中文标题用 Hiragino Sans GB, 和正文 PingFang 拉开一点字面差。 */
  fonts: {
    displayLatin: 'Avenir Next',
    displayEast: 'Hiragino Sans GB',
    textLatin: 'Helvetica Neue',
    textEast: 'PingFang SC',
    numeric: 'Avenir Next',
  },
};

export const MEDICAL_TEAL: NeoxComposeTheme = {
  id: 'medical-teal',
  name: 'Medical Teal',
  paper: '#FFFFFF',
  ink: '#10333F',
  muted: '#4E6B75',
  subtle: '#DCE8EB',
  accent: '#0E7C86',
  accentSoft: '#D6EFF2',
  accentDeep: '#07535A',
  onInk: '#F7FCFC',
  surface: '#F1F7F8',
  fonts: {
    displayLatin: 'Avenir Next',
    displayEast: 'PingFang SC',
    textLatin: 'Helvetica Neue',
    textEast: 'PingFang SC',
    numeric: 'Avenir Next',
  },
};

export const GOV_RED: NeoxComposeTheme = {
  id: 'gov-red',
  name: 'Gov Red',
  paper: '#FCF9F4',
  ink: '#2B1416',
  muted: '#6B5A57',
  subtle: '#EADFD4',
  accent: '#A81C1C',
  accentSoft: '#F6DCDC',
  accentDeep: '#6E0F0F',
  onInk: '#FFF8F2',
  surface: '#F6EFE6',
  fonts: {
    displayLatin: 'Georgia',
    displayEast: 'Songti SC',
    textLatin: 'Helvetica Neue',
    textEast: 'PingFang SC',
    numeric: 'Avenir Next',
  },
};

export const MONO_MINIMAL: NeoxComposeTheme = {
  id: 'mono-minimal',
  name: 'Mono Minimal',
  paper: '#FFFFFF',
  ink: '#111111',
  muted: '#5A5A5A',
  subtle: '#E6E6E6',
  accent: '#2B2B2B',
  accentSoft: '#F0F0F0',
  accentDeep: '#000000',
  onInk: '#FFFFFF',
  surface: '#F6F6F6',
  fonts: {
    displayLatin: 'Didot',
    displayEast: 'Songti SC',
    textLatin: 'Helvetica Neue',
    textEast: 'PingFang SC',
    numeric: 'Helvetica Neue',
  },
};

export const ACADEMIC_INK: NeoxComposeTheme = {
  id: 'academic-ink',
  name: 'Academic Ink',
  paper: '#FBFAF7',
  ink: '#1B1A22',
  muted: '#5D5A6B',
  subtle: '#E3DED3',
  accent: '#4A3B78',
  accentSoft: '#E8E3F2',
  accentDeep: '#2E2450',
  onInk: '#F8F6FC',
  surface: '#F4F1EC',
  fonts: {
    displayLatin: 'Times New Roman',
    displayEast: 'Songti SC',
    textLatin: 'Helvetica Neue',
    textEast: 'PingFang SC',
    numeric: 'Georgia',
  },
};

export const THEMES: Record<string, NeoxComposeTheme> = {
  'warm-editorial': WARM_EDITORIAL,
  'blue-corporate': BLUE_CORPORATE,
  'elegant-editorial': ELEGANT_EDITORIAL,
  'bold-modern': BOLD_MODERN,
  'navy-gold': NAVY_GOLD,
  'fresh-green': FRESH_GREEN,
  'tech-dark': TECH_DARK,
  'medical-teal': MEDICAL_TEAL,
  'gov-red': GOV_RED,
  'mono-minimal': MONO_MINIMAL,
  'academic-ink': ACADEMIC_INK,
};

/** 主题 hint · 给 agent 用 · 每主题合适场景 */
export const THEME_HINTS = {
  'warm-editorial': '旅行 / 生活方式 / 品牌手册 / 深度报告 · 温暖沉着不喧宾',
  'blue-corporate': '商务汇报 / 产品发布 / 企业 pitch · 蓝色专业信任感',
  'elegant-editorial': '品牌 / 时尚 / 手工艺 / 复古 · 暗红优雅编辑味',
  'bold-modern': '科技 / 创新 / 年轻品牌 / 潮流 · 强红黑对比现代感',
  'navy-gold': '银行 / 金融 / 年报财报 / 投资者汇报 · 藏青压版, 暗金点睛',
  'fresh-green': '教学课件 / 校园 / 培训 · 清透绿, 轻而亲和',
  'tech-dark': '科技发布 / AI / 云与芯片 · 深色底 + 冷青, 屏幕与发布会',
  'medical-teal': '医院 / 健康 / 临床 / 公共卫生 · 纯白 + 深青, 干净可信',
  'gov-red': '政府 / 机关 / 党建 / 政策汇报 · 中国红 + 宋体, 公文感',
  'mono-minimal': '提案 / 作品集 / 极简高级感 · 只有黑白灰',
  'academic-ink': '论文答辩 / 课题汇报 / 研究报告 · 衬线标题 + 墨紫强调',
};
