/**
 * design/tokens — Neox 幻灯片设计系统的原子值.
 *
 * 一处改, 全 deck 生效. 换主题就是换 tokens, 不用改模板.
 *
 * 默认主题 = "Warm Editorial" · 暖调编辑风:
 *   温暖米白纸 + 深沉墨色 + 一抹亚洲赤陶橙, 视觉沉着不喧宾夺主.
 *   适合旅游 / 生活方式 / 品牌手册 / 深度报告.
 *
 * 其它内置主题在 THEMES 里, 用 applyTheme() 切换.
 */

export interface NeoxTheme {
  /** 主题标识, 展示层可用 */
  id: string;
  name: string;
  /** 12 色调色板 */
  palette: {
    /** 纸底 — slide 主背景 */
    paper: string;
    /** 墨色 — 主要正文/标题色 */
    ink: string;
    /** 次墨 — 次级文字, 辅助注释 */
    muted: string;
    /** 边界 — 极浅分割线 / border */
    subtle: string;
    /** 主强调色 — accent bar / kicker / 主 CTA */
    accent: string;
    /** 强调色 - 浅版 (halo/highlight) */
    accentSoft: string;
    /** 强调色 - 深版 (hover/press) */
    accentDeep: string;
    /** 状态色 */
    ok: string;
    warn: string;
    danger: string;
    /** 反白色 — 深色底上的文字 */
    onInk: string;
    /** 卡背 — 比 paper 略暖/略灰的卡片背景 */
    surface: string;
  };
  /** 字体家族. 中英分排 + 衬线/无衬线配对 · 杂志编辑感 (扩) */
  fonts: {
    /** 大字 hero / 主标题 — 拉丁部分. Editorial 主题走衬线 (Georgia/Playfair) 更"杂志味" */
    displayLatin: string;
    /** 大字 hero / 主标题 — 中文部分. 优先 Source Han Serif / Songti 衬线 (跟英文衬线呼应) */
    displayEast: string;
    /** 正文 / 小字 — 拉丁部分. 无衬线 (Inter / Helvetica / SF Pro) 可读性最好 */
    textLatin: string;
    /** 正文 / 小字 — 中文部分. 无衬线 (PingFang SC / Source Han Sans) */
    textEast: string;
    /** 等宽数字 · KPI / 表格 — Latin 用 SF Mono / JetBrains Mono, 数字自带 tabular figures */
    numeric: string;
    /** 代码块 */
    mono: string;

    /** ---- 兼容旧 API (前) · 内部字段, 别再新用. builder/primitives 已迁到上面. */
    display?: string;
    text?: string;
  };
}

/** 默认主题: Warm Editorial */
export const WARM_EDITORIAL: NeoxTheme = {
  id: 'warm-editorial',
  name: 'Warm Editorial',
  palette: {
    paper: '#FAF7F1',
    ink: '#1D2A2F',
    muted: '#6B7280',
    subtle: '#D6D3CB',
    accent: '#C05621',
    accentSoft: '#FDE68A',
    accentDeep: '#7B3510',
    ok: '#059669',
    warn: '#D97706',
    danger: '#DC2626',
    onInk: '#F9FAFB',
    surface: '#F5F1E8',
  },
  fonts: {
    /* Editorial 主题走衬线 hero. 拉丁 Didot (macOS 原生高反差衬线 — 声明的字体必须
     * 真实存在, 否则 WPS/Keynote 的替换不可控, 精准测量也失去意义.  换) */
    displayLatin: 'Didot',
    displayEast: 'Songti SC',
    /* 正文无衬线. 拉丁 Inter · 中文 PingFang SC */
    textLatin: 'Helvetica Neue',
    textEast: 'PingFang SC',
    /* 数字等宽, 有 tabular figures */
    numeric: 'Menlo',
    mono: 'Menlo',
    /* legacy fallback */
    display: 'PingFang SC',
    text: 'PingFang SC',
  },
};

/** 冷调编辑风: Slate Modern */
export const SLATE_MODERN: NeoxTheme = {
  id: 'slate-modern',
  name: 'Slate Modern',
  palette: {
    paper: '#F8FAFC',
    ink: '#0F172A',
    muted: '#64748B',
    subtle: '#E2E8F0',
    accent: '#4F46E5',
    accentSoft: '#C7D2FE',
    accentDeep: '#3730A3',
    ok: '#10B981',
    warn: '#F59E0B',
    danger: '#EF4444',
    onInk: '#F1F5F9',
    surface: '#FFFFFF',
  },
  fonts: {
    /* Slate 走"当代科技编辑"感 · 拉丁全无衬线 · 强弱对比在字重 */
    displayLatin: 'Helvetica Neue',
    displayEast: 'PingFang SC',
    textLatin: 'Helvetica Neue',
    textEast: 'PingFang SC',
    numeric: 'Menlo',
    mono: 'Menlo',
    display: 'PingFang SC',
    text: 'PingFang SC',
  },
};

/** 深色沉浸: Midnight */
export const MIDNIGHT: NeoxTheme = {
  id: 'midnight',
  name: 'Midnight',
  palette: {
    paper: '#0F172A',
    ink: '#F1F5F9',
    muted: '#94A3B8',
    subtle: '#334155',
    accent: '#F59E0B',
    accentSoft: '#FEF3C7',
    accentDeep: '#B45309',
    ok: '#34D399',
    warn: '#FBBF24',
    danger: '#F87171',
    onInk: '#0F172A',
    surface: '#1E293B',
  },
  fonts: {
    /* Midnight 走"夜晚沉浸"感 · 拉丁走 sans-serif 但字重更粗, 中文正文 */
    displayLatin: 'Helvetica Neue',
    displayEast: 'PingFang SC',
    textLatin: 'Helvetica Neue',
    textEast: 'PingFang SC',
    numeric: 'Menlo',
    mono: 'Menlo',
    display: 'PingFang SC',
    text: 'PingFang SC',
  },
};

export const THEMES: Record<string, NeoxTheme> = {
  'warm-editorial': WARM_EDITORIAL,
  'slate-modern': SLATE_MODERN,
  'midnight': MIDNIGHT,
};

/** 类型: 每个"排版角色"的完整规格 (字号 + 字重 + 字距 + 字体角色). 模板一律引这个, 不手写数值. */
export interface TypeSpec {
  fontSize: number; /* pt */
  weight: 400 | 500 | 600 | 700 | 900;
  letterSpacingPt?: number;
  /** 是否用 display 字体家族 (大字/标题) — 否则用 text (正文). 兼容旧代码 */
  display?: boolean;
  /**
   * 字体角色 (加): 决定 latin/east 分别用 theme.fonts 里的哪个字段.
   *  - 'display'  → displayLatin + displayEast (标题/hero, 常见衬线)
   *  - 'text'     → textLatin + textEast (正文/kicker, 无衬线)
   *  - 'numeric'  → numeric (等宽数字, KPI)
   * 缺省时看 display bool 走旧路径.
   */
  fontRole?: 'display' | 'text' | 'numeric';
}

/** Typography scale · CJK 友好，默认值适配 1280x720 版式。
 * 默认 h1、body 和 caption 分别使用至少 36pt、18pt 和 14pt，保证投影场景下的可读性。 */
export const TYPE = {
  /** "眉标" 小写大写字距扩展 (会自动转 upperCase 展示). 硬性 tag/label 14pt 下限 */
  kicker:      { fontSize: 14, weight: 600, letterSpacingPt: 2.4, display: false, fontRole: 'text' } as TypeSpec,
  /** 巨型标题 · cover / hero */
  hero:        { fontSize: 60, weight: 700, letterSpacingPt: -0.5, display: true, fontRole: 'display' } as TypeSpec,
  /** 大标题 · section title (slide title) — 硬性 35pt 下限, 取 36 稳过 */
  h1:          { fontSize: 36, weight: 700, letterSpacingPt: -0.2, display: true, fontRole: 'display' } as TypeSpec,
  /** 中标题 · 卡片标题 / callout header — 硬性 24pt 下限, 取 26 稳过 */
  h2:          { fontSize: 26, weight: 600, display: true, fontRole: 'display' } as TypeSpec,
  /** 小标题 · 次级 label · 卡片 title */
  h3:          { fontSize: 20, weight: 600, display: false, fontRole: 'text' } as TypeSpec,
  /** 强调正文 · 大版本 */
  bodyLarge:   { fontSize: 20, weight: 400, display: false, fontRole: 'text' } as TypeSpec,
  /** 正文 — 硬性 16pt 下限, 取 18 稳过 */
  body:        { fontSize: 18, weight: 400, display: false, fontRole: 'text' } as TypeSpec,
  /** 副文/说明字 · caption / hint — 允许比 body 略小, 但不能 <14pt */
  caption:     { fontSize: 14, weight: 500, letterSpacingPt: 0.3, display: false, fontRole: 'text' } as TypeSpec,
  /** 极小注释/水印 · page number / footer 用, 会被 inspect 豁免 */
  overline:    { fontSize: 11, weight: 500, letterSpacingPt: 1.5, display: false, fontRole: 'text' } as TypeSpec,
  /** 数字大字 · KPI 卡 · 用 numeric 字体家族 (等宽 tabular figures) */
  numeric:     { fontSize: 56, weight: 700, letterSpacingPt: -1, display: true, fontRole: 'numeric' } as TypeSpec,
  /** 引言 · 大字斜体, 常用于 quote page */
  pullQuote:   { fontSize: 32, weight: 400, display: true, fontRole: 'display' } as TypeSpec,
  /** 宣言 · 更极端大字 (manifesto 模板用) */
  manifesto:   { fontSize: 80, weight: 900, letterSpacingPt: -1, display: true, fontRole: 'display' } as TypeSpec,
} as const;

/** 8-based 空间尺度 · px. 4 为最小步长 (为小 icon 微调). */
export const SPACE = {
  xs: 4,
  s: 8,
  m: 12,
  base: 16,
  l: 24,
  xl: 32,
  xxl: 48,
  huge: 64,
  massive: 96,
} as const;

/** 圆角尺度 · px. */
export const RADII = {
  none: 0,
  sm: 6,
  md: 12,
  lg: 20,
  pill: 999,
} as const;

/** 页边距：每张 slide 内容区的默认 padding，保持顶栏和底栏留白协调。 */
export const PAGE = {
  padH: 72,   /* 左右边距 */
  padTop: 56, /* 顶部边距 */
  padBottom: 48, /* 底部边距 (含 footer 高) */
  footerH: 32,
  gutter: 24, /* 卡片/列之间的间隔 */
} as const;

/**
 * 12 列显式网格 . 布局工具用这个转"想放第 X 列到第 Y 列"为像素坐标.
 * gridPx(slideWidth, col, span) 返回该列组的 { left, width }.
 *
 * 视觉设计: 12 列每列 88px + gutter 8px, 总宽 = 12*88 + 11*8 + PAGE.padH*2 = 1240px, 稍小于 1280
 *   (剩余留白平均落到左右外边距).
 */
export const GRID = {
  columns: 12,
  /** 列间距 · 稍窄的 gutter · 8px */
  gutter: 8,
} as const;

/** 12 列 grid 定位 · col 1-indexed. span 是横跨几列. 只算 x + width, 高度调用方定. */
export function gridCol(slideWidth: number, col: number, span: number = 1): { left: number; width: number } {
  const innerW = slideWidth - PAGE.padH * 2;
  const colW = (innerW - GRID.gutter * (GRID.columns - 1)) / GRID.columns;
  const left = PAGE.padH + (col - 1) * (colW + GRID.gutter);
  const width = span * colW + (span - 1) * GRID.gutter;
  return { left, width };
}

/** 三分法 · rule of thirds. 常用于把视觉焦点放到 1/3 或 2/3 位置. */
export function ruleOfThirds(slideDim: number, third: 1 | 2 | 3): number {
  return (slideDim / 3) * third;
}

/** 黄金比例 · Golden ratio 0.618 · 视觉最舒服的不对称切分. */
export function goldenSplit(slideDim: number): { major: number; minor: number } {
  const phi = 0.618;
  return { major: slideDim * phi, minor: slideDim * (1 - phi) };
}

/**
 * pt → CSS px (@ 96 DPI) · 1pt = 96/72 = 1.3333 px.
 * 所有文本 metric 都通过此函数换算，避免将 pt 直接当作 px 使用。
 */
export function ptToCssPx(pt: number): number {
  return pt * (96 / 72);
}

/**
 * 估算文本布局的 lineH 和 charWidth (CSS px) · 给 renderBody 类函数用.
 * 覆盖中英混排 · 数字紧凑 · display 衬线宽. 字宽系数按类型分.
 */
export function textMetrics(fontPt: number, opts?: { charKind?: 'cjk' | 'ascii' | 'mixed' | 'numeric' }): {
  lineH: number;
  charWidth: number;
} {
  const px = ptToCssPx(fontPt);
  const lineH = px * 1.55; /* 1.55 是 CJK+ASCII 混排常用行高比 */
  const factorMap = { cjk: 1.0, ascii: 0.55, mixed: 0.75, numeric: 0.55 };
  const factor = factorMap[opts?.charKind ?? 'mixed'];
  return { lineH, charWidth: px * factor };
}

/**
 * 将 kicker 文本处理成"小写字母全部大写"的展示形式. 中文保持原样.
 * kicker 视觉规则: 英文全大写 + 大字距, 中文原样 (中文全角字符自带足够密度).
 */
export function kickerCase(text: string): string {
  return text.replace(/[a-z]/g, (c) => c.toUpperCase());
}
