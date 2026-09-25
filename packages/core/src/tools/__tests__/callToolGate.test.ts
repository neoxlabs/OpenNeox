import { describe, expect, it } from 'vitest';
import { ToolTreeEngine } from '../toolTreeEngine.js';
import type { Tool } from '@neoxlabs/kernel/types/index.js';

function mkTool(name: string, fn: Tool['function']): Tool {
  return {
    name,
    description: name,
    parameters: { type: 'object', properties: {}, required: [] },
    function: fn,
  } as Tool;
}

function makeEngineWith(recordExec: () => void) {
  const del = mkTool('delete_file', async () => { recordExec(); return 'deleted'; });
  const engine = new ToolTreeEngine([del]);
  const callTool = engine.liveTools.find((t) => t.name === 'call_tool');
  expect(callTool).toBeDefined();
  return callTool!;
}

describe('call_tool nested gate (防 deferred 工具绕过审批)', () => {
  it('gate 拒绝时不执行被包裹工具, 返回 block 信息', async () => {
    let executed = false;
    const callTool = makeEngineWith(() => { executed = true; });
    const res = await callTool.function(
      { name: 'delete_file', args: { path: 'x' } },
      { checkNestedToolGate: async () => ({ allowed: false, reason: 'user denied' }) },
    );
    expect(executed).toBe(false);
    expect(String(res)).toMatch(/blocked|denied|user denied/i);
  });

  it('gate 允许时正常执行被包裹工具', async () => {
    let executed = false;
    const callTool = makeEngineWith(() => { executed = true; });
    const res = await callTool.function(
      { name: 'delete_file', args: { path: 'x' } },
      { checkNestedToolGate: async () => ({ allowed: true }) },
    );
    expect(executed).toBe(true);
    expect(String(res)).toBe('deleted');
  });

  it('无 gate 钩子时拒绝派发有副作用的工具 (fail-closed)', async () => {
    let executed = false;
    const callTool = makeEngineWith(() => { executed = true; });
    const res = await callTool.function({ name: 'delete_file', args: { path: 'x' } }, {});
    expect(executed).toBe(false);
    expect(String(res)).toMatch(/blocked/i);
  });

  it('gate 接收到真实的 wrapped tool 名与 args', async () => {
    let seenName = '';
    let seenArgs: Record<string, unknown> = {};
    const callTool = makeEngineWith(() => {});
    await callTool.function(
      { name: 'delete_file', args: { path: '/tmp/secret' } },
      {
        checkNestedToolGate: async (tool, args) => {
          seenName = tool.name;
          seenArgs = args;
          return { allowed: false, reason: 'stop' };
        },
      },
    );
    expect(seenName).toBe('delete_file');
    expect(seenArgs).toEqual({ path: '/tmp/secret' });
  });
});

describe('call_tool 无闸时 fail-closed', () => {
  function engineFor(tool: Tool) {
    const engine = new ToolTreeEngine([tool]);
    return engine.liveTools.find(t => t.name === 'call_tool')!;
  }

  it('无闸 + 有副作用工具 → 拒绝派发, 不执行', async () => {
    let ran = false;
    const del = mkTool('delete_file', async () => { ran = true; return 'deleted'; });
    const callTool = engineFor(del);
    /* 不传 context → 没有 checkNestedToolGate */
    const out = String(await callTool.function({ name: 'delete_file', args: {} }));
    expect(ran).toBe(false);
    expect(out).toMatch(/blocked/i);
    expect(out).toMatch(/no permission gate/i);
  });

  it('无闸 + 显式只读工具 → 允许派发 (不能把只读也拦死)', async () => {
    let ran = false;
    const ro = mkTool('readfile', async () => { ran = true; return 'content'; });
    (ro as any).isReadOnly = true;
    const callTool = engineFor(ro);
    const out = String(await callTool.function({ name: 'readfile', args: {} }));
    expect(ran).toBe(true);
    expect(out).toBe('content');
  });

  it('没标 isReadOnly 的工具按有副作用处理 (漏标是常态, 默认不能倒向放行)', async () => {
    let ran = false;
    const unknown = mkTool('some_new_tool', async () => { ran = true; return 'ok'; });
    const callTool = engineFor(unknown);
    const out = String(await callTool.function({ name: 'some_new_tool', args: {} }));
    expect(ran).toBe(false);
    expect(out).toMatch(/blocked/i);
  });

  it('只读但策略要求过闸 (defaultPermission=ask) → 无闸时仍拒', async () => {
    let ran = false;
    const t = mkTool('sensitive_read', async () => { ran = true; return 'x'; });
    (t as any).isReadOnly = true;
    (t as any).permission = { defaultPermission: 'ask' };
    const callTool = engineFor(t);
    const out = String(await callTool.function({ name: 'sensitive_read', args: {} }));
    expect(ran).toBe(false);
    expect(out).toMatch(/blocked/i);
  });

  it('有闸时不受影响: 闸放行则照常执行有副作用的工具', async () => {
    let ran = false;
    const del = mkTool('delete_file', async () => { ran = true; return 'deleted'; });
    const callTool = engineFor(del);
    const out = String(await callTool.function(
      { name: 'delete_file', args: {} },
      { checkNestedToolGate: async () => ({ allowed: true }) } as any,
    ));
    expect(ran).toBe(true);
    expect(out).toBe('deleted');
  });
});
