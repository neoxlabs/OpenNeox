import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');   // renderer/

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '__tests__') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.css$/.test(e)) out.push(p);
  }
  return out;
}
const blank = (m: string) => '\n'.repeat((m.match(/\n/g) ?? []).length);

type Hit = { eff: number; sel: string; file: string; line: number };

function scan(): { hits: Hit[]; sawLinenum: boolean } {
  const hits: Hit[] = [];
  let sawLinenum = false;
  for (const f of walk(ROOT)) {
    const s = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, blank);
    for (const m of s.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sel = (m[1] ?? '').split(/\s+/).filter(Boolean).join(' ');
      const body = m[2] ?? '';
      if (sel.startsWith('@')) continue;
      const op = body.match(/(?<![-\w])opacity\s*:\s*([\d.]+)/);
      if (!op || Number(op[1]) >= 1) continue;
      const col = body.match(/(?<![-\w])color\s*:\s*([^;]+);/);
      if (!col) continue;
      let alpha: number | null = null;
      const a1 = col[1].match(/rgba\([^)]*,\s*([\d.]+)\s*\)/);
      if (a1) alpha = Number(a1[1]);
      const a2 = col[1].match(/color-mix\([\s\S]*?(\d+)%\s*,\s*transparent\)/);
      if (a2) alpha = Number(a2[1]) / 100;
      if (alpha === null || alpha >= 1) continue;
      if (sel.includes('md-code-linenum')) sawLinenum = true;
      /* opacity: 0 是"藏起来", 不是淡化叠加 */
      if (Number(op[1]) === 0) continue;
      hits.push({ eff: alpha * Number(op[1]), sel: sel.slice(0, 60),
        file: f.slice(ROOT.length), line: s.slice(0, m.index ?? 0).split('\n').length });
    }
  }
  return { hits, sawLinenum };
}

const BASELINE = 1;   // 只许减不许加

describe('淡化不许叠两遍', () => {
  it('测试确实扫到了 CSS (自检)', () => {
    expect(walk(ROOT).length).toBeGreaterThan(100);
  });

  it('对照: 已修的行号规则不该再被算作双重淡化', () => {
    expect(scan().sawLinenum,
      '它的 opacity 已经归 1 —— 如果这里为 true, 说明有人把 0.35 改回来了').toBe(false);
  });

  it('双重淡化只许减不许加', () => {
    const { hits } = scan();
    const detail = hits.map(h => `${h.file}:${h.line} 有效${h.eff.toFixed(3)} ${h.sel}`).join(' / ');
    expect(hits.length,
      `颜色本身带 alpha 时再设 opacity = 淡化两遍, 实测能把文字压到对比 1.36(看不见)。`
      + `要么去掉 opacity, 要么把颜色改成实色。当前: ${detail}`,
    ).toBeLessThanOrEqual(BASELINE);
  });
});
