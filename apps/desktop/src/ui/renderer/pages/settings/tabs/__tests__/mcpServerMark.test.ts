import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(HERE, '../McpServerMark.tsx'), 'utf8');

/* 把组件里那两个纯函数原样搬过来跑 —— 组件本身要 import.meta.glob, 单测环境跑不了 */
function hueOf(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i += 1) { h ^= name.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 360;
}
const initialOf = (name: string): string => {
  const c = name.trim()[0];
  if (!c) return '·';
  return /[a-z]/i.test(c) ? c.toUpperCase() : c;
};

describe('色相由名字定', () => {
  it('同名同色 —— 每次进页面颜色都一样', () => {
    expect(hueOf('my-github')).toBe(hueOf('my-github'));
  });

  it('不同名字基本不同色 (20 个样本至少 15 个不同色相)', () => {
    const names = Array.from({ length: 20 }, (_, i) => `server-${i}`);
    expect(new Set(names.map(hueOf)).size).toBeGreaterThanOrEqual(15);
  });

  it('色相永远落在 0-359', () => {
    for (const n of ['', 'a', '本地文件', 'x'.repeat(200)]) {
      const h = hueOf(n);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });
});

describe('首字母', () => {
  it.each([['github', 'G'], ['本地文件', '本'], ['  spaced', 'S'], ['', '·'], ['3d-tools', '3']])(
    '%s → %s', (input, want) => { expect(initialOf(input)).toBe(want); });
});

describe('真 logo 只用我们有的素材', () => {
  it('走共享资产表, 不拼 CDN / BASE_URL 路径', () => {
    expect(src).toMatch(/pluginBrandAssets/);
    expect(src).not.toMatch(/https?:\/\//);
    const assets = readFileSync(resolve(HERE, '../../../plugins/pluginBrandAssets.ts'), 'utf8');
    expect(assets).toMatch(/import\.meta\.glob<string>\(\s*'[^']*assets\/plugin-logos/);
    expect(assets).not.toMatch(/https?:\/\//);
  });

  it('查不到素材就退回首字母, 不渲染坏图', () => {
    expect(src).toMatch(/if \(url\) \{/);
    expect(src).toMatch(/pluginLogoUrl/);
  });
});
