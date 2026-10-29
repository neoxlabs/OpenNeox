import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(__dirname, '../../../../..');

function builderLines(): Array<{ file: string; line: number; text: string }> {
  const out: Array<{ file: string; line: number; text: string }> = [];
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir)) {
      if (e === 'node_modules') continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e) && !e.includes('.test.')) files.push(p);
    }
  };
  walk(join(REPO, 'apps', 'desktop', 'src'));
  for (const f of files) {
    const lines = readFileSync(f, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!/['"`]neox-asset:\/\//.test(line)) return;
      const t = line.trim();
      if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) return;
      const rel = f.replace(REPO, '').replace(/^[\\/]+/, '').replace(/\\/g, '/');
      out.push({ file: rel, line: i + 1, text: t });
    });
  }
  return out;
}

describe('neox-asset:// 构造点必须带 host', () => {
  it('每一处拼接都要有 host 段 (否则首段路径被吃掉 -> 403)', () => {
    const bad = builderLines().filter((r) => {
      const m = r.text.match(/['"`]neox-asset:\/\/([^'"`$]*)/);
      if (!m) return false;
      return !/^local/.test(m[1]);
    });
    expect(
      bad.map((b) => `${b.file}:${b.line}  ${b.text.trim().slice(0, 80)}`),
      '这些地方少了 host 段, 图会 403',
    ).toEqual([]);
  });

  it('扫描本身有效 —— 至少认出几个已知构造点, 别因为 grep 挂了变成空绿', () => {
    expect(builderLines().length).toBeGreaterThanOrEqual(2);
  });

  it('只有 shared/assetUrlPath.ts 能手拼 neox-asset URL', () => {
    const handBuilt = builderLines().filter((r) =>
      /['"`]neox-asset:\/\/local['"`]?\s*\+|`neox-asset:\/\/local\$\{/.test(r.text)
      && !r.file.endsWith('shared/assetUrlPath.ts'));
    expect(
      handBuilt.map((b) => `${b.file}:${b.line}  ${b.text.trim().slice(0, 80)}`),
      '改用 shared/assetUrlPath.ts 的 absoluteToAssetUrl',
    ).toEqual([]);
  });

});
