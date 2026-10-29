/**
 * inkOn —— 墨色档位必须在**任意**画布上都够读。
 *
 * 写死一个中性灰保证不了这件事: 固定灰只在画布接近纯白/纯黑时成立, 香芋啵啵的画布
 * #bcb0e8 上, #787878 只有 2.21:1。这里把每个内置画布都过一遍, 新增主题包时这道闸
 * 会立刻说话。
 */
import { describe, it, expect } from 'vitest';
import { inkOn, semanticInkOn, contrast } from '../colorUtils';
import { THEME_PACKS } from '../packs';

const TARGETS = { secondary: 8, muted: 6, hint: 4.6 };

describe('inkOn', () => {
  it('在纯白和纯黑上都能达到目标', () => {
    for (const canvas of ['#ffffff', '#000000']) {
      for (const t of Object.values(TARGETS)) {
        expect(contrast(inkOn(canvas, t), canvas)).toBeGreaterThanOrEqual(t - 0.01);
      }
    }
  });

  it('每个内置主题包的画布上, 三档墨色都达标', () => {
    const failures: string[] = [];
    for (const pack of THEME_PACKS) {
      const canvas = pack.seed?.canvas;
      if (!canvas || !canvas.startsWith('#')) continue;
      for (const [tier, target] of Object.entries(TARGETS)) {
        const got = contrast(inkOn(canvas, target), canvas);
        if (got < target - 0.01) failures.push(`${pack.id} ${tier}: ${got.toFixed(2)} < ${target}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('取的是"刚好够"的那一档, 不是一路推到极色', () => {
    /* 再往前推会让次级文字越来越接近正文, 阶梯就塌了 —— 所以 hint 必须比 secondary 浅。 */
    const canvas = '#FAFAF9';
    const hint = contrast(inkOn(canvas, TARGETS.hint), canvas);
    const secondary = contrast(inkOn(canvas, TARGETS.secondary), canvas);
    expect(hint).toBeLessThan(secondary);
    expect(hint).toBeLessThan(TARGETS.hint + 0.5);
  });
});

describe('semanticInkOn', () => {
  it('每个内置画布上, 三个语义墨色都达标', () => {
    const failures: string[] = [];
    for (const pack of THEME_PACKS) {
      const canvas = pack.seed?.canvas;
      if (!canvas || !canvas.startsWith('#')) continue;
      const isDark = pack.seed?.mode === 'dark';
      const seeds = {
        ok: isDark ? '#5fb46a' : '#10b981',
        err: isDark ? '#ef6b6b' : '#dc2626',
        warn: isDark ? '#ffb84d' : '#d97706',
      };
      for (const [name, seed] of Object.entries(seeds)) {
        const got = contrast(semanticInkOn(seed, canvas, 4.6), canvas);
        if (got < 4.6 - 0.01) failures.push(`${pack.id} ${name}: ${got.toFixed(2)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('本来就够读的语义色原样返回 —— 不为凑指标洗掉饱和度', () => {
    /* #b00020 在白底上已经 8:1 出头, 不该被再推黑一次。 */
    expect(semanticInkOn('#b00020', '#ffffff', 4.6)).toBe('#b00020');
  });

  it('推完仍然是同一个色相家族, 没有塌成灰', () => {
    const ink = semanticInkOn('#10b981', '#bcb0e8', 4.6);
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(ink.slice(i, i + 2), 16));
    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(b);
  });
});
