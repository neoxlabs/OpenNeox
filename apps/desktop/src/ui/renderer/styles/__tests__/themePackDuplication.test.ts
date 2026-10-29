import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKENS = join(HERE, '..', 'theme-tokens');

function countSelectors(css: string): Map<string, number> {
  const out = new Map<string, number>();
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of clean.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
    const block = m[1].trim();
    if (!block || block.startsWith('@')) continue;
    for (const raw of block.split(',')) {
      const sel = raw.trim().replace(/\s+/g, ' ');
      if (!sel || sel.startsWith('@') || sel.startsWith('/*') || sel.length > 200) continue;
      out.set(sel, (out.get(sel) ?? 0) + 1);
    }
  }
  return out;
}

function dupStats(file: string) {
  const css = readFileSync(join(TOKENS, file), 'utf8');
  const counts = countSelectors(css);
  const dupSelectors = [...counts.values()].filter(v => v > 1).length;
  const extraRules = [...counts.values()].filter(v => v > 1).reduce((a, v) => a + v - 1, 0);
  /* 组件选择器 = 带后代/类名的, 排除裸 :root[...] 变量块 */
  const isComponent = (sel: string) => /[.#]/.test(sel.replace(/^:root[^\s]*/, ''));
  const worstComponent = [...counts.entries()]
    .filter(([sel]) => isComponent(sel))
    .sort((a, b) => b[1] - a[1])[0];
  return { dupSelectors, extraRules, worstComponent };
}

const BASELINE = {
  'anye-flat.css':   { dupSelectors: 223, extraRules: 528 },
  'theme-packs.css': { dupSelectors: 208, extraRules: 314 },
};

describe('主题包重复覆写 — 只许降不许升', () => {
  for (const [file, base] of Object.entries(BASELINE)) {
    it(`${file}: 重复选择器数不超过基线 ${base.dupSelectors}`, () => {
      const { dupSelectors } = dupStats(file);
      expect(dupSelectors).toBeLessThanOrEqual(base.dupSelectors);
    });
    it(`${file}: 多余规则数不超过基线 ${base.extraRules}`, () => {
      const { extraRules } = dupStats(file);
      expect(extraRules).toBeLessThanOrEqual(base.extraRules);
    });
  }

  /* 单个【组件】选择器不许被写太多次。
   * 排除裸 :root[...] —— 那是变量定义块, 按 section 分开写是正常组织方式, 不是坏味道。 */
  /* 阈值 7 = 当前最差值 (anye-flat.css 里 `…dark .neox-shell` 写了 7 次)。
   * 不是"7 次可以接受", 是"不许比现在更差"。合并掉之后请把这个数调低。 */
  it('单个组件选择器不许被写超过 7 次 —— 超过就是没人敢删的信号', () => {
    for (const file of Object.keys(BASELINE)) {
      const { worstComponent } = dupStats(file);
      expect(worstComponent, `${file} 无组件选择器?`).toBeDefined();
      expect(
        worstComponent![1],
        `${file}: "${worstComponent![0]}" 被写了 ${worstComponent![1]} 次`,
      ).toBeLessThanOrEqual(7);
    }
  });
});
