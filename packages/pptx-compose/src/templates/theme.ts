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
  /* 反色块语义色**故意不给**: 默认主题的 ink 就是反色块底色, panelColor() 会回退到它。
   * 这里写死一个常量会让"panel === 该主题自己的 ink"这条不变式失效 —— 一旦写死,
   * 用这套默认主题画出来的深色块就变成另一个颜色, 和 ink 系的文字对不上。 */
  fonts: {
    displayLatin: 'Didot',
    displayEast: 'Songti SC',
    textLatin: 'Helvetica Neue',
    textEast: 'PingFang SC',
    numeric: 'Avenir Next',
  },
};


/* 反色块是可选语义色 —— 主题不给就回退 ink / onInk (见 panelColor / onPanelColor)。
 * 显式允许这两个键存在: 给主题对象加可选字段, 由依赖它的模板按需传值。 */
type ThemeShape = typeof NEOX_THEME & { panel?: string; onPanel?: string };

let active: ThemeShape = NEOX_THEME;

/** 模板读主题的唯一入口 */
export function activeTheme(): ThemeShape {
  return active;
}

export function panelColor(t: ThemeShape = active): string {
  return (t as any).panel ?? t.ink;
}

/** 反色块上的文字色 —— 同上, 没显式给就回退 onInk */
export function onPanelColor(t: ThemeShape = active): string {
  return (t as any).onPanel ?? t.onInk;
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
