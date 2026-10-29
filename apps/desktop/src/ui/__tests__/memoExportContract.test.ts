
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/* 本文件从 renderer/ 挪到了 ui/__tests__/ —— 它要用 node:fs 扫源码, 而
 * check-import-boundaries 的 renderer 纯度闸禁止渲染层引 node 内建 (闸是对的:
 * renderer 跑在浏览器)。测试本身不进 bundle, 但闸按目录判定, 所以挪出来。 */
const RENDERER_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'renderer');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '__tests__') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

describe('memo 导出契约 · 别把 memo 挂在没人用的导出上', () => {
  const files = walk(RENDERER_ROOT);

  it('扫描到了 renderer 下的组件文件 (确保这条测试不是空跑)', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('不存在"具名导出未 memo, 而 default 才 memo"的组件', () => {
    const offenders: string[] = [];

    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      const m = src.match(/export default React\.memo\((\w+)\)/);
      if (!m) continue;
      const name = m[1]!;

      /* 同名具名导出直接是原始实现 (function / const 箭头) —— 这就是绕过 memo 的形态。
       * 合法写法是 `export const X = React.memo(XImpl)` 或干脆只留 default。 */
      const namedRaw = new RegExp(`^export (?:const|function) ${name}\\b(?!\\s*=\\s*React\\.memo)`, 'm');
      if (namedRaw.test(src)) {
        offenders.push(`${file.replace(RENDERER_ROOT, '')} → export const ${name} 未 memo, 但 default 是 React.memo(${name})`);
      }
    }

    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
