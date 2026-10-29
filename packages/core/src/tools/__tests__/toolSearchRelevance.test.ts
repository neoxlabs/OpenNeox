/*
 * tool_search 相关性 —— 零命中不许有结果, 常见中英文查询仍要召回对应 pack
 *
 * 曾经的 bug: tier 加权是无条件 `score += 1`, 于是一个词都不命中的查询也会把
 * primary pack 里的工具全部算成 1 分捞出来 (上限 15 条)。模型收到一堆无关工具,
 * 既费 token 又容易挑错。
 *
 * 修 tier 加权时容易顺手把召回一起弄丢, 所以这里同时钉住两件事:
 *   1. 零命中 → 不返回任何工具
 *   2. git / 浏览器 / 表格 / 图片 / 日历 仍能命中对应工具
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { ToolTreeEngine } from '../toolTreeEngine.js';
import { toolPackRegistry } from '../packs/toolPack.js';
import { BUILTIN_PACKS } from '../packs/builtinPacks.js';
import type { Tool } from '@neoxlabs/kernel/types/index.js';

beforeAll(() => {
  toolPackRegistry.registerAll(BUILTIN_PACKS);
});

function makeTool(name: string): Tool {
  return {
    name,
    description: `tool ${name}`,
    parameters: { type: 'object', properties: {} },
    function: async () => '',
  } as unknown as Tool;
}

/** 每个 case 用全新 engine: 搜索会把命中的工具解锁, 复用会污染后续断言 */
async function search(query: string): Promise<{ out: string; unlocked: string[]; before: number }> {
  const engine = new ToolTreeEngine(
    ['readfile', 'git_branch', 'browser_run', 'sheet_describe', 'generate_image', 'calendar_events'].map(makeTool),
    { alwaysActive: new Set(['readfile']) }
  );
  const before = engine.liveTools.length;
  const tool = engine.liveTools.find(t => t.name === 'tool_search');
  if (!tool) throw new Error('tool_search 不在 liveTools 里');
  const out = String(await tool.function({ query } as any));
  const unlocked = engine.liveTools.slice(before).map(t => t.name);
  return { out, unlocked, before };
}

describe('tool_search 相关性', () => {
  it('一个词都不命中时不返回任何工具', async () => {
    const { out, unlocked } = await search('zzzz_no_such_tool_anywhere');
    expect(out).toContain('No tools matched');
    // 提示里会列可用 pack, 但不能因此解锁任何工具
    expect(unlocked).toEqual([]);
  });

  it.each([
    ['git', 'git_branch'],
    ['浏览器', 'browser_run'],
    ['表格', 'sheet_describe'],
    ['图片', 'generate_image'],
    ['日历', 'calendar_events'],
  ])('查询「%s」能召回 %s', async (query, expected) => {
    const { out } = await search(query);
    expect(out).toContain(expected);
  });
});
