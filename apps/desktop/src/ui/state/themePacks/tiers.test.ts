import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as tiers from './tiers';
import { planTierOf } from './tiers';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (rel: string) => readFileSync(resolve(HERE, '../..', rel), 'utf8');

describe('planTierOf', () => {
  it('pro-plus 判成 Max(2) 而不是 Pro(1) —— 子串顺序坑', () => {
    expect(planTierOf('pro-plus')).toBe(2);
    expect(planTierOf('pro_plus')).toBe(2);   /* 下划线也要归一 */
    expect(planTierOf('pro')).toBe(1);
  });

  it('各档映射', () => {
    expect(planTierOf('free')).toBe(0);
    expect(planTierOf('ultra')).toBe(3);
    expect(planTierOf('teams')).toBe(2);
    expect(planTierOf('enterprise')).toBe(3);
  });

  it('空 / 未登录 / 认不出的 plan 一律落 Free', () => {
    expect(planTierOf(null)).toBe(0);
    expect(planTierOf(undefined)).toBe(0);
    expect(planTierOf('')).toBe(0);
    expect(planTierOf('some-new-plan-id')).toBe(0);
  });
});

describe('主题不按会员档分', () => {
  it('tiers 模块不再导出任何主题闸', () => {
    for (const gone of ['THEME_MIN_TIER', 'minTierForPack', 'isPackUnlocked', 'resolveUnlockedPackId']) {
      expect(tiers).not.toHaveProperty(gone);
    }
  });

  /* 断言真正的前置条件: 三个主题选择器 (引导页 / 设置页 / 顶栏快捷菜单)
   * 源码里都不能出现档位过滤 —— 只测函数不存在的话, 谁在页面里手写
   * `planTierOf(...) >= 2` 一样能把包挡掉而这里全绿。 */
  it.each([
    ['引导页', 'renderer/pages/onboarding/OnboardingPage.tsx'],
    ['设置页', 'renderer/pages/settings/tabs/ThemeTab.tsx'],
    ['顶栏快捷菜单', 'renderer/modules/shell/TopBar.tsx'],
  ])('%s 里没有档位过滤', (_name, rel) => {
    const code = src(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/isPackUnlocked|minTierForPack|resolveUnlockedPackId|planTierOf|usePlanTier/);
  });
});
