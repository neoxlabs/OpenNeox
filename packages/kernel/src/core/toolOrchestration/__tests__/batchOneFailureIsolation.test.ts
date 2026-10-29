/** A failed call receives its own unsuccessful outcome while sibling calls
 * continue and retain their real results. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runOrchestratedBatch } from '../batch.js';
import * as orchestrateMod from '../orchestrate.js';
import type { ToolCall } from '../../../types/index.js';

const mkCall = (id: string, name: string, args = '{}'): ToolCall => ({
  id, type: 'function', function: { name, arguments: args },
} as unknown as ToolCall);

const mkCtx = (names: string[]) => ({
  tools: names.map((name) => ({
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
    parallelSafety: 'safe',
    isReadOnly: true,
    function: async () => 'ok',
  })),
  signal: new AbortController().signal,
  iteration: 1,
  workspacePath: '/tmp',
  shouldAutoApprove: true,
}) as any;

describe('批次隔离: 一个工具抛异常', () => {
  let spy: any;
  beforeEach(() => { spy = vi.spyOn(orchestrateMod, 'orchestrateToolUse'); });
  afterEach(() => { spy.mockRestore(); });

  it('抛异常的那个失败, 其余照常返回真实结果 (整批不再一起丢)', async () => {
    spy.mockImplementation(async (tc: any) => {
      if (tc.function.name === 'boom') throw new Error('approval rejected');
      return {
        toolCallId: tc.id, toolName: tc.function.name, success: true,
        finalOutput: `real-${tc.function.name}`, totalDurationMs: 1,
      } as any;
    });

    const calls = [mkCall('a', 'readfile'), mkCall('b', 'boom'), mkCall('c', 'search')];
    const res = await runOrchestratedBatch(calls, { ctx: mkCtx(['readfile', 'boom', 'search']) });

    const byId = new Map(res.outcomes.map((o: any) => [o.toolCallId, o]));
    expect(byId.get('a')?.success).toBe(true);
    expect(byId.get('a')?.finalOutput).toBe('real-readfile');
    expect(byId.get('c')?.success).toBe(true);
    expect(byId.get('c')?.finalOutput).toBe('real-search');
    /* 挂的那个自己失败, 而且有可读的原因 */
    expect(byId.get('b')?.success).toBe(false);
    expect(String(byId.get('b')?.finalOutput)).toContain('approval rejected');
  });

  it('整批都抛也不 reject —— 每个都拿到 success=false 的 outcome', async () => {
    spy.mockImplementation(async () => { throw new Error('worker gone'); });
    const calls = [mkCall('a', 'readfile'), mkCall('b', 'search')];
    const res = await runOrchestratedBatch(calls, { ctx: mkCtx(['readfile', 'search']) });
    expect(res.outcomes).toHaveLength(2);
    expect(res.outcomes.every((o: any) => o.success === false)).toBe(true);
  });
});
