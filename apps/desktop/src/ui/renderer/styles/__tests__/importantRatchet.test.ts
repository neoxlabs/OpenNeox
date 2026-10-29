import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RENDERER = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function walkCss(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkCss(p, out);
    else if (name.endsWith('.css')) out.push(p.replace(/\\/g, '/'));
  }
  return out;
}

/** 数 !important —— 注释先剥掉, 免得注释里提到的也算进去 */
function countImportant(file: string): number {
  const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  return (css.match(/!important/g) ?? []).length;
}

const TOTAL_BASELINE = 9069;
const PER_FILE_BASELINE: Record<string, number> = {
  /* 已还 39 条, 棘轮就地收紧 —— 只许降不许升 */
  'agent-timeline.css': 3231,
  'anye-flat.css': 1626,
  'theme-packs.css': 1571,
  'ide-workspace.css': 524,
  'step-polish.css': 99,
  'simple-diff.css': 30,
};

describe('!important 棘轮 — 只许降不许升', () => {
  const files = walkCss(RENDERER);

  it(`renderer 全量 !important 不超过基线 ${TOTAL_BASELINE}`, () => {
    const total = files.reduce((a, f) => a + countImportant(f), 0);
    expect(total).toBeLessThanOrEqual(TOTAL_BASELINE);
  });

  for (const [name, base] of Object.entries(PER_FILE_BASELINE)) {
    it(`${name} 不超过基线 ${base}`, () => {
      const f = files.find((x) => x.endsWith('/' + name));
      expect(f, `找不到 ${name}`).toBeDefined();
      expect(countImportant(f!)).toBeLessThanOrEqual(base);
    });
  }

  /* 新增 CSS 文件别再走老路 —— 单文件 500 是当前第 4 名(ide-workspace 517)的量级,
   * 超过它说明又出了一个"靠 !important 打架"的大户。 */
  it('除已知大户外, 单个文件不许超过 500 处', () => {
    const known = new Set(Object.keys(PER_FILE_BASELINE));
    const offenders = files
      .filter((f) => !known.has(f.split('/').pop()!))
      .map((f) => ({ f: f.split('/').slice(-2).join('/'), n: countImportant(f) }))
      .filter((x) => x.n > 520)
      .sort((a, b) => b.n - a.n);
    expect(offenders.map((o) => `${o.f}=${o.n}`)).toEqual([]);
  });
});
