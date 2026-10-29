import { describe, expect, it } from 'vitest';
import { badgeInkOn } from '../FileTypeIcon';

/* WCAG 相对亮度 + 对比度, 跟实现里用的是同一套定义 —— 这里独立写一遍是故意的:
 * 如果实现和测试共用同一个函数, 公式写错了两边会一起错。 */
function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const srgb = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  const lin = srgb.map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}
function contrast(a: string, b: string): number {
  const L1 = luminance(a); const L2 = luminance(b);
  return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
}

const BRAND_COLORS = [
  '#f7df1e', // JavaScript —— 最初撞到的那个, 白字 1.35
  '#8dd6f9', // webpack     白字 1.6
  '#61dafb', // React       白字 1.62
  '#cbcb41', // 白字 1.73
  '#4fc08d', // Vue         白字 2.27
  '#00add8', // Go          白字 2.64
  '#2496ed', // Docker      白字 3.15
  '#ec1c24', // 白字 4.41 / 黑字 4.76 —— 贴着分界, 两边都勉强
  '#3178c6', // TypeScript  白字达标, 应保持白字
  '#3776ab', // Python      白字达标
  '#000000', // 极端: 纯黑底必须白字
  '#ffffff', // 极端: 纯白底必须黑字
];

describe('badgeInkOn', () => {
  it('每个品牌色选出的字色都达到 WCAG AA (4.5)', () => {
    for (const bg of BRAND_COLORS) {
      const ink = badgeInkOn(bg);
      expect(contrast(ink, bg), `${bg} 上用 ${ink}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('选的是两者中对比度更高的那个, 不是"能过就行"', () => {
    for (const bg of BRAND_COLORS) {
      const ink = badgeInkOn(bg);
      const other = ink === '#000' ? '#fff' : '#000';
      expect(contrast(ink, bg), `${bg}`).toBeGreaterThanOrEqual(contrast(other, bg));
    }
  });

  it('JS 黄用黑字 —— 官方 logo 就是黑字黄底', () => {
    expect(badgeInkOn('#f7df1e')).toBe('#000');
  });

  it('深色品牌色仍用白字, 没有一刀切改成黑', () => {
    expect(badgeInkOn('#000000')).toBe('#fff');
    expect(badgeInkOn('#1a1a1a')).toBe('#fff');
    expect(badgeInkOn('#264de4')).toBe('#fff'); // CSS 蓝, 明显偏暗
  });

  /* 写这条是因为我第一版断言把 TypeScript 蓝 (#3178c6) 当成"深色"、以为该用白字,
   * 结果测试挂了。手算才发现它落在分界的亮侧: 白字 4.44 (不达标), 黑字 4.73。
   * 中间调的蓝绿色最容易凭感觉判错 —— 留一条守住"以算出来的为准, 不以观感为准"。 */
  it('中间调颜色以计算为准, 不以观感为准', () => {
    expect(badgeInkOn('#3178c6')).toBe('#000'); // 看着"深", 但白字只有 4.44
    expect(contrast('#000', '#3178c6')).toBeGreaterThan(contrast('#fff', '#3178c6'));
  });

  it('解析不出 hex 时回落白字, 不抛异常', () => {
    /* 颜色表里的兜底值是 CSS 变量, 拿不到实际色值就维持原行为 */
    expect(badgeInkOn('var(--neox-fg-hint, #9aa0a6)')).toBe('#fff');
    expect(badgeInkOn('')).toBe('#fff');
    expect(badgeInkOn('rgb(1,2,3)')).toBe('#fff');
  });

  it('大小写和首尾空白不影响判定', () => {
    expect(badgeInkOn('#F7DF1E')).toBe('#000');
    expect(badgeInkOn('  #f7df1e  ')).toBe('#000');
  });
});
