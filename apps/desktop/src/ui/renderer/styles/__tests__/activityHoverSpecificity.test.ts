import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CSS = readFileSync(
  join(__dirname, '..', '..', 'modules', 'agent-timeline', 'agent-timeline.css'), 'utf8');
/* 注释换成等量换行 —— 源码注释里正当地引用了这些选择器 */
const CODE = CSS.replace(/\/\*[\s\S]*?\*\//g, m => '\n'.repeat((m.match(/\n/g) ?? []).length));

const BASE = '.agent-timeline .atl-activity:not(.is-plain) .atl-activity__head';
const SCOPES = [
  ':root[data-theme-pack][data-theme] ',
  ':root[data-theme-preset][data-theme] ',
  '[data-theme] ',
];

describe('活动行 hover 的特异度', () => {
  it('测试指着的确实是 agent-timeline.css (路径自检)', () => {
    expect(CODE).toContain('atl-activity__head');
    expect(CODE.length).toBeGreaterThan(100_000);
  });

  it('基态确实带了主题包作用域 —— 这是这条闸存在的前提', () => {
    for (const s of SCOPES) {
      expect(CODE, `基态少了 ${s}, 那这条闸的前提变了, 请重新确认`).toContain(s + BASE + ',');
    }
  });

  it('hover 带上了同样的作用域, 否则会被基态压死', () => {
    const missing = SCOPES.filter(s => !CODE.includes(s + BASE + ':hover'));
    expect(missing,
      `hover 少了这些作用域变体 → 特异度低于基态(两边都是 !important) → 启用主题包时 hover 无效: ${missing.join(' / ')}`,
    ).toEqual([]);
  });
});
