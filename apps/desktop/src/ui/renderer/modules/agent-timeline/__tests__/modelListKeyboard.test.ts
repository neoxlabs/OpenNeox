import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(__dirname, '..', 'TimelineComposer.tsx'), 'utf8');
const CODE = SRC
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, m => '\n'.repeat((m.match(/\n/g) ?? []).length))
  .replace(/\/\*[\s\S]*?\*\//g, m => '\n'.repeat((m.match(/\n/g) ?? []).length))
  .replace(/^\s*\/\/.*$/gm, '');
const CSS = readFileSync(join(__dirname, '..', 'agent-timeline.css'), 'utf8');

describe('模型清单的键盘选择', () => {
  it('测试指着的确实是模型选择器 (路径自检)', () => {
    expect(CODE).toContain('atl-model__menu--list');
    expect(CODE).toContain('role="listbox"');
  });

  it('搜索框处理 ↑↓ / Home / End / Enter', () => {
    for (const k of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter']) {
      expect(CODE, `要处理 ${k}`).toContain(`'${k}'`);
    }
    expect(CODE, '要在清单里按 role=option 找项').toMatch(/\[role="option"\]/);
    expect(CODE, 'Enter 要真的触发选中').toMatch(/opts\[cur\]\.click\(\)/);
  });

  it('只在可见项之间移动 —— 过滤后隐藏的行不能被选中', () => {
    expect(CODE).toMatch(/offsetParent !== null/);
  });

  it('搜索词变化要清掉旧的键盘高亮', () => {
    expect(CODE).toMatch(/\[data-kb-active\]/);
    expect(CODE, '要挂在 modelQuery 上').toMatch(/\}, \[modelQuery\]\)/);
  });

  it('键盘高亮看得见 —— 这些项是 div, 没有默认聚焦样式', () => {
    expect(CSS).toMatch(/\.atl-model__item\[data-kb-active="1"\]/);
    expect(CSS).toMatch(/outline:\s*2px solid/);
  });
});
