
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CSS = readFileSync(
  resolve(__dirname, '../renderer/modules/agent-timeline/agent-timeline.css'), 'utf8');

function ruleBody(selector: string): string {
  const i = CSS.indexOf(`\n${selector} {`);
  expect(i, `没找到 CSS 规则 ${selector} —— 样式被改名了, 这条测试要跟着改`).toBeGreaterThan(-1);
  return CSS.slice(i, CSS.indexOf('\n}', i));
}

describe('.atl-model__search 表头', () => {
  const body = ruleBody('.atl-model__search');

  it('夹具有效性: 真的读到了规则内容', () => {
    expect(body).toContain('height');
  });

  /* ↓ 这条是核心: 没有它, 列表一长搜索框就被压扁 */
  it('必须禁止被压缩 (flex-shrink: 0)', () => {
    expect(/flex:\s*0\s+0\s+auto|flex-shrink:\s*0/.test(body),
      '菜单是 flex 列, 少了 flex-shrink:0 搜索框会被长列表挤瘪 (实测 28px → 19px)').toBe(true);
  });

  it('高度要撑得住, 不能再是一条缝', () => {
    const h = body.match(/height:\s*(\d+)px/);
    expect(h, '搜索表头应显式声明 height').not.toBeNull();
    expect(Number(h![1]), '低于 32px 在 41px 高的列表行旁边会显得畸形').toBeGreaterThanOrEqual(32);
  });

  it('不画外框 —— 菜单里其它元素都是无边框的, 只留底部发丝线', () => {
    expect(/border-bottom:\s*1px/.test(body), '应保留底部发丝线做表头分隔').toBe(true);
    const borderValue = body.match(/^\s*border:\s*([^;]+);/m)?.[1]?.trim();
    expect(borderValue === undefined || borderValue === '0' || borderValue === 'none',
      `整圈边框应为 0, 实际是 "${borderValue}"`).toBe(true);
    expect(/border-radius:\s*[1-9]/.test(body), '表头是满宽的, 不该有圆角').toBe(false);
  });
});
