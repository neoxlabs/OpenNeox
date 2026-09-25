/**
 * StyleSpec — 一份 PPT 的"设计系统冻结件"
 *
 * StyleSpec 是冻结的可执行设计 token 集合。逐页渲染只引用这些 token，避免颜色、字号和圆角漂移。
 */

import type { NeoxComposeTheme } from '../templates/themes.js';
import { WARM_EDITORIAL, BLUE_CORPORATE, ELEGANT_EDITORIAL, BOLD_MODERN, NAVY_GOLD } from '../templates/themes.js';

/**
 * 形态语言 —— 整套 PPT 的"手感", 我认为这是 StyleSpec 里最值钱的一格。
 *
 * 一个 motif 贯穿全篇 = 风格统一; 每页各画各的 = 模板堆砌。
 * 明康那张 WPS 参考图的 motif 就是 chevron: 标题条的斜切、流程箭头、分隔符
 * 全是同一种斜切语言, 所以整页是"一套"的。
 */
export type Motif =
  /** 斜切 —— 箭头 / 楔形 / 斜角卡片。方向感强, 适合流程、进度、增长 */
  | 'chevron'
  /** 丝带 —— 带折角的横幅。仪式感, 适合荣誉、里程碑、党政 */
  | 'ribbon'
  /** 圆润 —— 胶囊 / 大圆角 / 圆点。亲和, 适合教育、医疗、消费品 */
  | 'capsule'
  /** 线性 —— 细线 + 节点。克制, 适合技术、数据、专业服务 */
  | 'line'
  /** 无装饰 —— 纯排版。极简, 适合学术、法律 */
  | 'none';

/** 圆角基准。roundPathCorners 和 roundRect 都吃这组值, 保证全篇一致。 */
export interface RadiusScale {
  /** 小圆角: 标签 / 徽章 / 小图标底 */
  sm: number;
  /** 中圆角: 卡片 / 图片框 */
  md: number;
  /** 大圆角: 胶囊 / 大色块。给 999 表示全圆 */
  lg: number;
  /** 自定义路径磨角用的半径 (custGeom 的拐角) */
  path: number;
}

/** 排版尺度。字号单位 pt, 跟 OOXML 一致。 */
export interface TypeScale {
  display: { size: number; weight: 'bold' | 'regular'; lineHeight: number; tracking: number };
  title: { size: number; weight: 'bold' | 'regular'; lineHeight: number; tracking: number };
  body: { size: number; weight: 'bold' | 'regular'; lineHeight: number; tracking: number };
  caption: { size: number; weight: 'bold' | 'regular'; lineHeight: number; tracking: number };
  /** 大数字 (KPI / 编号) —— 单独一档, 通常用等宽或衬线 */
  numeral: { size: number; weight: 'bold' | 'regular'; lineHeight: number; tracking: number };
}

/** 栅格。所有组件声明"占几列", 布局器算真实像素 —— 不许组件自己写死坐标。 */
export interface GridSpec {
  cols: number;
  /** 列间距 px */
  gutter: number;
  /** 页边距 px */
  margin: { top: number; right: number; bottom: number; left: number };
  /** 垂直节奏基数 px。所有间距必须是它的整数倍。 */
  baseline: number;
}

/** 配图策略 —— 按内容类型分流, 不是一刀切。 */
export interface ImageryPolicy {
  /** 抽象概念 (团队/增长/创新): 生成图能锚定主题色, 这是我们相对素材库的优势 */
  abstract: 'generate' | 'search' | 'none';
  /** 具体实体 (产品/人物/地标): 生成会出事实错误, 必须搜 */
  concrete: 'search' | 'generate' | 'none';
  /** 图标 / 装饰 / 分隔: 现在能用 custGeom 直接画, 矢量可改色跟主题走 */
  decorative: 'draw' | 'search' | 'none';
  /** 生成图的风格描述 —— 拼进出图 prompt, 保证全篇图风一致 */
  generateStylePrompt?: string;
}

/** 动效。OOXML 的 p:transition / p:timing。 */
export interface MotionSpec {
  /** 页切换 */
  transition: 'none' | 'fade' | 'push' | 'wipe' | 'morph';
  /** 元素入场 */
  build: 'none' | 'fadeIn' | 'riseIn' | 'wipeIn';
  /** 同页多元素之间的间隔 (秒) */
  stagger: number;
}

/**
 * 完整的风格冻结件。
 * 继承已有的 NeoxComposeTheme (颜色 + 字体配对), 补上几何/栅格/配图/动效。
 */
export interface StyleSpec {
  id: string;
  /** 给用户看的名字, 只用于选风格的界面 —— 不进渲染管线 */
  displayName: string;
  /** 一句话说明适合什么场景, 同样只给人看 */
  suitedFor: string;
  theme: NeoxComposeTheme;
  motif: Motif;
  radius: RadiusScale;
  type: TypeScale;
  grid: GridSpec;
  imagery: ImageryPolicy;
  motion: MotionSpec;
  /**
   * 这套风格的纹样。给了它, 封面/章节页的背景构成和内容页的装饰层都改画这套
   * 纹样 (templates/ornaments.ts), 而不是按 motif 放大形状。不给就按原来的 motif 走。
   */
  ornament?: 'guilloche';
}

/* ============================================================
 * 内置风格
 * ============================================================
 * 先给 3 套 —— 每套的 motif 都不同, 保证用户一眼能看出区别。
 * 同 motif 换配色只是"换个皮", 用户会觉得我们只有一套模板。
 */

const GRID_DEFAULT: GridSpec = {
  cols: 12,
  gutter: 24,
  margin: { top: 56, right: 72, bottom: 48, left: 72 },
  baseline: 8,
};

/** 商务蓝 · chevron —— 汇报 / 产品发布 / 企业 pitch */
export const CORPORATE_CHEVRON: StyleSpec = {
  id: 'corporate-chevron',
  displayName: '商务推进',
  suitedFor: '工作汇报、产品发布、企业提案',
  theme: BLUE_CORPORATE,
  motif: 'chevron',
  radius: { sm: 6, md: 14, lg: 999, path: 16 },
  type: {
    display: { size: 40, weight: 'bold', lineHeight: 1.18, tracking: -0.5 },
    title: { size: 24, weight: 'bold', lineHeight: 1.28, tracking: -0.2 },
    body: { size: 14, weight: 'regular', lineHeight: 1.62, tracking: 0 },
    caption: { size: 11, weight: 'regular', lineHeight: 1.5, tracking: 0.3 },
    numeral: { size: 22, weight: 'regular', lineHeight: 1.1, tracking: 0 },
  },
  grid: GRID_DEFAULT,
  imagery: {
    abstract: 'generate', concrete: 'search', decorative: 'draw',
    generateStylePrompt: 'clean corporate photography, soft daylight, shallow depth of field, muted blue tone',
  },
  motion: { transition: 'push', build: 'riseIn', stagger: 0.12 },
};

/** 暖色编辑 · capsule —— 教育 / 生活方式 / 消费品 */
export const EDITORIAL_CAPSULE: StyleSpec = {
  id: 'editorial-capsule',
  displayName: '温和叙事',
  suitedFor: '教学课件、品牌故事、生活方式',
  theme: WARM_EDITORIAL,
  motif: 'capsule',
  radius: { sm: 8, md: 20, lg: 999, path: 22 },
  type: {
    display: { size: 42, weight: 'bold', lineHeight: 1.16, tracking: -0.6 },
    title: { size: 23, weight: 'bold', lineHeight: 1.3, tracking: -0.1 },
    body: { size: 14, weight: 'regular', lineHeight: 1.68, tracking: 0 },
    caption: { size: 11, weight: 'regular', lineHeight: 1.5, tracking: 0.4 },
    numeral: { size: 24, weight: 'regular', lineHeight: 1.1, tracking: 0 },
  },
  grid: GRID_DEFAULT,
  imagery: {
    abstract: 'generate', concrete: 'search', decorative: 'draw',
    generateStylePrompt: 'warm editorial photography, natural light, terracotta and cream palette, film grain',
  },
  motion: { transition: 'fade', build: 'fadeIn', stagger: 0.1 },
};

/** 极简线性 · line —— 技术 / 数据 / 专业服务 */
export const MINIMAL_LINE: StyleSpec = {
  id: 'minimal-line',
  displayName: '克制专业',
  suitedFor: '技术方案、数据复盘、咨询交付',
  theme: ELEGANT_EDITORIAL,
  motif: 'line',
  radius: { sm: 3, md: 6, lg: 8, path: 4 },
  type: {
    display: { size: 36, weight: 'bold', lineHeight: 1.2, tracking: -0.3 },
    title: { size: 21, weight: 'bold', lineHeight: 1.32, tracking: 0 },
    body: { size: 13, weight: 'regular', lineHeight: 1.66, tracking: 0 },
    caption: { size: 10, weight: 'regular', lineHeight: 1.5, tracking: 0.5 },
    numeral: { size: 30, weight: 'regular', lineHeight: 1.05, tracking: -1 },
  },
  grid: { ...GRID_DEFAULT, gutter: 20, margin: { top: 52, right: 64, bottom: 44, left: 64 } },
  imagery: {
    abstract: 'none', concrete: 'search', decorative: 'draw',
    generateStylePrompt: 'minimal isometric line illustration, single accent color, lots of whitespace',
  },
  motion: { transition: 'fade', build: 'none', stagger: 0 },
};

/** 强对比 · ribbon —— 荣誉 / 里程碑 / 党政 */
export const BOLD_RIBBON: StyleSpec = {
  id: 'bold-ribbon',
  displayName: '隆重仪式',
  suitedFor: '表彰总结、里程碑发布、党政宣讲',
  theme: BOLD_MODERN,
  motif: 'ribbon',
  radius: { sm: 4, md: 10, lg: 16, path: 8 },
  type: {
    display: { size: 46, weight: 'bold', lineHeight: 1.12, tracking: -0.8 },
    title: { size: 26, weight: 'bold', lineHeight: 1.26, tracking: -0.2 },
    body: { size: 14, weight: 'regular', lineHeight: 1.6, tracking: 0 },
    caption: { size: 11, weight: 'regular', lineHeight: 1.48, tracking: 0.4 },
    numeral: { size: 28, weight: 'bold', lineHeight: 1.05, tracking: -0.5 },
  },
  grid: GRID_DEFAULT,
  imagery: {
    abstract: 'generate', concrete: 'search', decorative: 'draw',
    generateStylePrompt: 'dramatic high-contrast photography, strong directional light, bold saturated accent',
  },
  motion: { transition: 'wipe', build: 'wipeIn', stagger: 0.14 },
};

/** 稳健金融 · line + 钞票细线纹 —— 银行 / 金融 / 年报财报 / 投资者汇报
 *
 * 形态语言借 line (细线 + 节点) 的克制, 装饰换成 guilloche: 那是银行票据自己的纹样,
 * 放在这里不是"加花", 是认出这个行业。圆角几乎为零 —— 金融版式讲的是规矩和精确,
 * 大圆角是消费品的语言。字号比商务推进小一档、行高更松, 读起来更沉。 */
export const FINANCE_NAVY: StyleSpec = {
  id: 'finance-navy',
  displayName: '稳健金融',
  suitedFor: '银行、金融、年报财报、投资者汇报',
  theme: NAVY_GOLD,
  motif: 'line',
  radius: { sm: 2, md: 4, lg: 6, path: 3 },
  type: {
    display: { size: 38, weight: 'bold', lineHeight: 1.2, tracking: -0.3 },
    title: { size: 22, weight: 'bold', lineHeight: 1.32, tracking: 0 },
    body: { size: 14, weight: 'regular', lineHeight: 1.72, tracking: 0.1 },
    caption: { size: 10.5, weight: 'regular', lineHeight: 1.5, tracking: 0.6 },
    numeral: { size: 30, weight: 'regular', lineHeight: 1.05, tracking: -0.5 },
  },
  grid: { ...GRID_DEFAULT, margin: { top: 56, right: 80, bottom: 48, left: 80 } },
  imagery: {
    abstract: 'none', concrete: 'search', decorative: 'draw',
    generateStylePrompt: 'refined financial editorial photography, deep navy and antique gold, calm soft light, architectural detail, no people',
  },
  motion: { transition: 'fade', build: 'none', stagger: 0 },
  ornament: 'guilloche',
};

export const STYLE_SPECS: Record<string, StyleSpec> = {
  [CORPORATE_CHEVRON.id]: CORPORATE_CHEVRON,
  [EDITORIAL_CAPSULE.id]: EDITORIAL_CAPSULE,
  [MINIMAL_LINE.id]: MINIMAL_LINE,
  [BOLD_RIBBON.id]: BOLD_RIBBON,
  [FINANCE_NAVY.id]: FINANCE_NAVY,
};

export const DEFAULT_STYLE_SPEC = CORPORATE_CHEVRON;

/**
 * 按场景挑一个默认风格 —— 明康: "不一定必须要问, 有的用户就是要快速生成一个能交的材料"。
 * 所以给一条**不问也能跑**的路: 从用户那句话里猜, 猜不中给商务推进兜底。
 * 界面上仍然可以让用户换, 但不换也不会卡住。
 */
export function pickStyleForBrief(brief: string): StyleSpec {
  const t = String(brief || '');
  /* 金融放最前: "银行年度表彰"是银行的场合, 不是党政表彰 */
  if (/银行|金融|理财|信贷|风控|资管|基金|证券|保险|投行|年报|财报|投资者|资产|财务|审计|营收|经营汇报/.test(t)) return FINANCE_NAVY;
  if (/表彰|荣誉|里程碑|党|政|表决心|誓师|颁奖/.test(t)) return BOLD_RIBBON;
  if (/教学|课件|课程|学生|儿童|品牌故事|生活|健康|亲子/.test(t)) return EDITORIAL_CAPSULE;
  if (/技术|架构|数据|复盘|测评|白皮书|咨询/.test(t)) return MINIMAL_LINE;
  return CORPORATE_CHEVRON;
}

/*
 * StyleSpec 约束主题 token 的来源，派生颜色由主题工具统一计算。
 * 风格审计关注绕过主题直接写死颜色或字号的代码路径。
 */
