/* eslint-disable */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'assets', 'backgrounds');
const OUT = join(HERE, '..', 'src', 'assets', 'backgrounds.generated.ts');

const table = {};
for (const f of readdirSync(SRC).filter((n) => n.endsWith('.jpg')).sort()) {
  const m = f.match(/^(.+)--(cover|section|content)\.jpg$/);
  if (!m) throw new Error(`文件名不合约定: ${f}`);
  (table[m[1]] ||= {})[m[2]] = `data:image/jpeg;base64,${readFileSync(join(SRC, f)).toString('base64')}`;
}

const lines = [
  '/* 自动生成 —— 改 assets/backgrounds/*.jpg 后跑 node scripts/bake-backgrounds.mjs, 别手改 */',
  'export type BackgroundRole = \'cover\' | \'section\' | \'content\';',
  'export const STYLE_BACKGROUNDS: Record<string, Partial<Record<BackgroundRole, string>>> = {',
  ...Object.entries(table).map(([style, roles]) =>
    `  ${JSON.stringify(style)}: {\n${Object.entries(roles).map(([r, d]) => `    ${r}: ${JSON.stringify(d)},`).join('\n')}\n  },`),
  '};',
  '',
];
writeFileSync(OUT, lines.join('\n'));
console.log(`baked ${Object.keys(table).length} styles → ${OUT}`);
