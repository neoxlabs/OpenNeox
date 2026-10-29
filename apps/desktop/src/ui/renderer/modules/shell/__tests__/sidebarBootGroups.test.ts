import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(__dirname, '..', 'Sidebar.tsx'), 'utf8');
const CODE = SRC
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, m => '\n'.repeat((m.match(/\n/g) ?? []).length))
  .replace(/\/\*[\s\S]*?\*\//g, m => '\n'.repeat((m.match(/\n/g) ?? []).length))
  .replace(/^\s*\/\/.*$/gm, '');

describe('侧栏首屏的分组列表', () => {
  it('测试指着的确实是 Sidebar (路径自检)', () => {
    expect(CODE).toContain('visibleGroups');
    expect(CODE).toContain('sessionsLoading');
  });

  it('visibleGroups 会看 sessionsLoading', () => {
    const at = CODE.indexOf('const visibleGroups');
    expect(at, '找不到 visibleGroups, 闸失效了').toBeGreaterThan(0);
    const chunk = CODE.slice(at, at + 1600);
    /* memo 体和依赖数组必须**分开**验 —— 第一版只在整段里找 sessionsLoading, 于是我把
     * 守卫整条换成 `if (false)` 做变异验证时, 闸凭依赖数组里那个名字照样绿。 */
    const cut = chunk.indexOf('}, [');
    expect(cut, '找不到 memo 的依赖数组, 闸失效了').toBeGreaterThan(0);
    const body = chunk.slice(0, cut);
    const deps = chunk.slice(cut, chunk.indexOf(']', cut) + 1);
    expect(body,
      '会话没到之前 groups 是拿 recentWorkspaces 算的空项目头, 直接铺出来会在数据到齐时整列重排')
      .toMatch(/sessionsLoading\s*&&/);
    expect(deps, 'memo 的依赖里也要有它, 否则加载结束不会重算').toMatch(/sessionsLoading/);
  });

  it('骨架那条路还在 —— 只留一组的前提是那一组会铺骨架', () => {
    expect(CODE).toMatch(/loading=\{!!sessionsLoading && g\.isActive\}/);
    const BLOCK = readFileSync(join(__dirname, '..', 'SidebarGroupBlock.tsx'), 'utf8');
    expect(BLOCK).toMatch(/loading \?/);
    expect(BLOCK).toMatch(/neox-sidebar__skeleton-row/);
  });
});
