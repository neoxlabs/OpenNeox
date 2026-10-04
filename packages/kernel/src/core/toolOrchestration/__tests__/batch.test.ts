/**
 * runOrchestratedBatch 分组语义测试.
 *
 *  吞吐修复的回归保护: hitSerial 之后的串行尾巴里, 连续的
 * parallel-safe 调用应作为一组并发执行 (组间保序: 写完才读、读完才写)。
 * 之前 [read, read, edit, read, read] 里 edit 之后的 read 被逐个串行,
 * 常见"改完读回验证"batch 的墙钟被结构性放大。
 */

import { describe, it, expect } from 'vitest';
import { runOrchestratedBatch } from '../batch.js';
import type { Tool, ToolCall } from '../../../types/index.js';
import type { ToolUseContext } from '../types.js';

// ============================================================================
// Helpers
// ============================================================================

type ExecEvent = { name: string; id: string; phase: 'start' | 'end'; at: number };

function makeRecordingTool(opts: {
  name: string;
  readOnly: boolean;
  runMs: number;
  events: ExecEvent[];
}): Tool {
  return {
    name: opts.name,
    description: 'mock',
    parameters: { type: 'object', properties: {} },
    isReadOnly: opts.readOnly,
    parallelSafety: opts.readOnly ? 'safe' : 'unsafe',
    function: async (_args: any, ctx?: { toolCallId?: string }) => {
      const id = ctx?.toolCallId ?? '?';
      opts.events.push({ name: opts.name, id, phase: 'start', at: Date.now() });
      await new Promise((r) => setTimeout(r, opts.runMs));
      opts.events.push({ name: opts.name, id, phase: 'end', at: Date.now() });
      return `${opts.name}:${id}:done`;
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
    invokeTool: async (tool: Tool, args: any, signal: AbortSignal, toolCallId: string) => {
      const result = await tool.function(args, { signal, toolCallId });
      const output = typeof result === 'string' ? result : await result;
      return { output, success: true };
    },
  } as any;
}

function call(id: string, name: string, args: Record<string, unknown> = {}): ToolCall {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  } as ToolCall;
}

/** 事件序列断言助手: a 的 end 必须早于 b 的 start */
function endedBefore(events: ExecEvent[], idA: string, idB: string): boolean {
  const endA = events.find((e) => e.id === idA && e.phase === 'end');
  const startB = events.find((e) => e.id === idB && e.phase === 'start');
  if (!endA || !startB) return false;
  return events.indexOf(endA) < events.indexOf(startB);
}

/** 两个调用是否有时间重叠 (并发执行的证据) */
function overlapped(events: ExecEvent[], idA: string, idB: string): boolean {
  const iSA = events.findIndex((e) => e.id === idA && e.phase === 'start');
  const iEA = events.findIndex((e) => e.id === idA && e.phase === 'end');
  const iSB = events.findIndex((e) => e.id === idB && e.phase === 'start');
  return iSA >= 0 && iSB >= 0 && iEA >= 0 && iSB > iSA && iSB < iEA;
}

// ============================================================================
// Tests
// ============================================================================

describe('runOrchestratedBatch 串行尾巴的并发分组', () => {
  it('[read×2, edit, read×2]: 写后只读组内并发, 组间保序', async () => {
    const events: ExecEvent[] = [];
    const readTool = makeRecordingTool({ name: 'mock_read', readOnly: true, runMs: 60, events });
    const editTool = makeRecordingTool({ name: 'edit_file', readOnly: false, runMs: 60, events });
    const ctx = makeCtx([readTool, editTool]);

    const result = await runOrchestratedBatch(
      [
        call('r1', 'mock_read', { path: '/tmp/a.ts' }),
        call('r2', 'mock_read', { path: '/tmp/b.ts' }),
        call('w1', 'edit_file', { file_path: '/tmp/a.ts' }),
        call('r3', 'mock_read', { path: '/tmp/a.ts' }),
        call('r4', 'mock_read', { path: '/tmp/c.ts' }),
      ],
      { ctx, maxConcurrency: 4 },
    );

    // 全部成功且按输入顺序对齐
    expect(result.outcomes).toHaveLength(5);
    expect(result.outcomes.map((o) => o.toolCallId)).toEqual(['r1', 'r2', 'w1', 'r3', 'r4']);

    // 保序: 前置读完 → 写; 写完 → 尾部读
    expect(endedBefore(events, 'r1', 'w1')).toBe(true);
    expect(endedBefore(events, 'r2', 'w1')).toBe(true);
    expect(endedBefore(events, 'w1', 'r3')).toBe(true);
    expect(endedBefore(events, 'w1', 'r4')).toBe(true);

    // 组内并发: 头部 r1/r2 重叠, 尾部 r3/r4 重叠 (修复前 r3/r4 是逐个串行)
    expect(overlapped(events, 'r1', 'r2')).toBe(true);
    expect(overlapped(events, 'r3', 'r4')).toBe(true);
  });

  it('write-after-read 保序: [edit f1, read x, edit f1] 第二刀等读完', async () => {
    const events: ExecEvent[] = [];
    const readTool = makeRecordingTool({ name: 'mock_read', readOnly: true, runMs: 50, events });
    const editTool = makeRecordingTool({ name: 'edit_file', readOnly: false, runMs: 50, events });
    const ctx = makeCtx([readTool, editTool]);

    await runOrchestratedBatch(
      [
        call('w1', 'edit_file', { file_path: '/tmp/f1.ts' }),
        call('rx', 'mock_read', { path: '/tmp/f1.ts' }),
        call('w2', 'edit_file', { file_path: '/tmp/f1.ts' }),
      ],
      { ctx, maxConcurrency: 4 },
    );

    expect(endedBefore(events, 'w1', 'rx')).toBe(true);
    expect(endedBefore(events, 'rx', 'w2')).toBe(true);
  });

  it('barrier 工具 (无路径写类) 仍独占执行', async () => {
    const events: ExecEvent[] = [];
    const readTool = makeRecordingTool({ name: 'mock_read', readOnly: true, runMs: 50, events });
    const shellTool = makeRecordingTool({ name: 'mock_shell', readOnly: false, runMs: 50, events });
    const ctx = makeCtx([readTool, shellTool]);

    await runOrchestratedBatch(
      [
        call('s1', 'mock_shell', {}),
        call('r1', 'mock_read', { path: '/tmp/a.ts' }),
        call('r2', 'mock_read', { path: '/tmp/b.ts' }),
        call('s2', 'mock_shell', {}),
      ],
      { ctx, maxConcurrency: 4 },
    );

    expect(endedBefore(events, 's1', 'r1')).toBe(true);
    expect(endedBefore(events, 's1', 'r2')).toBe(true);
    expect(endedBefore(events, 'r1', 's2')).toBe(true);
    expect(endedBefore(events, 'r2', 's2')).toBe(true);
    expect(overlapped(events, 'r1', 'r2')).toBe(true);
  });
});
