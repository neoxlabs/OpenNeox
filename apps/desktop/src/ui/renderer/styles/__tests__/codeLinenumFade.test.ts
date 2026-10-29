import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CSS = readFileSync(
  join(__dirname, '..', 'theme-tokens', 'theme-packs.css'), 'utf8');
const CODE = CSS.replace(/\/\*[\s\S]*?\*\//g, m => '\n'.repeat((m.match(/\n/g) ?? []).length));

/** 取某个选择器的规则体 */
function ruleBody(sel: string): string {
  const at = CODE.indexOf(sel);
  if (at < 0) return '';
  const open = CODE.indexOf('{', at);
  const close = CODE.indexOf('}', open);
  return CODE.slice(open, close);
}

const SEL = ':root[data-theme-pack] .markdown-content .md-code-block .md-code-linenum';

describe('代码块行号的淡化', () => {
  it('测试指着的确实是那条主题包规则 (路径自检)', () => {
    expect(CODE).toContain(SEL);
    expect(ruleBody(SEL).length).toBeGreaterThan(20);
  });

  it('color 已经是半透明色, 就不能再叠 opacity', () => {
    const body = ruleBody(SEL);
    expect(body, '这条的 color 是 color-mix(... 45%, transparent), 本身就带淡化')
      .toMatch(/color-mix\([\s\S]*?transparent\)/);   /* 不能用 [^)]* —— 值里的 var(...) 自带一个 ) */
    const m = body.match(/opacity:\s*([\d.]+)/);
    expect(m, '这条规则应当显式写 opacity —— 拿掉它会让 agent-timeline 的 0.18 生效, 反而更淡')
      .not.toBeNull();
    expect(Number(m![1]),
      'opacity 再乘一次 = 淡化两遍。实测 0.35 × 45% = 0.158, 白底对比 1.36, 看不见')
      .toBe(1);
  });
});
