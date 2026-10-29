import { describe, it, expect, vi } from 'vitest';
import { ToolTreeEngine } from '../toolTreeEngine.js';
import type { Tool } from '@neoxlabs/kernel/types/index.js';

const mk = (name: string, description = `mock ${name}`): Tool => ({
  name,
  description,
  parameters: { type: 'object', properties: {} },
  isReadOnly: true,
  async function() { return `ran:${name}`; },
});

const ALWAYS = new Set(['search', 'readfile']);
const DEFERRED = ['git_branch', 'git_commit', 'git_diff', 'debug_attach', 'debug_break'];

function build(extra: Tool[] = []) {
  const tools = [mk('search'), mk('readfile'), ...DEFERRED.map(n => mk(n)), ...extra];
  return new ToolTreeEngine(tools, {
    alwaysActive: ALWAYS,
    categories: [
      { id: 'git', label: 'Git', description: 'git operations', toolNames: ['git_branch', 'git_commit', 'git_diff'], keywords: ['commit'] },
      { id: 'debug', label: 'Debugger', description: 'debug tools', toolNames: ['debug_attach', 'debug_break'] },
    ],
  });
}

const searchTool = (e: ToolTreeEngine) => e.liveTools.find(t => t.name === 'tool_search')!;
const callTool = (e: ToolTreeEngine) => e.liveTools.find(t => t.name === 'call_tool')!;

describe('tool_search — 三种查询模式', () => {
  it('select: 精确取工具并解锁', async () => {
    const e = build();
    const out = String(await searchTool(e).function({ query: 'select:git_branch,git_commit' } as any, {} as any));
    expect(out).toContain('Found 2 tool(s)');
    expect(out).toContain('git_branch');
    expect(e.liveTools.map(t => t.name)).toEqual(expect.arrayContaining(['git_branch', 'git_commit']));
  });

  it('tools 数组等价于 select:，未知名字进 Not found', async () => {
    const e = build();
    const out = String(await searchTool(e).function({ tools: ['git_diff', 'no_such_tool'] } as any, {} as any));
    expect(out).toContain('Found 1 tool(s)');
    expect(out).toContain('Not found: no_such_tool');
  });

  it('关键词按工具名命中并解锁', async () => {
    const e = build();
    const out = String(await searchTool(e).function({ query: 'git_branch' } as any, {} as any));
    expect(out).toContain('git_branch');
    expect(e.liveTools.map(t => t.name)).toContain('git_branch');
  });

  it('关键词按 pack 标签 / keywords 命中', async () => {
    const e = build();
    const out = String(await searchTool(e).function({ query: 'commit' } as any, {} as any));
    expect(out).toContain('Found');
    expect(e.liveTools.map(t => t.name)).toContain('git_commit');
  });

  it('pack 模式一次加载整包', async () => {
    const e = build();
    const out = String(await searchTool(e).function({ pack: 'git' } as any, {} as any));
    expect(out).toContain('Found 3 tool(s)');
    for (const n of ['git_branch', 'git_commit', 'git_diff']) expect(e.liveTools.map(t => t.name)).toContain(n);
  });

  it('不存在的 pack → 列可用 pack', async () => {
    const e = build();
    const out = String(await searchTool(e).function({ pack: 'nope' } as any, {} as any));
    expect(out).toContain('Pack "nope" not found');
    expect(out).toContain('Available packs');
  });

  it('什么都没有 → No tools matched + 目录', async () => {
    const e = build();
    const out = String(await searchTool(e).function({} as any, {} as any));
    expect(out).toContain('No tools matched');
    expect(out).toContain('Available packs');
  });

  it('完全无命中 → No tools matched "query"', async () => {
    const e = new ToolTreeEngine([mk('search'), mk('readfile')], { alwaysActive: ALWAYS });
    const out = String(await searchTool(e).function({ query: 'zzzz-nothing' } as any, {} as any));
    expect(out).toContain('No tools matched "zzzz-nothing"');
  });

  it('常驻工具不参与模糊搜索', async () => {
    const e = new ToolTreeEngine([mk('search'), mk('readfile')], { alwaysActive: ALWAYS });
    const out = String(await searchTool(e).function({ query: 'search' } as any, {} as any));
    expect(out).toContain('No tools matched');
  });

  it('select 与 pack 同时给时合并结果且不重复', async () => {
    const e = build();
    const out = String(await searchTool(e).function({ query: 'select:git_branch', pack: 'git' } as any, {} as any));
    expect(out).toContain('Found 3 tool(s)');
  });

  it('freeze 之后搜索结果提示走 call_tool', async () => {
    const e = build();
    e.freeze();
    const out = String(await searchTool(e).function({ tools: ['git_branch'] } as any, {} as any));
    expect(out).toContain('call_tool');
    expect(e.liveTools.map(t => t.name)).not.toContain('git_branch');
  });
});

describe('call_tool — 派发与错误提示', () => {
  it('已知工具正常执行并透传参数', async () => {
    let seen: any;
    const target = mk('echo_tool');
    target.function = async (args: any) => { seen = args; return 'ok';
    };
    const e = new ToolTreeEngine([mk('search'), mk('readfile'), target], { alwaysActive: ALWAYS });
    const out = await callTool(e).function({ name: 'echo_tool', args: { x: 1 } } as any, {} as any);
    expect(out).toBe('ok');
    expect(seen).toEqual({ x: 1 });
  });

  it('未知工具名 → 提示不存在的工具，并给候选', async () => {
    const e = build();
    const out = String(await callTool(e).function({ name: 'git_bracnh', args: {} } as any, {} as any));
    expect(out.toLowerCase()).toContain('not registered');
    expect(out).toContain('git_branch');
  });

  it('完全不相关工具名 → 仍然返回可读错误', async () => {
    const e = build();
    const out = String(await callTool(e).function({ name: 'qqqq', args: {} } as any, {} as any));
    expect(out.length).toBeGreaterThan(0);
    expect(out.toLowerCase()).toContain('tool');
  });

  it('callArgs 缺 args 时按空对象执行', async () => {
    let seen: any = 'unset';
    const target = mk('no_arg_tool');
    target.function = async (args: any) => { seen = args; return 'ok'; };
    const e = new ToolTreeEngine([target], { alwaysActive: ALWAYS });
    await callTool(e).function({ name: 'no_arg_tool' } as any, {} as any);
    expect(seen).toEqual({});
  });

  it('单步 browser_* 工具改道 browser_run', async () => {
    const browserStep = mk('browser_navigate');
    const browserRun = mk('browser_run');
    const e = new ToolTreeEngine([mk('search'), mk('readfile'), browserStep, browserRun], { alwaysActive: ALWAYS });
    const out = JSON.parse(String(await callTool(e).function({ name: 'browser_navigate', args: {} } as any, {} as any)));
    expect(out.precondition).toBe('use_browser_run');
    expect(out.guidance).toContain('browser_run');
  });

  it('感知类 browser 工具不被改道', async () => {
    const perception = mk('browser_get_aria_tree');
    perception.function = async () => 'tree';
    const e = new ToolTreeEngine([mk('search'), mk('readfile'), perception, mk('browser_run')], { alwaysActive: ALWAYS });
    expect(await callTool(e).function({ name: 'browser_get_aria_tree', args: {} } as any, {} as any)).toBe('tree');
  });

  it('isConcurrencySafe 委派给被包工具', () => {
    const safe = mk('safe_tool');
    const unsafe = mk('unsafe_tool');
    (unsafe as any).parallelSafety = 'unsafe';
    const paramAware = mk('param_tool');
    (paramAware as any).isConcurrencySafe = (args: any) => args?.big !== true;
    const e = new ToolTreeEngine([mk('search'), safe, unsafe, paramAware], { alwaysActive: ALWAYS });
    const ct = callTool(e);
    expect(ct.isConcurrencySafe!({ name: 'safe_tool' })).toBe(true);
    expect(ct.isConcurrencySafe!({ name: 'unsafe_tool' })).toBe(false);
    expect(ct.isConcurrencySafe!({ name: 'param_tool', args: {} })).toBe(true);
    expect(ct.isConcurrencySafe!({ name: 'param_tool', args: { big: true } })).toBe(false);
    expect(ct.isConcurrencySafe!({ name: 'unknown' })).toBe(false);
  });

  it('内层 isConcurrencySafe 抛错时保守串行', () => {
    const bad = mk('bad_tool');
    (bad as any).isConcurrencySafe = () => { throw new Error('boom'); };
    const e = new ToolTreeEngine([mk('search'), bad], { alwaysActive: ALWAYS });
    expect(callTool(e).isConcurrencySafe!({ name: 'bad_tool' })).toBe(false);
  });
});
