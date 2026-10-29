import { describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SRC = fs.readFileSync(
  path.resolve(__dirname, '..', 'components', 'Icons.tsx'),
  'utf8',
);

const FILE_TYPE_GRID = 16;
const EXEMPT_PREFIX = ['TW', 'JB', 'Neox'];
const EXEMPT_NAMES = new Set(['TreeChevronRight']);

type Icon = { name: string; viewBox: number; strokes: number[] };

function parseIcons(): Icon[] {
  const out: Icon[] = [];
  const re = /^ {2}([A-Za-z0-9_]+): \((?:props: SvgIconProps)?\) => \(\n([\s\S]*?)\n {2}\),/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(SRC))) {
    const [, name, body] = m;
    const vb = /viewBox="([-\d. ]+)"/.exec(body);
    if (!vb) continue;
    const parts = vb[1].trim().split(/\s+/).map(Number);
    if (parts.length !== 4) continue;
    const strokes = [...body.matchAll(/strokeWidth="([\d.]+)"/g)].map((s) => Number(s[1]));
    out.push({ name, viewBox: parts[2], strokes });
  }
  return out;
}

const ICONS = parseIcons();

describe('图标描边', () => {
  test('解析得到足够多的图标 —— 正则失效时这条先红, 而不是"全都通过"', () => {
    expect(ICONS.length).toBeGreaterThan(80);
  });

  test('UI 图标渲染出来的描边一律 1.5px', () => {
    const offenders: string[] = [];
    for (const ic of ICONS) {
      if (ic.viewBox === FILE_TYPE_GRID) continue;
      if (EXEMPT_PREFIX.some((p) => ic.name.startsWith(p))) continue;
      if (EXEMPT_NAMES.has(ic.name)) continue;
      for (const sw of ic.strokes) {
        const effective = sw * (20 / ic.viewBox);
        if (Math.abs(effective - 1.5) > 0.06) {
          offenders.push(`${ic.name} (viewBox ${ic.viewBox}, strokeWidth ${sw} → ${effective.toFixed(2)}px)`);
        }
      }
    }
    expect(offenders, `这些图标摆在一排里会比邻居虚一档:\n  ${offenders.join('\n  ')}`).toEqual([]);
  });

  test('20 网格仍然是主力 —— 别把例外反过来变成常态', () => {
    const grid20 = ICONS.filter((i) => i.viewBox === 20).length;
    expect(grid20).toBeGreaterThan(ICONS.length * 0.5);
  });
});
