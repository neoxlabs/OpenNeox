import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(resolve(HERE, '../agent-timeline.css'), 'utf8');

/** 取出 .atl-mention__slash-desc 这条规则的声明块 (剥掉注释, 免得注释里引用的旧写法算数) */
function descRule(): string {
  const src = CSS.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const m = /\.atl-mention__slash-desc\s*\{([^}]*)\}/.exec(src);
  expect(m, '找不到 .atl-mention__slash-desc').toBeTruthy();
  return m![1];
}

describe('斜杠菜单的描述列', () => {
  it('有宽度上限 —— 没有它, 省略三件套永远不触发', () => {
    const rule = descRule();
    const m = /max-width:\s*(\d+)px/.exec(rule);
    expect(m, '没有 max-width, 描述会一直摊到 800px').toBeTruthy();
    const px = Number(m![1]);
    expect(px, '上限太小, 会把内置那几条一句话的描述也截了').toBeGreaterThanOrEqual(300);
    expect(px, '上限太大, 等于没上限').toBeLessThanOrEqual(560);
  });

  it('省略三件套仍在 —— 只有上限没有省略就是硬裁, 连 … 都没有', () => {
    const rule = descRule();
    expect(rule).toMatch(/overflow:\s*hidden/);
    expect(rule).toMatch(/text-overflow:\s*ellipsis/);
    expect(rule).toMatch(/white-space:\s*nowrap/);
  });

  it('完整文案必须挂在 title 上 —— 截了就得有地方看全', () => {
    const tsx = readFileSync(resolve(HERE, '../TimelineComposer.tsx'), 'utf8');
    expect(tsx).toMatch(/atl-mention__slash-desc"\s+title=\{it\.description\}/);
  });
});
