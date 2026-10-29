import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const RENDERER = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function walkCss(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkCss(p, out);
    else if (name.endsWith('.css')) out.push(p);
  }
  return out;
}

/** `animation: … var(--neox-dur-*) … infinite` —— 循环却用了过渡时长 */
const BAD = /animation:[^;]*var\(--neox-dur-(?:fast|base|normal|slow)\)[^;]*infinite[^;]*;/g;

describe('循环动画周期', () => {
  it('没有任何 infinite 动画拿过渡时长当周期', () => {
    const hits: string[] = [];
    for (const f of walkCss(RENDERER)) {
      const css = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const m of css.match(BAD) ?? []) {
        hits.push(`${relative(RENDERER, f)}: ${m.trim().slice(0, 90)}`);
      }
    }
    expect(
      hits,
      `循环动画请用 --neox-loop-breathe (呼吸/脉冲) 或 --neox-loop-shimmer (骨架屏/流光);\n`
      + `--neox-dur-* 是一次性过渡的时长, 当周期用会每秒闪好几次:\n${hits.join('\n')}`,
    ).toEqual([]);
  });

  it('两个循环令牌都定义了, 且远大于过渡时长', () => {
    const tokens = readFileSync(join(RENDERER, 'styles/theme-tokens/neox.css'), 'utf8');
    const num = (name: string) => Number((tokens.match(new RegExp(`${name}:\\s*(\\d+)ms`)) ?? [])[1]);
    const fast = num('--neox-dur-fast');
    expect(num('--neox-loop-breathe')).toBeGreaterThan(fast * 5);
    expect(num('--neox-loop-shimmer')).toBeGreaterThan(fast * 5);
  });
});
