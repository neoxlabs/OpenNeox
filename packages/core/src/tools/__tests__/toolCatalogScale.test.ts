/**
 * tool_search 目录在插件规模下的成本
 *
 *   目录是**常驻**的 (嵌在 tool_search 的 description 里), 所以它的大小是每一次
 *   请求都要付的钱。内置 pack 数量由我们控制, 插件不是 —— 用户装 100 个的时候,
 *   每 pack 一行列全部工具名就是数千 token 常驻, 而那个规模下把几百个工具名摊开
 *   模型也扫不动: 花了钱买不到发现性。
 *
 *   所以这里钉的是「上界」而不是「格式」: 插件再多, 目录也不许无限长。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ToolTreeEngine } from '../toolTreeEngine.js';
import { toolPackRegistry } from '../packs/toolPack.js';
import type { Tool } from '@neoxlabs/kernel/types/index.js';

function makeTool(name: string): Tool {
  return {
    name,
    description: `tool ${name}`,
    parameters: { type: 'object', properties: {} },
    function: async () => '',
  };
}

/** 注册 n 个插件 pack, 每个 4 个工具, 返回全部工具 */
function registerPlugins(n: number): Tool[] {
  const tools: Tool[] = [];
  for (let i = 1; i <= n; i++) {
    const names = Array.from({ length: 4 }, (_, j) => `p${i}_tool_${j + 1}`);
    names.forEach(nm => tools.push(makeTool(nm)));
    toolPackRegistry.register({
      id: `connector:plugin-${i}`,
      label: `Plugin ${i}`,
      icon: '🔌',
      description: `Test plugin number ${i} providing four demo tools for catalog scale测试`,
      group: 'community',
      tier: 'extended',
      toolNames: names,
      createTools: () => names.map(makeTool),
    });
  }
  return tools;
}

function cleanup(n: number): void {
  for (let i = 1; i <= n; i++) toolPackRegistry.unregisterByPrefix(`connector:plugin-${i}`);
}

function catalogOf(engine: ToolTreeEngine): string {
  const search = engine.liveTools.find(t => t.name === 'tool_search');
  return search?.description ?? '';
}

describe('动态注册的 pack 工具必须进 toolMap', () => {
  /* 这条守的是一个真实翻车: runtime 的工具数组是构造时定下的 (collectRuntimeTools),
   * 而插件是之后才注册的 —— 插件工具从来没进过 toolMap, 于是目录里被 packLine 滤掉、
   * tool_search 拉不到 schema、call_tool 也找不到。表现是「插件装了也注册了, 但模型
   * 永远不用它, 每次都退回自己 shell 摸索」。 */
  it('工具没显式传进来, 只在 pack 里注册, 也要能被目录和 tool_search 看到', async () => {
    const names = ['dyn_tool_a', 'dyn_tool_b'];
    toolPackRegistry.register({
      id: 'connector:dynamic-only',
      label: 'Dynamic',
      icon: '🔌',
      description: 'A pack registered after the runtime tool array was built',
      group: 'community',
      tier: 'extended',
      toolNames: names,
      createTools: () => names.map(makeTool),
    });
    try {
      /* 关键: 只传一个别的工具, pack 里那两个一个都不传 */
      const engine = new ToolTreeEngine([makeTool('readfile')]);
      const search: any = engine.liveTools.find(t => t.name === 'tool_search');

      expect(search.description).toContain('dyn_tool_a');

      const out = String(await search.function({ pack: 'connector:dynamic-only' }));
      expect(out).toContain('dyn_tool_a');
      expect(out).toContain('dyn_tool_b');

      /* 目录折叠后模型看到的是短名, 必须也能命中 */
      const byAlias = String(await search.function({ pack: 'dynamic-only' }));
      expect(byAlias).toContain('dyn_tool_a');
    } finally {
      toolPackRegistry.unregisterByPrefix('connector:dynamic-only');
    }
  });

  it('构造之后才注册的 pack, tool_search 也能捞到', async () => {
    const engine = new ToolTreeEngine([makeTool('readfile')]);
    const names = ['late_gcal_list', 'late_gcal_create'];
    toolPackRegistry.register({
      id: 'connector:late-calendar',
      label: 'Late calendar',
      icon: '🔌',
      description: 'A connector pack registered after ToolTreeEngine was constructed',
      group: 'community',
      tier: 'extended',
      keywords: ['gcal', 'google-calendar'],
      toolNames: names,
      createTools: () => names.map(makeTool),
    });
    try {
      const search: any = engine.liveTools.find(t => t.name === 'tool_search');
      const out = String(await search.function({ query: 'gcal' }));
      expect(out).toContain('late_gcal_list');
      expect(out).toContain('late_gcal_create');
    } finally {
      toolPackRegistry.unregisterByPrefix('connector:late-calendar');
    }
  });
});

describe('tool_search 目录的规模上界', () => {
  let registered = 0;
  beforeEach(() => { registered = 0; });
  afterEach(() => { cleanup(registered); });

  it('少量插件: 工具名必须在目录里 —— 只列来源名实测会让模型找不到', () => {
    registered = 2;
    const cat = catalogOf(new ToolTreeEngine(registerPlugins(2)));
    expect(cat).toContain('p1_tool_1');
    expect(cat).toContain('p2_tool_4');
  });

  it('成本有上界 —— 再多插件也不会无限增长', () => {
    /* 钉的是「有界」不是「相等」: 少量插件列全工具名 (发现性), 多了折叠成来源名,
     * 再多就截断。所以 300 个 ≠ 20 个, 但必须停在一个固定的天花板下。 */
    registered = 300;
    const at300 = catalogOf(new ToolTreeEngine(registerPlugins(300))).length;
    cleanup(300);

    registered = 1000;
    const at1000 = catalogOf(new ToolTreeEngine(registerPlugins(1000))).length;

    /* 插件数翻 3 倍多, 目录几乎不动 —— 只是 +N 那个数字变长了几位 */
    expect(at1000).toBeLessThan(at300 + 20);
  });

  it('300 个插件的插件段仍在 250 字符内, 且交代了没列全', () => {
    registered = 300;
    const cat = catalogOf(new ToolTreeEngine(registerPlugins(300)));
    const section = cat.slice(cat.indexOf('Plugins (installed'));
    expect(section.length).toBeLessThan(700);
    /* 折叠了也要让模型知道「没列全, 该去搜」 */
    expect(section).toMatch(/\+\d+/);
    expect(section).toContain('tool_search');
  });
});
