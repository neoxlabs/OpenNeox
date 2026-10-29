import { describe, expect, test } from 'vitest';
import { surfaceFitsBeside } from '../useSurfaceAutoFloat';

describe('窄窗口画布放不下就先不显示 (10-21)', () => {
  test('侧栏开着: 宽度 < 侧栏 + 480 + 320 就不显示', () => {
    expect(surfaceFitsBeside(960, null, false)).toBe(false); // 280 + 480 + 320 = 1080
    expect(surfaceFitsBeside(1080, null, false)).toBe(true);
    expect(surfaceFitsBeside(1150, 400, false)).toBe(false); // 拖宽过的侧栏也算进去
  });
  test('侧栏收起: 800 起就能并排', () => {
    expect(surfaceFitsBeside(799, null, true)).toBe(false);
    expect(surfaceFitsBeside(800, null, true)).toBe(true);
  });
});
