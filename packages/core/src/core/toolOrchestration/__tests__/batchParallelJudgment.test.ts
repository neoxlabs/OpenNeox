/**
 * judgeParallelSafe 分级策略测试 — 确认新增的 parallelSafety/isReadOnly 识别路径
 */

import { describe, it, expect } from 'vitest';
import { runOrchestratedBatch } from '@neoxlabs/kernel/core/toolOrchestration/batch.js';
import { makeCtx, makeTool, makeToolCall } from './fixtures.js';

function tracker() {
  let active = 0;
  let peak = 0;
  return {
    get peak() { return peak; },
    invoke: async (tool: any) => {
      active++;
      if (active > peak) peak = active;
      await new Promise(r => setTimeout(r, 20));
      active--;
      return { output: `${tool.name}:ok`, success: true };
    },
  };
}

describe('judgeParallelSafe — Tool static flags honored', () => {
  it('parallelSafety: "safe" tools run in parallel even if not in canonical whitelist', async () => {
    const t = tracker();
    const ctx = makeCtx({
      tools: [makeTool('my_custom_readonly', { parallelSafety: 'safe' })],
      invokeTool: t.invoke,
    });
    const calls = [
      makeToolCall('my_custom_readonly', {}, 'c1'),
      makeToolCall('my_custom_readonly', {}, 'c2'),
      makeToolCall('my_custom_readonly', {}, 'c3'),
    ];
    await runOrchestratedBatch(calls, { ctx, maxConcurrency: 5 });
    expect(t.peak).toBeGreaterThan(1);
  });

  it('isReadOnly: true tools run in parallel', async () => {
    const t = tracker();
    const ctx = makeCtx({
      tools: [makeTool('my_readonly', { isReadOnly: true })],
      invokeTool: t.invoke,
    });
    const calls = [
      makeToolCall('my_readonly', {}, 'c1'),
      makeToolCall('my_readonly', {}, 'c2'),
    ];
    await runOrchestratedBatch(calls, { ctx, maxConcurrency: 5 });
    expect(t.peak).toBeGreaterThan(1);
  });

  it('parallelSafety: "unsafe" forces serial even for whitelisted tool', async () => {
    const t = tracker();
    // readfile 在 canonical 白名单里是 safe,但这里显式标 unsafe
    const ctx = makeCtx({
      tools: [makeTool('readfile', { parallelSafety: 'unsafe' })],
      invokeTool: t.invoke,
    });
    const calls = [
      makeToolCall('readfile', { file_path: '/a' }, 'c1'),
      makeToolCall('readfile', { file_path: '/b' }, 'c2'),
    ];
    await runOrchestratedBatch(calls, { ctx });
    expect(t.peak).toBe(1);
  });

  it('isConcurrencySafe(args) wins over parallelSafety', async () => {
    const t = tracker();
    // 标了 parallelSafety='safe' 但动态函数说 unsafe → 应串行
    const ctx = makeCtx({
      tools: [
        makeTool('my_tool', {
          parallelSafety: 'safe',
          isReadOnly: true,
          isConcurrencySafe: () => false,
        }),
      ],
      invokeTool: t.invoke,
    });
    const calls = [
      makeToolCall('my_tool', {}, 'c1'),
      makeToolCall('my_tool', {}, 'c2'),
    ];
    await runOrchestratedBatch(calls, { ctx });
    expect(t.peak).toBe(1);
  });
});
