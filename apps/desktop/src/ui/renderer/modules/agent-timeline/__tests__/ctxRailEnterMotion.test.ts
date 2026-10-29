import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const R = join(__dirname, '..', '..', '..');   // renderer/
const SRC = readFileSync(join(__dirname, '..', 'AgentTimelineContextRail.tsx'), 'utf8');
const CODE = SRC
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, m => '\n'.repeat((m.match(/\n/g) ?? []).length))
  .replace(/\/\*[\s\S]*?\*\//g, m => '\n'.repeat((m.match(/\n/g) ?? []).length));

function allCss(): string {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      if (e === 'node_modules' || e === '__tests__') continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.css$/.test(e)) out.push(readFileSync(p, 'utf8'));
    }
  };
  walk(R);
  return out.join('\n');
}

describe('上下文栏的入场动效', () => {
  it('测试指着的确实是上下文栏 (路径自检)', () => {
    expect(CODE).toContain('atl-ctx-rail');
    expect(CODE).toContain('AgentTimelineContextRail');
  });

  it('用的是房规的 useEnterTransition, 不是自造一套', () => {
    expect(CODE).toMatch(/import \{ useEnterTransition \}/);
    expect(CODE).toMatch(/const entered = useEnterTransition\(\)/);
  });

  it('根元素挂了 .nx-in / .nx-in--sheet-right / is-in', () => {
    const at = CODE.indexOf('atl-ctx-rail nx-in');
    expect(at, '根元素的 className 上要有 nx-in —— 没有它初态就不是透明+位移, 等于没动画')
      .toBeGreaterThan(0);
    const cls = CODE.slice(at, at + 120);
    expect(cls, '右侧抽屉要用 sheet-right 变体').toContain('nx-in--sheet-right');
    expect(cls, 'entered 之后要切到 is-in 终态').toMatch(/entered \? ' is-in' : ''/);
  });

  it('这几个类在 CSS 里真有规则 (否则挂了也没用)', () => {
    const css = allCss();
    expect(css).toMatch(/\.nx-in--sheet-right/);
    expect(css).toMatch(/\.nx-in\.is-in/);
  });
});
