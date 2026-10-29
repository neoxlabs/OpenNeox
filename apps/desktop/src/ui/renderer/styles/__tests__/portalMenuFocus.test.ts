import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const R = join(__dirname, '..', '..');
const strip = (s: string) => s
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, m => '\n'.repeat((m.match(/\n/g) ?? []).length))
  .replace(/\/\*[\s\S]*?\*\//g, m => '\n'.repeat((m.match(/\n/g) ?? []).length))
  .replace(/^\s*\/\/.*$/gm, '');

const FILES: Array<[string, string]> = [
  ['模式选择器', 'modules/shell/NeoxModePicker.tsx'],
  ['模型选择器', 'modules/agent-timeline/TimelineComposer.tsx'],
  ['主题菜单', 'modules/shell/TopBar.tsx'],
];

describe('portal 菜单的焦点管理', () => {
  it('测试指着的三个文件都存在且非空 (路径自检)', () => {
    for (const [, f] of FILES) expect(readFileSync(join(R, f), 'utf8').length).toBeGreaterThan(1000);
  });

  for (const [name, f] of FILES) {
    it(`${name}: 打开时把焦点送到已选中项`, () => {
      const s = strip(readFileSync(join(R, f), 'utf8'));
      expect(s, '要按 aria-checked/aria-selected 找已选中项').toMatch(/aria-(checked|selected)'\)\s*===\s*'true'/);
      expect(s, '要真的调 focus()').toMatch(/\.focus\(\)/);
    });

    it(`${name}: 关闭时把焦点还给触发按钮`, () => {
      const s = strip(readFileSync(join(R, f), 'utf8'));
      expect(s,
        'cleanup 里判 menuRef.contains(activeElement) 是无效的 —— portal 已卸载, 焦点早在 body 上。'
        + '判据要是 activeElement === document.body').toMatch(/document\.activeElement === document\.body/);
      expect(s, '还焦目标是触发按钮').toMatch(/btnRef\.current\?\.focus\(\)/);
    });
  }
});
