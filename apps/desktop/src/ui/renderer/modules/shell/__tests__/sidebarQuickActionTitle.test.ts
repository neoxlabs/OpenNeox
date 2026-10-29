import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC_PATH = join(__dirname, '..', 'Sidebar.tsx');
const SRC = readFileSync(SRC_PATH, 'utf8');

describe('侧栏快捷入口', () => {
  it('测试指着的确实是 Sidebar.tsx (路径自检)', () => {
    expect(SRC).toContain('neox-sidebar__newchat');
    expect(SRC).toContain('<SidebarToolDock');
  });

  it('每个 quick-action 按钮都带 title', () => {
    /* 逐个 <button ...> 开标签地扫: className 里含 quick-action 且不含 -icon/-label 的,
     * 就是入口按钮本体。 */
    const missing: string[] = [];
    /* 不能用 /<button[\s\S]*?>/ —— onClick={() => ...} 里的 `=>` 会把开标签提前截断,
     * 第一版就是这么把 8 个全报成缺失的。按花括号深度找真正收尾的那个 `>`。 */
    const tagAt = (from: number): string | null => {
      let depth = 0;
      for (let i = from; i < SRC.length; i++) {
        const ch = SRC[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        else if (ch === '>' && depth === 0) return SRC.slice(from, i);
      }
      return null;
    };
    for (const m of SRC.matchAll(/<button\b/g)) {
      const attrs = tagAt((m.index ?? 0) + 7);
      if (attrs == null) continue;
      if (!/neox-sidebar__(quick-action|newchat|tool)\b/.test(attrs)) continue;
      if (/(quick-action|newchat|tool)-(icon|label|kbd|plus)/.test(attrs)) continue;
      if (/\btitle=/.test(attrs)) continue;
      const near = SRC.slice(m.index ?? 0, (m.index ?? 0) + 600);
      const label = near.match(/quick-action-label">\{?[^<]*?'([^']+)'/)?.[1] ?? '(未知)';
      missing.push(label);
    }
    expect(missing, `这些快捷入口没写 title, 侧栏收起时会变成无说明的图标: ${missing.join(' / ')}`).toEqual([]);
  });

  it('工具方块表里每一项都写了 title', () => {
    /* 工具架是一张表交给 SidebarToolDock 渲染, 按钮上是 title={t.title} —— 漏写要在表里查 */
    const start = SRC.indexOf('<SidebarToolDock');
    const table = SRC.slice(start, SRC.indexOf('zh={isZh}', start));
    const ids = [...table.matchAll(/\bid: '([a-z]+)'/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThanOrEqual(6);
    for (const id of ids) {
      const at = table.indexOf(`id: '${id}'`);
      const entry = table.slice(at, table.indexOf('onClick', at));
      expect(entry, `工具「${id}」没写 title`).toMatch(/title:/);
    }
  });
});
