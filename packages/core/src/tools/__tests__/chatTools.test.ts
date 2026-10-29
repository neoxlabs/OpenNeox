/**
 * 聊天档工具面 (chatTools.ts) —— 只有搜索 + 画图。
 *
 * 锁五件 (总控裁决第六节):
 *   1. 搜索一轮最多 10 次, 到顶在工具层拦住 (第 11 次不打网关);
 *   2. 画图**不限张数** —— 一轮里多张不同的图都要能出;
 *   3. 同工具同参数重复调用直接拦 (防跑飞靠行为判据, 不靠小额度);
 *   4. 两个工具标了 parallelSafety: 'safe', kernel 批次调度会并发跑 (5 搜 / 3 图总耗时 ≈ 单次);
 *   5. 非聊天模式拿到的还是原数组 —— Work / Code 一个字节都没变。
 */
import { describe, expect, it, vi } from 'vitest';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import type { ToolCall } from '@neoxlabs/kernel/types/index.js';
import { runOrchestratedBatch } from '@neoxlabs/kernel/core/toolOrchestration/batch.js';
import {
  CHAT_SEARCH_LIMIT,
  buildChatModeTools,
  capWebSearchTool,
  chatToolsAvailability,
  guardRepeatedCalls,
  markChatToolParallel,
  selectToolsForTurn,
} from '../chatTools.js';

function fakeTool(name: string, impl: (args: any) => any = () => `${name}-ok`): Tool {
  return {
    name,
    description: `${name} description`,
    parameters: { type: 'object', properties: { query: { type: 'string' } } },
    function: impl,
  };
}

const pool = () => [
  fakeTool('readfile'),
  fakeTool('execute_shell'),
  fakeTool('browser_navigate'),
  fakeTool('web_search'),
  fakeTool('generate_image'),
  fakeTool('office_edit'),
];

describe('capWebSearchTool —— 一轮最多 10 次', () => {
  it(`第 ${CHAT_SEARCH_LIMIT + 1} 次不再调内层, 直接回一句「到上限了」`, async () => {
    const inner = vi.fn(async () => 'search-ok');
    const tool = capWebSearchTool(fakeTool('web_search', inner as any));

    for (let i = 0; i < CHAT_SEARCH_LIMIT; i++) {
      expect(await tool.function({ query: `q${i}` })).toBe('search-ok');
    }
    expect(inner).toHaveBeenCalledTimes(CHAT_SEARCH_LIMIT);

    const blocked = String(await tool.function({ query: 'one-too-many' }));
    expect(inner).toHaveBeenCalledTimes(CHAT_SEARCH_LIMIT);   /* 第 11 次根本没打网关 */
    expect(blocked).toContain('到上限了');
    expect(blocked).toContain('用已经拿到的结果直接回答');
  });

  it('上限是 10: 够「查天气 + 查限行 + 查票价 + 查路线…」这种一次问好几件事的', () => {
    expect(CHAT_SEARCH_LIMIT).toBe(10);
  });

  it('cap 不改变工具名 / 说明 / 参数 —— 工具表逐字节不变, 前缀缓存不断', () => {
    const raw = fakeTool('web_search');
    const capped = capWebSearchTool(raw);
    expect(capped.name).toBe(raw.name);
    expect(capped.description).toBe(raw.description);
    expect(capped.parameters).toBe(raw.parameters);
  });

  it('计数按实例算: 下一轮重新构建 = 重新给 10 次', async () => {
    const raw = fakeTool('web_search');
    const turn1 = capWebSearchTool(raw);
    for (let i = 0; i < CHAT_SEARCH_LIMIT; i++) await turn1.function({ query: String(i) });
    expect(String(await turn1.function({ query: 'x' }))).toContain('到上限了');

    const turn2 = capWebSearchTool(raw);
    expect(String(await turn2.function({ query: 'y' }))).not.toContain('到上限了');
  });
});

describe('画图不限张数', () => {
  it('同一轮连画 3 张不同的图, 每次都真的出图 (没有「到上限了」)', async () => {
    const inner = vi.fn(async () => 'image-ok');
    const tools = buildChatModeTools([fakeTool('generate_image', inner as any)]);
    const image = tools.find((t) => t.name === 'generate_image')!;

    for (const prompt of ['一只猫', '一只狗', '一只鸟']) {
      expect(await image.function({ prompt })).toBe('image-ok');
    }
    expect(inner).toHaveBeenCalledTimes(3);
  });
});

describe('guardRepeatedCalls —— 同工具同参数重复调用直接拦', () => {
  it('第二次同样的参数不再执行, 回一句「结果就在上面」', async () => {
    const inner = vi.fn(async () => 'search-ok');
    const tool = guardRepeatedCalls(fakeTool('web_search', inner as any));

    expect(await tool.function({ query: 'a', count: 8 })).toBe('search-ok');
    const again = String(await tool.function({ query: 'a', count: 8 }));
    expect(inner).toHaveBeenCalledTimes(1);
    expect(again).toContain('同样的参数');
    expect(again).toContain('不要重复调用');
  });

  it('参数顺序不同也算同一次 (键排序后再比)', async () => {
    const inner = vi.fn(async () => 'ok');
    const tool = guardRepeatedCalls(fakeTool('web_search', inner as any));
    await tool.function({ query: 'a', count: 8 });
    await tool.function({ count: 8, query: 'a' });
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('换了参数照常执行 (要不同结果就换参数)', async () => {
    const inner = vi.fn(async () => 'ok');
    const tool = guardRepeatedCalls(fakeTool('generate_image', inner as any));
    await tool.function({ prompt: '一只猫' });
    await tool.function({ prompt: '一只狗' });
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it('上一次抛异常时, 同样的参数重试是正当的 (不记失败的调用)', async () => {
    const inner = vi.fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce('ok');
    const tool = guardRepeatedCalls(fakeTool('web_search', inner as any));

    await expect(tool.function({ query: 'a' })).rejects.toThrow('network');
    expect(await tool.function({ query: 'a' })).toBe('ok');
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it('不改变工具名 / 说明 / 参数', () => {
    const raw = fakeTool('web_search');
    const guarded = guardRepeatedCalls(raw);
    expect(guarded.name).toBe(raw.name);
    expect(guarded.description).toBe(raw.description);
    expect(guarded.parameters).toBe(raw.parameters);
  });
});

describe('buildChatModeTools', () => {
  it('只给联网搜索 + 画图, 顺序固定 (每轮工具表一致)', () => {
    const names = buildChatModeTools(pool()).map((t) => t.name);
    expect(names).toEqual(['web_search', 'generate_image']);
  });

  it('池子里没有的就不给, 不现编 (未登录没托管搜索 / 极简版裁掉画图)', () => {
    expect(buildChatModeTools([fakeTool('readfile'), fakeTool('generate_image')]).map((t) => t.name))
      .toEqual(['generate_image']);
    expect(buildChatModeTools([fakeTool('readfile')])).toEqual([]);
  });

  it('两件都标了 parallelSafety: safe —— kernel 批次调度会并发跑', () => {
    for (const tool of buildChatModeTools(pool())) {
      expect(tool.parallelSafety, tool.name).toBe('safe');
    }
  });

  it('拿到的搜索是 cap 过的 (第 11 次被拦)', async () => {
    const tools = buildChatModeTools(pool());
    const search = tools.find((t) => t.name === 'web_search')!;
    for (let i = 0; i < CHAT_SEARCH_LIMIT; i++) await search.function({ query: String(i) });
    expect(String(await search.function({ query: 'x' }))).toContain('到上限了');
  });

  it('「先搜再画多张」同一轮里都真的执行完', async () => {
    const searchInner = vi.fn(async () => 'search-ok');
    const imageInner = vi.fn(async () => 'image-ok');
    const tools = buildChatModeTools([
      fakeTool('web_search', searchInner as any),
      fakeTool('generate_image', imageInner as any),
    ]);
    const search = tools.find((t) => t.name === 'web_search')!;
    const image = tools.find((t) => t.name === 'generate_image')!;

    for (let i = 0; i < 3; i++) {
      expect(await search.function({ query: `q${i}` })).toBe('search-ok');
    }
    for (const prompt of ['猫', '狗', '鸟']) {
      expect(await image.function({ prompt })).toBe('image-ok');
    }

    expect(searchInner).toHaveBeenCalledTimes(3);
    expect(imageInner).toHaveBeenCalledTimes(3);
  });
});

describe('markChatToolParallel', () => {
  it('只加并发标记, 不碰名字 / 说明 / 参数', () => {
    const raw = fakeTool('generate_image');
    const marked = markChatToolParallel(raw);
    expect(marked.parallelSafety).toBe('safe');
    expect(marked.name).toBe(raw.name);
    expect(marked.description).toBe(raw.description);
    expect(marked.parameters).toBe(raw.parameters);
  });
});

describe('selectToolsForTurn —— 聊天档以外一律原样', () => {
  it('chatMode=false 返回同一个数组 (Work / Code 工具集不变)', () => {
    const tools = pool();
    const out = selectToolsForTurn(tools, false);
    expect(out).toBe(tools);                            /* 同一个引用: 不重排、不包装 */
    expect(out.map((t) => t.name)).toEqual(tools.map((t) => t.name));
  });

  it('chatMode=true 换成搜索 + 画图', () => {
    expect(selectToolsForTurn(pool(), true).map((t) => t.name)).toEqual(['web_search', 'generate_image']);
  });
});

describe('chatToolsAvailability —— 提示词按「真带上」的描述能力', () => {
  it('正常池子: 聊天档两件都在, 工具表非空', () => {
    const tools = selectToolsForTurn(pool(), true);
    expect(tools.length).toBeGreaterThan(0);
    expect(chatToolsAvailability(tools)).toEqual({ search: true, image: true });
  });

  it('池子里缺哪件就报哪件没有 (没登录没托管搜索 / 裁掉画图)', () => {
    const onlyImage = selectToolsForTurn([fakeTool('generate_image')], true);
    expect(chatToolsAvailability(onlyImage)).toEqual({ search: false, image: true });

    const onlySearch = selectToolsForTurn([fakeTool('web_search')], true);
    expect(chatToolsAvailability(onlySearch)).toEqual({ search: true, image: false });
  });

  it('工具表真是空的时候两件都报 false (提示词不许再声称有)', () => {
    expect(chatToolsAvailability(selectToolsForTurn([], true))).toEqual({ search: false, image: false });
  });
});

/* ── 并发: 5 个搜索 + 3 张图总耗时 ≈ 单次 (不是串行相加) ─────────────────── */

const RUN_MS = 120;

function slowChatTool(name: string): Tool {
  return fakeTool(name, async () => {
    await new Promise((r) => setTimeout(r, RUN_MS));
    return `${name}-ok`;
  });
}

function call(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } } as ToolCall;
}

function batchCtx(tools: Tool[]) {
  return {
    tools,
    resolveAlias: () => null,
    signal: new AbortController().signal,
    iteration: 1,
    workspacePath: '/tmp',
    preHooks: [],
    postSuccessHooks: [],
    postFailureHooks: [],
    invokeTool: async (tool: Tool, args: any, signal: AbortSignal, toolCallId: string) => {
      const result = await tool.function(args, { signal, toolCallId });
      const output = typeof result === 'string' ? result : await result;
      return { output, success: true };
    },
  } as any;
}

describe('聊天档工具并发执行 (总控裁决第六节: 速度靠并发)', () => {
  it('一轮 5 个搜索 + 3 张图并发跑, 总耗时 ≈ 单次', async () => {
    const tools = buildChatModeTools([slowChatTool('web_search'), slowChatTool('generate_image')]);
    const calls = [
      ...[0, 1, 2, 3, 4].map((i) => call(`s${i}`, 'web_search', { query: `q${i}` })),
      ...[0, 1, 2].map((i) => call(`i${i}`, 'generate_image', { prompt: `p${i}` })),
    ];

    const started = Date.now();
    const result = await runOrchestratedBatch(calls, { ctx: batchCtx(tools), maxConcurrency: 8 });
    const elapsed = Date.now() - started;

    expect(result.outcomes).toHaveLength(8);
    expect(result.outcomes.every((o) => o.success)).toBe(true);
    /* 串行会是 8 × 120ms = 960ms; 并发只要 ~120ms */
    expect(elapsed).toBeLessThan(RUN_MS * 3);
  });

  it('同工具同参数重复调用在并发批次里也只执行一次', async () => {
    const inner = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, RUN_MS));
      return 'image-ok';
    });
    const tools = buildChatModeTools([fakeTool('generate_image', inner as any)]);
    const calls = [
      call('a', 'generate_image', { prompt: '同一只猫' }),
      call('b', 'generate_image', { prompt: '同一只猫' }),
    ];

    const result = await runOrchestratedBatch(calls, { ctx: batchCtx(tools), maxConcurrency: 4 });

    expect(inner).toHaveBeenCalledTimes(1);
    expect(result.outcomes).toHaveLength(2);
    /* 被拦的那一条把「不要重复调用」交回给模型 */
    const outputs = result.outcomes.map((o) => String(o.output ?? '')).join('\n');
    expect(outputs).toContain('不要重复调用');
  });
});
