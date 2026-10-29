import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const TOKENS = readFileSync(join(__dirname, '..', 'theme-tokens', 'neox.css'), 'utf8');

/** sRGB 相对亮度 (WCAG) */
function lum(r: number, g: number, b: number): number {
  const t = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * t(r) + 0.7152 * t(g) + 0.0722 * t(b);
}
function ratio(a: [number, number, number], b: [number, number, number]): number {
  const [x, y] = [lum(...a), lum(...b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
/** fg 以 alpha 压在 bg 上 */
function over(fg: [number, number, number], a: number, bg: [number, number, number]): [number, number, number] {
  return [0, 1, 2].map(i => fg[i] * a + bg[i] * (1 - a)) as [number, number, number];
}

const INK: [number, number, number] = [36, 41, 47];       // 浅白 fg-primary #24292f
const SILVER: [number, number, number] = [212, 212, 212]; // 暗夜 fg-primary #d4d4d4
const WHITE: [number, number, number] = [255, 255, 255];
const DARKBG: [number, number, number] = [24, 24, 24];    // 暗夜 canvas #181818

describe('焦点环对比度', () => {
  it('焦点环有自己的 token, 不再共用装饰光晕的 --neox-primary-ring', () => {
    expect(TOKENS).toContain('--neox-focus-ring:');
    expect(TOKENS).toContain('--neox-shadow-focus: 0 0 0 3px var(--neox-focus-ring)');
    /* 合回去就红 —— 那正是 1.28:1 的成因 */
    expect(TOKENS).not.toContain('--neox-shadow-focus: 0 0 0 3px var(--neox-primary-ring)');
  });

  it('取的是前景色的百分比, 于是自动跟着主题包走, 新增包不会漏配', () => {
    const m = /--neox-focus-ring:\s*color-mix\(in srgb,\s*var\(--neox-fg-primary\)\s*(\d+)%/.exec(TOKENS);
    expect(m, '--neox-focus-ring 应当由 fg-primary 派生').not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(50);
  });

  it('浅色: 环压在白底上 ≥3:1', () => {
    const m = /--neox-focus-ring:\s*color-mix\(in srgb,\s*var\(--neox-fg-primary\)\s*(\d+)%/.exec(TOKENS)!;
    const a = Number(m[1]) / 100;
    const r = ratio(over(INK, a, WHITE), WHITE);
    expect(r).toBeGreaterThanOrEqual(3);
    /* 修前是 13% 的同色, 记在这里当对照 —— 那时只有 1.28:1 */
    expect(ratio(over(INK, 0.13, WHITE), WHITE)).toBeLessThan(1.5);
  });

  it('暗色: 同一个公式压在暗底上也 ≥3:1 —— 一份定义两边都成立才叫拆干净', () => {
    const m = /--neox-focus-ring:\s*color-mix\(in srgb,\s*var\(--neox-fg-primary\)\s*(\d+)%/.exec(TOKENS)!;
    const a = Number(m[1]) / 100;
    expect(ratio(over(SILVER, a, DARKBG), DARKBG)).toBeGreaterThanOrEqual(3);
  });

  it('--neox-primary-ring 保留给装饰光晕, 注释要说清楚别再被当焦点环用', () => {
    expect(TOKENS).toMatch(/--neox-primary-ring:[^\n]*\n?[^\n]*(装饰|不是.*焦点环)/);
  });
});
