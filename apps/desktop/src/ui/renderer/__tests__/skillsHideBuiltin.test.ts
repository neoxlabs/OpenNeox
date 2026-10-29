import { describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const PAGE = strip(fs.readFileSync(path.join(ROOT, 'pages/settings/SettingsPage.tsx'), 'utf8'));
const TAB = strip(fs.readFileSync(path.join(ROOT, 'pages/settings/tabs/SkillsTab.tsx'), 'utf8'));

describe('技能列表不显示内置', () => {
  test('数据源无条件滤掉 builtin —— 不依赖筛选值', () => {
    /* 判据是"这一条在任何筛选分支**之前**"; 写成 if (filter===x && source==='builtin')
     * 那种带条件的过滤就等于又回到"默认不显示"。 */
    const i = PAGE.indexOf("if (skill.source === 'builtin') return false;");
    expect(i, '数据源里找不到无条件过滤 builtin 的那一行').toBeGreaterThan(0);
    const j = PAGE.indexOf('skillFilterSource !==', i);
    expect(j, '无条件过滤必须排在按筛选值过滤之前').toBeGreaterThan(i);
  });

  test('筛选器里没有"含内置"的档', () => {
    expect(TAB).not.toMatch(/含内置|incl\. built-in/);
  });

  test('不再渲染内置分组', () => {
    expect(TAB).not.toMatch(/renderGroup\('builtin'/);
  });
});
