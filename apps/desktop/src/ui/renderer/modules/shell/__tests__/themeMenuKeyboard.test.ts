import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(__dirname, '..', 'TopBar.tsx'), 'utf8');
/* 注释换成等量换行 —— 源码注释里正当地引用了这些名字 */
const CODE = SRC
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, m => '\n'.repeat((m.match(/\n/g) ?? []).length))
  .replace(/\/\*[\s\S]*?\*\//g, m => '\n'.repeat((m.match(/\n/g) ?? []).length))
  .replace(/^\s*\/\/.*$/gm, '');

const CSS = readFileSync(
  join(__dirname, '..', '..', '..', 'styles', 'components', 'context-menu.css'), 'utf8');

describe('主题菜单的键盘可操作性', () => {
  it('测试指着的确实是 TopBar 的手写菜单 (路径自检)', () => {
    expect(CODE).toContain('neox-theme-menu');
    expect(CODE).toContain('menuitemradio');
  });

  it('菜单项可聚焦, 且 Enter/Space 能触发', () => {
    expect(CODE, '项要 tabIndex={-1} 才能被程序聚焦(roving tabindex)').toMatch(/tabIndex=\{-1\}/);
    expect(CODE, '项要自己处理 Enter / Space').toMatch(/e\.key === 'Enter' \|\| e\.key === ' '/);
  });

  it('容器处理上下键和 Home/End', () => {
    for (const k of ['ArrowDown', 'ArrowUp', 'Home', 'End']) {
      expect(CODE, `菜单要处理 ${k}`).toContain(`'${k}'`);
    }
    expect(CODE, '要按 role 找项来移动焦点').toMatch(/\[role\^="menuitem"\]/);
  });

  it('打开时把焦点送进菜单, 优先落在已选中项', () => {
    expect(CODE).toMatch(/aria-checked'\) === 'true'/);
    expect(CODE).toMatch(/\.focus\(\)/);
  });

  it('键盘焦点看得见 —— 这些项是 div, 没有默认聚焦样式', () => {
    expect(CSS).toMatch(/\.neox-context-menu-item:focus-visible/);
    expect(CSS).toMatch(/outline:\s*2px solid/);
  });
});
