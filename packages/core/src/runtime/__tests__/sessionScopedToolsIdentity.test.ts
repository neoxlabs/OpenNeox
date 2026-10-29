import { describe, it, expect } from 'vitest';
import {
  wrapSessionScopedTool,
  wrapSessionScopedToolsInPlace,
  SESSION_SCOPED_TOOL_NAMES,
} from '../sessionScopedTools.js';
import type { Tool } from '@neoxlabs/kernel/types/index.js';

const mk = (name: string): Tool => ({
  name,
  description: name,
  parameters: { type: 'object', properties: {} },
  async function() { return name; },
});

describe('sessionScopedTools', () => {
  it('原地包装: 数组身份不变 (runner 持有的引用不能被换掉)', () => {
    const tools = [mk('readfile'), mk('call_tool'), mk('plan_target')];
    const ref = tools;
    const out = wrapSessionScopedToolsInPlace(tools, 'sess-1');
    expect(out).toBe(ref);
  });

  it('只包 session-scoped 的那几个, 其余原对象不动', () => {
    const readfile = mk('readfile');
    const callTool = mk('call_tool');
    const tools = [readfile, callTool];
    wrapSessionScopedToolsInPlace(tools, 'sess-1');
    expect(tools[0]).toBe(readfile);        // 未包装 → 同一对象
    expect(tools[1]).not.toBe(callTool);    // 包装过 → 新对象
    expect(tools[1].name).toBe('call_tool');
  });

  it('无 sessionId 时完全不动 (纯 API 使用)', () => {
    const callTool = mk('call_tool');
    const tools = [callTool];
    wrapSessionScopedToolsInPlace(tools, undefined);
    expect(tools[0]).toBe(callTool);
  });

  it('target_* 与 call_tool 都在作用域集合里', () => {
    for (const n of ['plan_target', 'check_target_done', 'activate_target', 'call_tool']) {
      expect(SESSION_SCOPED_TOOL_NAMES.has(n)).toBe(true);
    }
    expect(SESSION_SCOPED_TOOL_NAMES.has('update_plan')).toBe(false);
  });

  it('包装后 function 仍可正常调用', async () => {
    const wrapped = wrapSessionScopedTool(mk('call_tool'), 'sess-1');
    await expect(wrapped.function({}, {} as any)).resolves.toBe('call_tool');
  });
});
