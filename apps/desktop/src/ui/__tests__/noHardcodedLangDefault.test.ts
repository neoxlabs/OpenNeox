
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

const RENDERER = resolve(__dirname, '../renderer');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== '__tests__') walk(p, out); }
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** `isZh = true` / `zh = false` / `isZh: boolean = true` 这类写死的默认值 */
const BAD = /\b(isZh|zh|isChinese)\s*(?::\s*boolean\s*)?=\s*(true|false)\b/;

describe('语言参数默认值', () => {
  const files = walk(RENDERER);

  it('夹具有效性: 真的扫到了渲染层源码', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('没有任何地方把语言默认成写死的布尔', () => {
    const offenders: string[] = [];
    for (const f of files) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (line.trim().startsWith('*') || line.trim().startsWith('//')) return;
        if (BAD.test(line)) offenders.push(`${f.slice(RENDERER.length + 1)}:${i + 1}  ${line.trim().slice(0, 90)}`);
      });
    }
    expect(offenders, [
      '语言参数的默认值不能写死成 true/false —— "调用方没传"应当跟随全局语言,',
      '而不是悄悄退化成中文 (图像工坊整页永远中文就是这么来的)。',
      '改用 defaultIsZh() (hooks/useI18n)。',
    ].join('\n')).toEqual([]);
  });
});
