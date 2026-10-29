import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** 返回文件里"处在非组件函数内"的 hook 调用行号 */
function badHookLines(src: string): Array<{ line: number; owner: string; hook: string }> {
  /* 先剥注释 —— 文件头的接入说明里就写着 "useAuth(): displayName / ..." 这种,
   * 不剥的话全是误报, 而一个总在叫的检查器等于没有检查器。
   * 行数要保住 (报错要能指到行), 所以用等长空白替换而不是删行。 */
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
  const lines = stripped.split('\n');
  const bad: Array<{ line: number; owner: string; hook: string }> = [];
  /* 顶层函数声明: const Foo = (...) => {  /  function Foo(...) {  */
  /* export default function X 也是顶层声明 —— 漏了 default 时, 默认导出的组件里的 hook 会被算到上面那个工具函数头上 (DiagnosticsTab 误报) */
  const declRe = /^(?:export\s+)?(?:default\s+)?(?:const|function)\s+([A-Za-z_$][\w$]*)/;
  const hookRe = /(?:^|[^.\w])(use[A-Z]\w*)\s*\(/;

  let owner = '(module)';
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    /* 顶格 (0 缩进) 的声明才算换了 owner —— 嵌套的匿名回调不改归属 */
    const d = declRe.exec(l);
    if (d && /^[A-Za-z_$]|^export/.test(l)) { owner = d[1]; depth = 0; }
    const hit = hookRe.exec(l);
    if (hit) {
      const isComponent = /^[A-Z]/.test(owner);
      const isCustomHook = /^use[A-Z]/.test(owner);
      if (!isComponent && !isCustomHook) {
        bad.push({ line: i + 1, owner, hook: hit[1] });
      }
    }
    depth += (l.match(/\{/g)?.length ?? 0) - (l.match(/\}/g)?.length ?? 0);
  }
  return bad;
}

describe('hook 必须在组件或自定义 hook 里', () => {
  const files = readdirSync(here).filter((f) => f.endsWith('.tsx'));

  for (const f of files) {
    it(`${f} 没有放错位置的 hook`, () => {
      const src = readFileSync(join(here, f), 'utf8');
      const bad = badHookLines(src);
      assert.deepEqual(
        bad,
        [],
        `这些 hook 处在普通函数里, 会导致 React #310 (渲染时 hook 数量不稳定):\n` +
          bad.map((b) => `  ${f}:${b.line}  ${b.hook}() 在 ${b.owner}() 内`).join('\n'),
      );
    });
  }
});
