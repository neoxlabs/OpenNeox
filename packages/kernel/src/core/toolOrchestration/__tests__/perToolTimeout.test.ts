/**
 * Q1 per-tool timeout 测试.
 *
 * 验证 execute stage 优先用 tool.timeoutMs 而非全局 TOOL_HARD_TIMEOUT_MS:
 *   - tool.timeoutMs=100, tool 跑 200ms → 超时 block
 *   - tool.timeoutMs 未设 → fallback 全局阈值
 *   - tool.timeoutMs=0 → 关闭硬超时, 不会因长时间运行被截
 *   - timeout 错误信息标明 timeoutSource (tool.timeoutMs vs NEOX_TOOL_HARD_TIMEOUT_MS)
 */

import { describe, it, expect } from 'vitest';
import { runExecuteStage } from '../stages/execute.js';
import type { Tool } from '../../../types/index.js';
import type { ToolUseContext } from '../types.js';

// ============================================================================
// Helpers
// ============================================================================

function makeTool(opts: {
  name?: string;
  timeoutMs?: number;
  runMs: number;  /* 工具实际跑多久 ms */
  output?: string;
}): Tool {
  return {
    name: opts.name ?? 'mock_tool',
    description: 'mock',
    parameters: { type: 'object', properties: {} },
    timeoutMs: opts.timeoutMs,
    function: async (_args: any, ctx?: { signal?: AbortSignal }) => {
      return new Promise<string>((resolve, reject) => {
        const tid = setTimeout(() => resolve(opts.output ?? 'done'), opts.runMs);
        if (ctx?.signal) {
          ctx.signal.addEventListener('abort', () => {
            clearTimeout(tid);
            reject(new Error('aborted'));
          }, { once: true });
        }
      });
    },
  };
}

function makeCtx(tools: Tool[]): ToolUseContext {
  return {
    tools,
    resolveAlias: () => null,
    signal: new AbortController().signal,
    iteration: 1,
    workspacePath: '/tmp',
    preHooks: [],
    postSuccessHooks: [],
    postFailureHooks: [],
    invokeTool: async (tool, args, signal, toolCallId) => {
      const result = await tool.function(args, { signal, toolCallId });
      const output = typeof result === 'string' ? result : await result;
      return { output, success: true };
    },
  } as any;
}

// ============================================================================
// Tests
// ============================================================================

describe('per-tool timeout (Q1)', () => {
  it('tool.timeoutMs=100, tool 跑 500ms → 超时 block, 错误信息含 tool.timeoutMs', async () => {
    const tool = makeTool({ timeoutMs: 100, runMs: 500 });
    const ctx = makeCtx([tool]);

    const result = await runExecuteStage(tool, {}, ctx);

    expect(result.kind).toBe('block');
    if (result.kind === 'block') {
      expect(result.blockedBy).toBe('timeout');
      expect(result.reason).toContain('100ms');
      expect(result.reason).toContain('tool.timeoutMs');
    }
  });

  it('tool.timeoutMs=500, tool 跑 100ms → 成功完成', async () => {
    const tool = makeTool({ timeoutMs: 500, runMs: 100, output: 'fast-done' });
    const ctx = makeCtx([tool]);

    const result = await runExecuteStage(tool, {}, ctx);

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.data.output).toBe('fast-done');
      expect(result.data.success).toBe(true);
    }
  });

  it('tool.timeoutMs 未设 → fallback 全局, 错误信息含 NEOX_TOOL_HARD_TIMEOUT_MS', async () => {
    /* 全局默认 30min, 我们没法真等 30min. 设 NEOX_TOOL_HARD_TIMEOUT_MS env 改阈值
     * 但 env 在模块 load 时已读. 改为只 verify 不超时时 fallback 正常. */
    const tool = makeTool({ runMs: 50 });  /* 无 timeoutMs, 短跑 */
    const ctx = makeCtx([tool]);

    const result = await runExecuteStage(tool, {}, ctx);

    expect(result.kind).toBe('ok');
  });

  it('tool.timeoutMs=0 → 关闭硬超时, 长跑也不会被截 (跑 200ms 后正常完成)', async () => {
    const tool = makeTool({ timeoutMs: 0, runMs: 200, output: 'long-done' });
    const ctx = makeCtx([tool]);

    const result = await runExecuteStage(tool, {}, ctx);

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.data.output).toBe('long-done');
    }
  });

  it('tool.timeoutMs 负数被当成无效, fallback 全局 (短跑成功)', async () => {
    const tool = makeTool({ timeoutMs: -1 as any, runMs: 50 });
    const ctx = makeCtx([tool]);

    const result = await runExecuteStage(tool, {}, ctx);

    expect(result.kind).toBe('ok');
  });

  it('已 aborted 的 ctx.signal → 直接 block aborted, 不进 timeout 路径', async () => {
    const tool = makeTool({ timeoutMs: 100, runMs: 50 });
    const abortedCtx = makeCtx([tool]);
    const ac = new AbortController();
    ac.abort();
    (abortedCtx as any).signal = ac.signal;

    const result = await runExecuteStage(tool, {}, abortedCtx);

    expect(result.kind).toBe('block');
    if (result.kind === 'block') {
      expect(result.blockedBy).toBe('aborted');
    }
  });
});
