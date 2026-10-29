import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 注释整段换成等量换行, 保住行号又不让注释里的字面量参与匹配。 */
const CSS = readFileSync(join(__dirname, '..', 'agent-timeline.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, (m) => '\n'.repeat((m.match(/\n/g) ?? []).length));

function declarations(name: string): string[] {
  return [...CSS.matchAll(new RegExp(`--${name}\\s*:([^;]+);`, 'g'))].map((m) => m[1].trim());
}

/** 从 `min(640px, 100%)` 这类值里取 px 那一支。 */
function pxArm(value: string): number | null {
  const m = value.match(/(\d+(?:\.\d+)?)px/);
  return m ? Number(m[1]) : null;
}

describe('首屏输入列宽', () => {
  it('自检: 两个变量都真的读到了', () => {
    /* 对照组 —— 正则或路径写错时这条先红, 免得下面的断言在空集上假绿 */
    expect(declarations('atl-empty-col').length).toBeGreaterThan(0);
    expect(declarations('atl-content-max').length).toBeGreaterThan(0);
  });

  it('--atl-empty-col 只声明一处', () => {
    /* 这个文件里同一属性叠着好几代是常态, 赢的是行号最大那份。
     * 这一列只有一个真相源, 多一处就说明有人又叠了一代。 */
    expect(declarations('atl-empty-col')).toHaveLength(1);
  });

  it('首屏列比对话态列窄', () => {
    const empty = pxArm(declarations('atl-empty-col')[0]);
    const wide = Math.max(...declarations('atl-content-max').map((v) => pxArm(v) ?? 0));
    expect(empty).not.toBeNull();
    expect(wide).toBeGreaterThan(0);
    expect(empty as number).toBeLessThan(wide);
  });

  it('窄窗口下要能收: 值里带 100% 那一支', () => {
    expect(declarations('atl-empty-col')[0]).toMatch(/min\(\s*\d+(?:\.\d+)?px\s*,\s*100%\s*\)/);
  });
});
