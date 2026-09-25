import { describe, expect, it } from 'vitest';
import { ALWAYS_ACTIVE_TOOLS } from '../toolTree.js';
import { BUILTIN_PACKS } from '../packs/builtinPacks.js';

describe('tool catalog uses unified edit', () => {
  it('always-active tools include edit and exclude legacy edit names', () => {
    expect(ALWAYS_ACTIVE_TOOLS.has('edit')).toBe(true);
    expect(ALWAYS_ACTIVE_TOOLS.has('search')).toBe(true);
    expect(ALWAYS_ACTIVE_TOOLS.has('search_files')).toBe(true);
    expect(ALWAYS_ACTIVE_TOOLS.has('edit_file')).toBe(false);
    expect(ALWAYS_ACTIVE_TOOLS.has('apply_patch')).toBe(false);
  });

  /* V2 基准: 调研题第一步必然是搜/抓, 这两个不常驻就要先 tool_search, 白烧 2 轮往返 */
  it('联网工具常驻 —— 调研类任务不该先花一轮找工具', () => {
    expect(ALWAYS_ACTIVE_TOOLS.has('web_search')).toBe(true);
    expect(ALWAYS_ACTIVE_TOOLS.has('web_fetch')).toBe(true);
  });

  it('file_ops pack exposes edit and excludes legacy edit names', () => {
    const fileOpsPack = BUILTIN_PACKS.find(pack => pack.id === 'file_ops');
    expect(fileOpsPack).toBeDefined();
    expect(fileOpsPack?.toolNames).toContain('edit');
    expect(fileOpsPack?.toolNames).not.toContain('edit_file');
    expect(fileOpsPack?.toolNames).not.toContain('apply_patch');
  });
});
