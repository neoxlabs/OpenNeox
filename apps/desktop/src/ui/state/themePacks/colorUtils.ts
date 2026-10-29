/* ============================================================
 * 颜色派生工具 — 给 pack seed 派生完整 token 集
 *
 * 输入: hex 字符串 (#RRGGBB)
 * 输出: hex / rgba 字符串
 * 不引入 chroma.js / tinycolor 等运行时依赖, 自己 ~50 行实现
 * ============================================================ */

/* 解析 #RRGGBB → [r, g, b] (0-255) */
export const hexToRgb = (hex: string): [number, number, number] => {
  const m = hex.replace('#', '').match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return [0, 0, 0];
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
};

/* [r, g, b] → #RRGGBB */
export const rgbToHex = (r: number, g: number, b: number): string => {
  const h = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
};

/* 线性混合两色 t ∈ [0,1] */
export const mix = (a: string, b: string, t: number): string => {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  return rgbToHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t);
};

/* 加深: 向黑色混 */
export const darken  = (hex: string, t: number): string => mix(hex, '#000000', t);
/* 提亮: 向白色混 */
export const lighten = (hex: string, t: number): string => mix(hex, '#ffffff', t);

/* hex → rgba 字符串 */
export const alpha = (hex: string, a: number): string => {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
};

/* WCAG 相对亮度 (用于对比度计算) */
const luminance = (hex: string): number => {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/* WCAG 对比度 (1-21, AA 需要 ≥ 4.5) */
export const contrast = (a: string, b: string): number => {
  const l1 = luminance(a);
  const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};

/* hsl → hex (HSL color picker 用) */
export const hslToHex = (h: number, s: number, l: number): string => {
  s /= 100; l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return rgbToHex(255 * f(0), 255 * f(8), 255 * f(4));
};

/**
 * 在画布上推出一档"刚好够读"的墨色。
 *
 * 为什么不能直接给一个固定灰: 固定灰只在画布接近纯白或纯黑时成立。主题包的画布是
 * 任意色 —— 香芋啵啵是 #bcb0e8 这种饱和中间调, 固定的 #787878 压上去只有 2.21:1,
 * 而 WCAG AA 正文要 4.5:1。同一个灰在不同包上能差出三倍对比度, 所以档位必须按画布算。
 *
 * 做法是从画布出发朝对侧推, 二分到刚好够 target 为止, 取"最省"的那一档 ——
 * 再往前推只会让层级塌掉: 次级文字越推越接近正文, 阶梯就没了。
 *
 * 往哪边推是**比出来的, 不是按亮度阈值猜的**。用 luminance < 0.5 判"深画布"会在
 * 中间调上翻车: 香芋啵啵的 #bcb0e8 亮度 0.47, 按阈值算"深", 于是朝白推 —— 而白
 * 压在它上面只有 2.0:1, 黑却有 10.4:1。两边各算一次取赢的那个, 这类画布就不会判反。
 *
 * 两边都够不着 target 时返回更强的那一极, 那是这块画布能给出的最好结果。
 */
export const inkOn = (canvas: string, target: number): string => {
  const pole = contrast('#000000', canvas) >= contrast('#ffffff', canvas) ? '#000000' : '#ffffff';
  if (contrast(pole, canvas) < target) return pole;

  let lo = 0;      /* 画布本身, 对比 1:1 */
  let hi = 1;      /* 完全是极色, 对比最大 */
  for (let i = 0; i < 12; i += 1) {
    const midT = (lo + hi) / 2;
    if (contrast(mix(canvas, pole, midT), canvas) >= target) hi = midT;
    else lo = midT;
  }
  return mix(canvas, pole, hi);
};

/**
 * 把一个语义色 (绿/红/琥珀) 压到在这块画布上够读的程度, 同时留住色相。
 *
 * inkOn 推的是中性墨色, 用在正文层级上; 但 "+624" 的绿、"-12" 的红不能推成灰 ——
 * 颜色本身就是它要传达的信息。所以这里从语义色出发朝对比更强的一极推, 推到刚好够:
 * 绿朝黑推还是绿, 只是更沉; 朝白推还是绿, 只是更淡。
 *
 * 语义色本身已经够读时原样返回 —— 不该为了凑指标把饱和度也一起洗掉。
 */
export const semanticInkOn = (seed: string, canvas: string, target: number): string => {
  if (contrast(seed, canvas) >= target) return seed;
  const pole = contrast('#000000', canvas) >= contrast('#ffffff', canvas) ? '#000000' : '#ffffff';
  if (contrast(pole, canvas) < target) return pole;

  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 12; i += 1) {
    const midT = (lo + hi) / 2;
    if (contrast(mix(seed, pole, midT), canvas) >= target) hi = midT;
    else lo = midT;
  }
  return mix(seed, pole, hi);
};
