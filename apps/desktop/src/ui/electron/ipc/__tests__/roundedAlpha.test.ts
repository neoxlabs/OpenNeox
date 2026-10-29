import { describe, test, expect } from 'vitest';
import { applyRoundedAlpha } from '../shareCardHandlers';

/** 造一张全不透明的 BGRA 位图 */
const solid = (w: number, h: number) => {
  const b = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) { b[i * 4 + 3] = 255; }
  return b;
};
const alphaAt = (b: Buffer, w: number, x: number, y: number) => b[(y * w + x) * 4 + 3];

describe('applyRoundedAlpha', () => {
  test('四角被切透明', () => {
    const w = 60, h = 40, r = 10;
    const b = applyRoundedAlpha(solid(w, h), w, h, r);
    expect(alphaAt(b, w, 0, 0)).toBe(0);
    expect(alphaAt(b, w, w - 1, 0)).toBe(0);
    expect(alphaAt(b, w, 0, h - 1)).toBe(0);
    expect(alphaAt(b, w, w - 1, h - 1)).toBe(0);
  });

  test('中心和四边中点保持不透明 —— 只切角, 不切边', () => {
    const w = 60, h = 40, r = 10;
    const b = applyRoundedAlpha(solid(w, h), w, h, r);
    expect(alphaAt(b, w, w >> 1, h >> 1)).toBe(255);
    expect(alphaAt(b, w, w >> 1, 0)).toBe(255);
    expect(alphaAt(b, w, w >> 1, h - 1)).toBe(255);
    expect(alphaAt(b, w, 0, h >> 1)).toBe(255);
    expect(alphaAt(b, w, w - 1, h >> 1)).toBe(255);
  });

  test('圆角内部仍然不透明 (没有把整块角都抹掉)', () => {
    const w = 60, h = 40, r = 10;
    const b = applyRoundedAlpha(solid(w, h), w, h, r);
    /* (r, r) 是圆心, 必然在圆内 */
    expect(alphaAt(b, w, r, r)).toBe(255);
  });

  test('边缘有过渡值 = 有抗锯齿, 不是硬台阶', () => {
    const w = 80, h = 80, r = 20;
    const b = applyRoundedAlpha(solid(w, h), w, h, r);
    let soft = 0;
    for (let y = 0; y < r; y++) for (let x = 0; x < r; x++) {
      const a = alphaAt(b, w, x, y);
      if (a > 0 && a < 255) soft++;
    }
    expect(soft).toBeGreaterThan(5);
  });

  test('radius=0 原样返回', () => {
    const w = 8, h = 8;
    const b = applyRoundedAlpha(solid(w, h), w, h, 0);
    expect(alphaAt(b, w, 0, 0)).toBe(255);
  });

  test('radius 大于半边时被夹住, 不越界写', () => {
    const w = 10, h = 6;
    expect(() => applyRoundedAlpha(solid(w, h), w, h, 999)).not.toThrow();
  });
});
