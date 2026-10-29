/* work:M-03 —— 滚动期不再有 `:has()` 祖先重算。
 *
 *   audit T3: `agent-timeline.css` 里 206 处 `:has()`，滚动时每个后代 class 变化
 *   都会让祖先参与失效重算。做法是把"看子节点类型决定样式"的结论改到渲染期
 *   (data-content-type / data-has-image / data-atl-wide-content …)，CSS 只留属性判断。
 *
 *   这里守住三件事:
 *     1. feed 相关 CSS 里没有 `:has()`（注释里出现不算）;
 *     2. 滚动期的毛玻璃是"一律 none"（逐类列举会漏）;
 *     3. 渲染侧标记与 CSS 消费的属性名对得上 —— 只改一边会静默失效。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(__dirname, '..');
const CSS = readFileSync(join(DIR, 'agent-timeline.css'), 'utf8');
const RAIL_CSS = readFileSync(join(DIR, 'agent-timeline-context-rail.css'), 'utf8');

/** 去掉注释 —— 注释里提到 `:has()` 是说明文字, 不是规则。 */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('work:M-03 · 滚动期 :has 重算', () => {
  it('agent-timeline.css 的规则里不再有 :has()', () => {
    const code = stripComments(CSS);
    const hits = code.match(/:has\(/g) ?? [];
    expect(hits.length, ':has() 会让祖先在滚动期参与失效重算, 应改成渲染期 data-* 标记')
      .toBe(0);
  });

  it('context rail 的规则里也不再有 :has() (含插件图标那条)', () => {
    const code = stripComments(RAIL_CSS);
    const hits = code.match(/:has\(/g) ?? [];
    expect(hits.length, ':has() 会让祖先参与失效重算, 应改成渲染期 data-*/class')
      .toBe(0);
  });

  it('插件图标外圈用渲染期 is-app-icon, 不是 :has(> .atl-ctx-rail__appicon)', () => {
    const code = stripComments(RAIL_CSS);
    expect(code).toContain('.atl-ctx-rail__icon.is-app-icon');
    const tsx = readFileSync(join(DIR, 'AgentTimelineContextRail.tsx'), 'utf8');
    expect(tsx).toContain('is-app-icon');
  });

  it('滚动期毛玻璃一律关掉 (不是逐类列举)', () => {
    const code = stripComments(CSS);
    const rule = /\.atl-feed\[data-atl-scrolling="1"\]\s*\*\s*\{([^}]*)\}/.exec(code);
    expect(rule, '滚动期没有通配的 backdrop-filter 关闭规则').toBeTruthy();
    expect(rule![1]).toMatch(/backdrop-filter:\s*none\s*!important/);
    expect(rule![1]).toMatch(/-webkit-backdrop-filter:\s*none\s*!important/);
  });

  it('滚动控制器在滚动期打标、空闲时摘标 (否则规则永远不生效或毛玻璃回不来)', () => {
    const hook = readFileSync(
      join(DIR, 'hooks', 'useTimelineScrollController.ts'),
      'utf8',
    );
    expect(hook).toContain('setAttribute("data-atl-scrolling", "1")');
    expect(hook).toContain('removeAttribute("data-atl-scrolling")');
  });

  it('shell 标记用归一化后的连字符取值 (与 TimelineStep 的 is-content-* 同口径)', () => {
    const code = stripComments(CSS);
    expect(code).toContain('.atl-tool__content-shell[data-content-type="turn-summary"]');
    expect(code).not.toContain('.atl-tool__content-shell[data-content-type="turn_summary"]');
  });

  it('渲染期标记与 CSS 消费的属性名一致', () => {
    const code = stripComments(CSS);
    for (const attr of [
      'data-content-type="turn_summary"',
      'data-content-type="plan"',
      'data-content-type="error"',
      'data-content-type="log"',
      'data-content-type="askUser"',
      'data-content-type="neox_card"',
      'data-content-type="timer_card"',
      'data-browser-result',
      'data-browser-success',
      'data-has-image',
      'data-ask-settled',
      'data-atl-wide-content',
      'data-atl-virtual-space',
      'data-cols-wide',
      'data-plain',
    ]) {
      expect(code.includes(`[${attr}`), `CSS 没有消费 ${attr}`).toBe(true);
    }
  });

  it('虚拟化占位标记由 TimelineSteps 打在 feed 上', () => {
    const tsx = readFileSync(join(DIR, 'TimelineSteps.tsx'), 'utf8');
    expect(tsx).toContain('data-atl-virtual-space');
    expect(tsx).toContain('data-atl-wide-content');
  });

  it('shell / code 容器在渲染期打标记', () => {
    const shell = readFileSync(join(DIR, 'TimelineStep.tsx'), 'utf8');
    expect(shell).toContain('data-content-type={normalizedContentType}');
    expect(shell).toContain('data-ask-settled={contentAskSettled}');
    const code = readFileSync(join(DIR, 'cells/CodeView.tsx'), 'utf8');
    expect(code).toContain("'data-has-image'");
  });
});
