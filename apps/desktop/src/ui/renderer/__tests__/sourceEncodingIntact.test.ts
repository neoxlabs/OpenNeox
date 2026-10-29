
import { describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../../../..');   // apps/desktop/src

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

const COMMENT = /^\s*(\*|\/\/|\/\*)/;
const MOJIBAKE = /\?{3,}/;
const HAS_CJK = /[一-鿿]/;

describe('源码编码完整性', () => {
  test('没有任何文件的注释被写成连续问号', () => {
    const bad: string[] = [];
    for (const f of walk(ROOT)) {
      /* 本文件的说明里就引着那串坏掉的原文, 跳过自己 */
      if (f.endsWith('sourceEncodingIntact.test.ts')) continue;
      const lines = fs.readFileSync(f, 'utf8').split('\n');
      const n = lines.filter((l) => COMMENT.test(l) && MOJIBAKE.test(l) && !HAS_CJK.test(l)).length;
      if (n > 0) bad.push(`${path.relative(ROOT, f)} (${n} 行)`);
    }
    expect(bad, `这些文件的中文注释被写坏了: ${bad.join(' / ')}`).toEqual([]);
  });
});
