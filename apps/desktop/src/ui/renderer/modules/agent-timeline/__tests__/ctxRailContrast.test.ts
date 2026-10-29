import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CSS = readFileSync(
  join(__dirname, '..', 'agent-timeline-context-rail.css'), 'utf8');
const CODE = CSS.replace(/\/\*[\s\S]*?\*\//g, m => '\n'.repeat((m.match(/\n/g) ?? []).length));

describe('右栏文字颜色', () => {
  it('测试指着的确实是右栏样式 (路径自检)', () => {
    expect(CODE).toContain('.atl-ctx-rail__head');
    expect(CODE).toContain('.atl-ctx-rail__diff-add');
  });

  it('分组标题不用 fg-hint (白底 3.15, 不达 AA)', () => {
    const at = CODE.indexOf('.atl-ctx-rail__head {');
    expect(at).toBeGreaterThan(0);
    const rule = CODE.slice(at, CODE.indexOf('}', at));
    expect(rule, 'hint 这一档在白底上是 3.15 —— 常驻可见的 12px 正文要用 muted')
      .not.toMatch(/--neox-fg-hint/);
    expect(rule).toMatch(/--neox-fg-muted/);
  });

  it('diff 数字有浅色主题覆盖, 且用项目已有的值', () => {
    expect(CODE, '缺 light 覆盖时会用暗底绿 #10b981, 白底对比 2.54')
      .toMatch(/:root\[data-theme="light"\]\s+\.atl-ctx-rail__diff-add/);
    expect(CODE).toMatch(/:root\[data-theme="light"\]\s+\.atl-ctx-rail__diff-del/);
    /* 值要跟项目其它 diff 处一致 —— 不许各写各的 */
    expect(CODE).toMatch(/#16a34a/);
    expect(CODE).toMatch(/#dc2626/);
  });
});
