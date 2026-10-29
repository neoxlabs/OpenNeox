import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ALL_THEME_PACKS, THEME_PACKS } from './packs';

/** #rrggbb → 相对亮度 (WCAG)。这两个 token 都是死色, 不会是 color-mix。 */
const luminance = (hex: string): number => {
  const m = hex.trim().replace('#', '');
  const to = (i: number) => parseInt(m.slice(i, i + 2), 16) / 255;
  const lin = (v: number) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(to(0)) + 0.7152 * lin(to(2)) + 0.0722 * lin(to(4));
};
const contrast = (a: string, b: string): number => {
  if (!/^#[0-9a-f]{6}$/i.test(a.trim()) || !/^#[0-9a-f]{6}$/i.test(b.trim())) return 0;
  const l1 = luminance(a), l2 = luminance(b);
  return +(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)).toFixed(2));
};

const HERE = dirname(fileURLToPath(import.meta.url));
const applyPackSrc = readFileSync(resolve(HERE, 'applyPack.ts'), 'utf8');

/** 只认死色 (#rgb/#rrggbb 或 alpha=1 的 rgb/rgba)。带 alpha<1 的一律判透明。 */
const isOpaque = (color: string): boolean => {
  const c = color.trim().toLowerCase();
  if (!c || c === 'transparent') return false;
  if (/^#[0-9a-f]{6}$/.test(c) || /^#[0-9a-f]{3}$/.test(c)) return true;
  const m = c.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const parts = m[1].split(/[,/]/).map(s => s.trim()).filter(Boolean);
    if (parts.length < 4) return true;              /* rgb(...) 无 alpha = 不透明 */
    return Number(parts[3]) >= 1;
  }
  /* color-mix / var() 之类算不出来 —— 浮层面不该依赖它们, 判失败更安全 */
  return false;
};

describe('主题包的浮层面', () => {
  it.each(THEME_PACKS.map(p => [p.name.zh, p] as const))('%s 的 bgElevated 是不透明的', (_name, pack) => {
    const elevated = pack.tokens?.bgElevated;
    expect(elevated, 'bgElevated 必须存在').toBeTruthy();
    expect(isOpaque(String(elevated)), `bgElevated=${elevated} 不能带 alpha`).toBe(true);
  });

  it('bgCard 仍然可以是半透明的 —— 那是卡片的玻璃感, 不该被这次改动顺手改掉', () => {
    const withGlassCard = ALL_THEME_PACKS.filter(p => !isOpaque(String(p.tokens?.bgCard ?? '')));
    expect(withGlassCard.length).toBeGreaterThan(0);
  });

  it.each(THEME_PACKS.map(p => [p.name.zh, p] as const))('%s: fg-primary 压在 bgElevated 上对比 ≥ 4.5', (_n, pack) => {
    const c = contrast(String(pack.tokens?.fgPrimary ?? ''), String(pack.tokens?.bgElevated ?? ''));
    expect(c, `contrast=${c}`).toBeGreaterThanOrEqual(4.5);
  });

  it('--bg-elevated 指向 bgElevated, 不是 bgCard', () => {
    expect(applyPackSrc).toMatch(/\['bgElevated',\s*'--bg-elevated'\]/);
    expect(applyPackSrc).not.toMatch(/\['bgCard',\s*'--bg-elevated'\]/);
  });
});
