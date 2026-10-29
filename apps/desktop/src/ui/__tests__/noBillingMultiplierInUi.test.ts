
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

const RENDERER = resolve(__dirname, '../renderer');

/** 允许持有/传递倍率的地方 —— 纯数据层, 不渲染 */
const ALLOW = [
  'billing/types.ts',
  'billing/modelEntitlement.ts',
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== '__tests__') walk(p, out); }
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** 粗暴但够用: 去掉块注释和行注释, 只看真正会执行/渲染的代码 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('界面上不得出现计费倍率', () => {
  const files = walk(RENDERER);

  it('夹具有效性: 真的扫到了渲染层源码 (否则整条是空跑)', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.endsWith('TimelineComposer.tsx'))).toBe(true);
  });

  it('没有任何组件把 multiplier 渲染出来', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const rel = f.slice(RENDERER.length + 1);
      if (ALLOW.some((a) => rel.replace(/\\/g, '/').endsWith(a))) continue;
      const code = stripComments(readFileSync(f, 'utf8'));
      code.split('\n').forEach((line, i) => {
        /* JSX 插值里出现 multiplier, 或拼出 "N×" 的倍率文案 */
        if (/\{[^}]*\bmultiplier\b[^}]*\}/.test(line) || /\bmultiplier\b[^\n]*×/.test(line)) {
          offenders.push(`${rel}:${i + 1}  ${line.trim().slice(0, 90)}`);
        }
      });
    }
    expect(offenders, [
      '这些地方把计费倍率渲染到界面上了。用户明确拍板: 倍率不展示给用户, 我们自己算。',
      '数据可以持有 (服务端扣点用), 但不要显示。',
    ].join('\n')).toEqual([]);
  });
});
