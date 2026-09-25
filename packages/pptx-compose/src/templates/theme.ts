import { hasFontMetrics } from '../layout/font-metrics.js';
/**
 * templates/theme — compose 模板用的默认主题.
 * 直接复用 renderer 的 WARM_EDITORIAL, 后续可以扩独立主题.
 */

export const NEOX_THEME = {
  paper: '#FAF7F1',
  ink: '#1D2A2F',
  muted: '#6B7280',
  subtle: '#D6D3CB',
  accent: '#C05621',
  accentSoft: '#FDE68A',
  accentDeep: '#7B3510',
  onInk: '#F9FAFB',
  surface: '#F5F1E8',
  fonts: {
    /* 确定性硬化: 全部换 macOS 原生字体.
     * 声明的字体必须在目标机器真实存在 — Playfair/Inter/JetBrains 用户没装时
     * WPS/Keynote 的替换不可控, 布局精准测量就全白算. Didot 是 macOS 原生的
     * 高反差衬线 (编辑感一致), Helvetica Neue/Menlo 同理.
     * 精准测量引擎 (font-metrics.data.ts) 对这几个家族有真实 advance 表. */
    displayLatin: 'Didot',
    displayEast: 'Songti SC',
    textLatin: 'Helvetica Neue',
    textEast: 'PingFang SC',
    numeric: 'Avenir Next',
  },
};

/* ============================================================
 * 活动主题 —— 让 20 个模板跟着 StyleSpec 走
 * ============================================================
 * 模板全都写死 `const t = NEOX_THEME`, 于是"选风格"这件事根本
 * 到不了模板层 —— 选完风格出来的还是同一套暖橙。
 *
 * 不给 20 个模板都加一个 theme 形参, 是因为**一份 deck 只有一套风格**
 * (StyleSpec 的整个前提就是"阶段一冻结, 阶段二只读")。逐页传等于给了
 * 逐页改的机会, 那正是要禁掉的风格漂移。所以做成 deck 级的活动主题,
 * 由 withActiveTheme() 包住整段生成, 模板只管读。
 */

type ThemeShape = typeof NEOX_THEME;

let active: ThemeShape = NEOX_THEME;

/** 模板读主题的唯一入口 */
export function activeTheme(): ThemeShape {
  return active;
}

/** 一般不要直接调 —— 用 withActiveTheme, 它保证一定还原 */
export function setActiveTheme(theme: Partial<ThemeShape> | null | undefined): void {
  active = theme ? { ...NEOX_THEME, ...theme } as ThemeShape : NEOX_THEME;
}

/**
 * 在指定主题下跑一段生成。同步/异步都兜, 抛异常也还原 ——
 * 某一页画砸了不该把后面所有页的配色带跑。
 */
export async function withActiveTheme<T>(
  theme: Partial<ThemeShape> | null | undefined,
  fn: () => T | Promise<T>,
): Promise<T> {
  const prev = active;
  setActiveTheme(theme);
  try {
    return await fn();
  } finally {
    active = prev;
  }
}

/* ── 活动风格 (StyleSpec) ────────────────────────────────────
 * activeTheme 只有颜色和字体。但形态语言 (motif)、圆角尺度、排版尺度都在
 * StyleSpec 上, 模板要画"这一套风格的图形"就必须拿得到它。
 * 单独存一份, 且允许为空 —— 直接调模板 (不走 deck 工具) 时退回默认风格。 */
let activeSpecRef: any = null;

export function activeSpec(): any {
  return activeSpecRef;
}

export function setActiveSpec(spec: any): void {
  activeSpecRef = spec ?? null;
  if (activeSpecRef) checkStyleFonts(activeSpecRef);
}

/** 同时锁定颜色和形态 —— deck 的每一页都该跑在这个作用域里 */
export async function withActiveStyle<T>(spec: any, fn: () => T | Promise<T>): Promise<T> {
  const prevSpec = activeSpecRef;
  activeSpecRef = spec ?? null;
  try {
    return await withActiveTheme(spec?.theme, fn);
  } finally {
    activeSpecRef = prevSpec;
  }
}

export const PAGE = {
  padH: 72,
  padTop: 56,
  padBottom: 48,
} as const;

/** 内容区 · 全 slide 除去 padding */
export function contentBounds(slideW: number, slideH: number) {
  return {
    x: PAGE.padH,
    y: PAGE.padTop,
    width: slideW - PAGE.padH * 2,
    height: slideH - PAGE.padTop - PAGE.padBottom,
  };
}

/**
 * 把当前风格的换页动画写到这一页上。
 *
 * StyleSpec.motion 四套风格都定义了 (transition/build/stagger),
 * 但一直**没有任何代码读过它** —— 导出的 pptx 里一条 p:transition 都没有。
 * 这是今晚第四处"能力写完了但没接线"。
 *
 * 只接 transition。build/stagger (逐元素入场) 需要构建完整的 p:timing 时间轴树,
 * 而它在 WPS / Keynote 上的兼容性差得多 —— 一份打不开的 deck 比没有动画糟糕得多。
 * 那两个字段先留着不用, 好过接一个会炸的。
 */
/** Validate all font roles when a style becomes active so missing metrics are
 * reported before text measurement uses an incompatible fallback. */
const fontCheckedStyles = new Set<string>();
function checkStyleFonts(spec: any): void {
  const id = spec?.id;
  const fonts = spec?.theme?.fonts;
  if (!id || !fonts || fontCheckedStyles.has(id)) return;
  fontCheckedStyles.add(id);
  const bad = Object.entries(fonts)
    .filter(([, fam]) => typeof fam === 'string' && !hasFontMetrics(fam))
    .map(([role, fam]) => `${role}=${fam}`);
  if (bad.length) {
    console.warn(
      `[compose] 风格 ${id} 引用了没有烘焙 metrics 的字体: ${bad.join(', ')}。`
      + ` 测量会退到兜底字体, 而渲染端会被替换成另一个面 —— 排版必然对不上。`
      + ` 要么换成已烘焙的族, 要么在 scripts/extract-font-metrics.mjs 里补上它。`,
    );
  }
}

export function applyStyleTransition(slide: { transition?: unknown }): void {
  /* 传进来的是 builder 的 Slide 包装对象, 真正的数据模型在 _model 上 */
  const model = (slide as any)?._model ?? slide;
  if (!model) return;
  const spec = activeSpec();
  const kind = spec?.motion?.transition;
  if (!kind || kind === 'none') return;
  /* morph 需要两页之间的形状对应关系, 我们没有那个模型 —— 退到 fade 而不是硬写一个
   * 打开就报错的 p:morph。 */
  const mapped = kind === 'morph' ? 'fade' : kind;
  model.transition = { kind: mapped, durationMs: 600 };
}
