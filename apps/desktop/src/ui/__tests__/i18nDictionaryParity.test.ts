
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = readFileSync(resolve(__dirname, '../renderer/i18n/index.ts'), 'utf8');

/** 取出 `const <name>: Translations = { … }` 的对象体 */
function objectBody(name: string): string {
  const i = SRC.indexOf(`const ${name}: Translations = {`);
  expect(i, `没找到 const ${name}: Translations —— 词典结构变了, 这条测试要跟着改`).toBeGreaterThan(-1);
  const start = SRC.indexOf('{', i);
  let depth = 0;
  for (let k = start; k < SRC.length; k++) {
    if (SRC[k] === '{') depth++;
    else if (SRC[k] === '}' && --depth === 0) return SRC.slice(start, k + 1);
  }
  throw new Error(`${name} 的对象体没有闭合`);
}

/** 把字符串字面量替换成占位符 —— 否则值里的冒号会被当成键 */
function stripStrings(text: string): string {
  return text.replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``');
}

function keyPaths(body: string): Set<string> {
  const text = stripStrings(body);
  const out = new Set<string>();
  const path: Array<string | null> = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '}') { path.pop(); i++; continue; }
    const m = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(text.slice(i));
    if (m) {
      const rest = text.slice(i + m[0].length).replace(/^\s*/, '');
      const named = [...path.filter((p): p is string => !!p), m[1]!].join('.');
      if (rest.startsWith('{')) {
        path.push(m[1]!);
        i += m[0].length + (text.slice(i + m[0].length).length - rest.length) + 1;
      } else {
        out.add(named);
        i += m[0].length;
      }
      continue;
    }
    if (c === '{') { path.push(null); }
    i++;
  }
  return out;
}

describe('i18n 词典 · 中英键必须对齐', () => {
  const zh = keyPaths(objectBody('zh'));
  const en = keyPaths(objectBody('en'));

  it('夹具有效性: 两边都解析出了足够多的键 (否则整条是空跑)', () => {
    expect(zh.size).toBeGreaterThan(300);
    expect(en.size).toBeGreaterThan(300);
  });

  it('en 不缺键 —— 缺了会静默回落成中文, 英文界面里冒中文', () => {
    expect([...zh].filter((k) => !en.has(k)).sort()).toEqual([]);
  });

  it('zh 不缺键 —— 缺了中文界面直接拿到 undefined', () => {
    expect([...en].filter((k) => !zh.has(k)).sort()).toEqual([]);
  });
});
