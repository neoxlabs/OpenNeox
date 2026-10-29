/**
 * work:H-10 — tool_search 按任务类型整链解锁。
 *
 * 锁的不变量:
 *   1. 「做 PPT / 做表 / 写文档」三条链各一次 tool_search 拿齐 (不需要再搜第二三次)
 *   2. 模型按工具名精确搜索时同样整链解锁 (只给 deck_begin 一个工具是原来的病)
 *   3. 链上的工具名必须真的属于对应 pack —— 改名/下架时这条测试先红, 而不是静默少解锁
 *   4. 不相关查询不触发整链 (否则每次搜索都往常驻面塞十几个 schema)
 */
import { describe, it, expect } from 'vitest';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { ToolTreeEngine } from '../toolTreeEngine.js';
import { TASK_CHAINS } from '../toolTaskChains.js';
import { BUILTIN_PACKS } from '../packs/builtinPacks.js';
import { toolPackRegistry } from '../packs/toolPack.js';

/* 注册表是模块级单例; 内置包注册是幂等的 (同 workModeToolSurface.test.ts)。 */
for (const pack of BUILTIN_PACKS) toolPackRegistry.register(pack);

const CHAIN_TOOL_NAMES = TASK_CHAINS.flatMap(c => c.toolNames);

const mk = (name: string): Tool => ({
  name,
  description: `mock ${name}`,
  parameters: { type: 'object', properties: {} },
  isReadOnly: true,
  async function() { return `ran:${name}`; },
});

const ALWAYS = new Set(['search', 'readfile']);

/**
 * 所有链工具都归进同一个 category —— 不归类的话 buildLiveTools 的
 * "未分类安全网" 会把它们直接注册成常驻, 测不到解锁。
 */
function build(): ToolTreeEngine {
  return new ToolTreeEngine(
    [mk('search'), mk('readfile'), ...CHAIN_TOOL_NAMES.map(mk), mk('git_branch')],
    {
      alwaysActive: ALWAYS,
      categories: [
        { id: 'office', label: 'Office', description: 'office chain tools', toolNames: CHAIN_TOOL_NAMES },
      ],
    },
  );
}

const searchTool = (e: ToolTreeEngine) => e.liveTools.find(t => t.name === 'tool_search')!;
const liveNames = (e: ToolTreeEngine) => e.liveTools.map(t => t.name);

async function search(query: string) {
  const e = build();
  const out = String(await searchTool(e).function({ query } as any, {} as any));
  return { e, out, live: liveNames(e) };
}

describe('tool_search 任务链 — 三条链各一次拿齐', () => {
  it('「做个 PPT」一次解锁 deck 全链 + 配图', async () => {
    const { out, live } = await search('做个PPT');
    for (const n of ['deck_begin', 'deck_add_slide', 'deck_export', 'pptx_read', 'generate_image', 'edit_image']) {
      expect(live).toContain(n);
    }
    expect(out).toContain('任务链 (PPT 演示文稿)');
    expect(out).toContain('deck_begin');
    /* 不越界: 别的链不能跟着进来 */
    expect(live).not.toContain('sheet_describe');
    expect(live).not.toContain('word_replace_text');
  });

  it('「Excel 透视表」一次解锁表格链', async () => {
    const { out, live } = await search('Excel 透视表');
    for (const n of ['sheet_describe', 'sheet_get_range', 'sheet_set_cells', 'sheet_export_file']) {
      expect(live).toContain(n);
    }
    expect(out).toContain('任务链 (Excel 表格)');
    expect(live).not.toContain('deck_begin');
  });

  it('「写一份文档」一次解锁 Word 链', async () => {
    const { out, live } = await search('写一份文档');
    for (const n of ['word_describe', 'word_get_paragraphs', 'word_replace_text', 'word_to_pdf']) {
      expect(live).toContain(n);
    }
    expect(out).toContain('任务链 (Word 文档)');
    expect(live).not.toContain('sheet_describe');
  });

  it('按工具名精确搜索也整链解锁 (原来只会给这一个工具)', async () => {
    const { live } = await search('select:deck_begin');
    expect(live).toContain('deck_begin');
    expect(live).toContain('deck_add_slide');
    expect(live).toContain('deck_export');
  });

  it('不相关查询不触发整链', async () => {
    const { live } = await search('git branch');
    expect(live).toContain('git_branch');
    expect(live).not.toContain('deck_begin');
    expect(live).not.toContain('sheet_describe');
    expect(live).not.toContain('word_replace_text');
  });

  it('英文词按词边界匹配 —— keyword 不该解锁 Word 链', async () => {
    const { live } = await search('keyword');
    expect(live).not.toContain('word_replace_text');
  });

  it('tool_search 描述里告诉模型可以按任务词整链解锁', () => {
    const e = build();
    expect(searchTool(e).description).toContain('unlock the whole chain');
  });

  it('链上的工具名必须属于声明的 pack (改名/下架时在这里红)', () => {
    for (const chain of TASK_CHAINS) {
      /* 没有 PPT 引擎的构建 (开源版) 不注册 pptx 包 —— 那条链本来就不会出现, 不在这里查 */
      if (chain.packIds.includes('pptx') && !toolPackRegistry.get('pptx')) continue;
      const declared = new Set<string>();
      for (const packId of chain.packIds) {
        const pack = toolPackRegistry.get(packId);
        expect(pack, `pack ${packId} 未注册`).toBeDefined();
        for (const n of pack!.unlockToolNames ?? pack!.toolNames) declared.add(n);
      }
      for (const name of chain.toolNames) {
        expect(declared, `${chain.id} 链上的 ${name} 不属于 ${chain.packIds.join('/')}`).toContain(name);
      }
    }
  });
});
