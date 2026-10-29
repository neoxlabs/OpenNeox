import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CSS = readFileSync(join(__dirname, '..', 'agent-timeline.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, (m) => '\n'.repeat((m.match(/\n/g) ?? []).length));

/** 取所有选中 .md-code-block 本身(不含后代)的规则体。 */
function codeBlockRules(): Array<{ sel: string; body: string }> {
  const out: Array<{ sel: string; body: string }> = [];
  const re = /([^{}]*\.md-code-block)\s*\{([^}]*)\}/g;
  for (const m of CSS.matchAll(re)) {
    const sel = m[1].trim();
    if (/\.md-code-block\s+\S/.test(sel)) continue; // 后代选择器, 不是块本身
    out.push({ sel, body: m[2] });
  }
  return out;
}

describe('浅色下的代码块表面', () => {
  it('自检: 确实读到了代码块规则', () => {
    const rules = codeBlockRules();
    expect(rules.length, '一条都没读到, 闸失效了').toBeGreaterThan(0);
    expect(CSS).toContain('md-code-block');
  });

  it('有一条浅色专属规则, 且不是白叠白', () => {
    const light = codeBlockRules().filter((r) => /\[data-theme="light"\]/.test(r.sel) && /background/.test(r.body));
    expect(light.length, '浅色没有自己的 background —— 会落到深色那条白叠白上').toBeGreaterThan(0);
    for (const r of light) {
      expect(r.body,
        `浅色下 bg-elevated 是近白色, 叠在白底页面上看不见: ${r.sel.slice(0, 70)}`)
        .not.toMatch(/--neox-bg-elevated[^;]*transparent/);
    }
  });

  it('浅色下靠边框立住 (白底上的块没边框就散了)', () => {
    const light = codeBlockRules().filter((r) => /\[data-theme="light"\]/.test(r.sel) && /background/.test(r.body));
    const withBorder = light.filter((r) => /border:\s*1px/.test(r.body));
    expect(withBorder.length, '浅色规则里要有 1px 描边').toBeGreaterThan(0);
    expect(withBorder[0].body, '描边别用 0').not.toMatch(/border:\s*0/);
  });

  it('顶部留白不许收 —— 那是给 hover 浮出的 Copy 让的位', () => {
    // 留白归 markdown-message.css 管 (.md-code-block pre), 不在本文件里。
    const md = readFileSync(
      join(__dirname, '..', '..', '..', 'styles', 'editor-core', 'text-ui', 'markdown-message.css'), 'utf8');
    const m = /\.md-code-block\s+pre\s*\{([^}]*)\}/.exec(md);
    expect(m, '找不到 .md-code-block pre 的规则, 闸失效了').toBeTruthy();
    const top = /padding:\s*(\d+)px/.exec(m![1]);
    expect(top, 'pre 没有顶部留白了').toBeTruthy();
    expect(Number(top![1]), '顶部留白被收掉, Copy 会压在第一行字上').toBeGreaterThanOrEqual(18);
  });
});
