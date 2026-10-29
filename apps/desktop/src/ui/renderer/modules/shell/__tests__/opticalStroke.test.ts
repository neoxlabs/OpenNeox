import { describe, test, expect } from 'vitest';
import { opticalStrokeWidth } from '../shellIcons';

/** 把 viewBox 线宽换算成屏幕上真正看到的粗细 */
const optical = (size: number) => (opticalStrokeWidth(size) / 24) * size;

describe('opticalStrokeWidth', () => {
  test('16px 处保持现状基准 1.75, 不改既有观感', () => {
    expect(opticalStrokeWidth(16)).toBe(1.75);
  });

  test('常用尺寸的**光学**线宽收敛到同一档 (原来 0.73~1.17 散开)', () => {
    for (const size of [10, 12, 13, 14, 16, 18]) {
      const px = optical(size);
      expect(px).toBeGreaterThan(1.0);
      expect(px).toBeLessThan(1.3);
    }
  });

  test('越小的图标线越粗 —— 补偿方向不能反', () => {
    expect(opticalStrokeWidth(10)).toBeGreaterThan(opticalStrokeWidth(16));
    expect(opticalStrokeWidth(16)).toBeGreaterThan(opticalStrokeWidth(24));
  });

  test('两端钳位: 极小不糊成一团, 极大不过重', () => {
    expect(opticalStrokeWidth(4)).toBeLessThanOrEqual(2.6);
    expect(opticalStrokeWidth(64)).toBeGreaterThanOrEqual(1.25);
  });

  test('size=0 / 负数不炸 (防御外部乱传)', () => {
    expect(Number.isFinite(opticalStrokeWidth(0))).toBe(true);
    expect(Number.isFinite(opticalStrokeWidth(-5))).toBe(true);
  });
});
