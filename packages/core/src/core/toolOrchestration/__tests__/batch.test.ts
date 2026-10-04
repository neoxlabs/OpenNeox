import { describe, it, expect, vi } from 'vitest';
import { runOrchestratedBatch } from '@neoxlabs/kernel/core/toolOrchestration/batch.js';
import { makeCtx, makeTool, makeToolCall } from './fixtures.js';
import type { ToolCall } from '@neoxlabs/kernel/types/index.js';

// 一个帮助工具:记录 tool 执行的顺序 + 最大并发数
function makeTracker() {
  const order: string[] = [];
  let active = 0;
  let peak = 0;
  return {
    order,
    get peak() { return peak; },
    makeInvoke(ms = 10) {
      return async (tool: any) => {
        active += 1;
        if (active > peak) peak = active;
        order.push(`+${tool.name}`);
        await new Promise((r) => setTimeout(r, ms));
        order.push(`-${tool.name}`);
        active -= 1;
        return { output: `${tool.name}:ok`, success: true };
      };
    },
  };
}

describe('runOrchestratedBatch', () => {
  it('empty input → empty outcomes', async () => {
    const ctx = makeCtx();
    const r = await runOrchestratedBatch([], { ctx });
    expect(r.outcomes).toEqual([]);
    expect(r.hasForceTerminate).toBe(false);
  });

  it('all parallel-safe tools run concurrently', async () => {
    const tracker = makeTracker();
    const ctx = makeCtx({
      tools: [makeTool('readfile'), makeTool('search')],
      invokeTool: tracker.makeInvoke(20),
    });
    const calls: ToolCall[] = [
      makeToolCall('readfile', { file_path: '/a.ts' }, 'c1'),
      makeToolCall('readfile', { file_path: '/b.ts' }, 'c2'),
      makeToolCall('search', { path: '/', pattern: 'x' }, 'c3'),
    ];
    await runOrchestratedBatch(calls, { ctx, maxConcurrency: 10 });
    // 3 个 readfile/search 全都应该并发在一起
    expect(tracker.peak).toBeGreaterThan(1);
  });

  it('respects maxConcurrency cap', async () => {
    const tracker = makeTracker();
    const ctx = makeCtx({
      tools: [makeTool('readfile')],
      invokeTool: tracker.makeInvoke(30),
    });
    const calls = Array.from({ length: 8 }, (_, i) =>
      makeToolCall('readfile', { file_path: `/${i}.ts` }, `c${i}`),
    );
    await runOrchestratedBatch(calls, { ctx, maxConcurrency: 2 });
    expect(tracker.peak).toBeLessThanOrEqual(2);
  });

  it('hitSerial semantics: once an unsafe tool appears, rest are serial', async () => {
    const tracker = makeTracker();
    const ctx = makeCtx({
      tools: [
        makeTool('readfile'),
        makeTool('write_file'),
        makeTool('search'),   // 虽然 parallel-safe, 但因为 hit serial 后也归 serial
      ],
      invokeTool: tracker.makeInvoke(10),
    });
    const calls: ToolCall[] = [
      makeToolCall('readfile', { file_path: '/a.ts' }, 'c1'),
      makeToolCall('write_file', { file_path: '/x.ts', content: '1' }, 'c2'),
      makeToolCall('search', { path: '/', pattern: 'y' }, 'c3'),
    ];
    await runOrchestratedBatch(calls, { ctx });
    // c2 & c3 应该是串行的(c1 并行/单独跑,c2 后才 c3)
    const c2Start = tracker.order.indexOf('+write_file');
    const c2End = tracker.order.indexOf('-write_file');
    const c3Start = tracker.order.indexOf('+search');
    expect(c2End).toBeLessThan(c3Start); // c2 完成之后 c3 才开始
    // hitSerial 意味着 c2 和 c3 不并行
    expect(c2Start).toBeLessThan(c2End);
    expect(c2End).toBeLessThan(c3Start);
  });

  it('different files: write_file to different paths run concurrently', async () => {
    const tracker = makeTracker();
    const ctx = makeCtx({
      tools: [makeTool('write_file')],
      invokeTool: tracker.makeInvoke(30),
    });
    const calls: ToolCall[] = [
      makeToolCall('write_file', { file_path: '/a.ts', content: '1' }, 'c1'),
      makeToolCall('write_file', { file_path: '/b.ts', content: '2' }, 'c2'),
      makeToolCall('write_file', { file_path: '/c.ts', content: '3' }, 'c3'),
    ];
    await runOrchestratedBatch(calls, { ctx, workspacePath: '/ws' });
    // 都是 scoped (不同 file_path), 无冲突, 并发跑
    expect(tracker.peak).toBeGreaterThan(1);
  });

  it('same file: write_file to same path runs serially', async () => {
    const tracker = makeTracker();
    const ctx = makeCtx({
      tools: [makeTool('write_file')],
      invokeTool: tracker.makeInvoke(30),
    });
    const calls: ToolCall[] = [
      makeToolCall('write_file', { file_path: '/same.ts', content: 'v1' }, 'c1'),
      makeToolCall('write_file', { file_path: '/same.ts', content: 'v2' }, 'c2'),
    ];
    await runOrchestratedBatch(calls, { ctx, workspacePath: '/ws' });
    // 相同路径必须串行
    expect(tracker.peak).toBe(1);
  });

  it('barrier tool (execute_shell) blocks neighboring tools', async () => {
    const tracker = makeTracker();
    const ctx = makeCtx({
      tools: [makeTool('execute_shell'), makeTool('write_file')],
      invokeTool: tracker.makeInvoke(20),
    });
    const calls: ToolCall[] = [
      makeToolCall('write_file', { file_path: '/a.ts', content: '1' }, 'c1'),
      makeToolCall('execute_shell', { command: 'git status' }, 'c2'),
      makeToolCall('write_file', { file_path: '/b.ts', content: '2' }, 'c3'),
    ];
    await runOrchestratedBatch(calls, { ctx, workspacePath: '/ws' });
    // c2 (barrier) 应该和 c1、c3 都不并行
    const c1End = tracker.order.indexOf('-write_file');
    const c2Start = tracker.order.indexOf('+execute_shell');
    const c2End = tracker.order.indexOf('-execute_shell');
    const lastWriteStart = tracker.order.lastIndexOf('+write_file');
    expect(c1End).toBeLessThan(c2Start);
    expect(c2End).toBeLessThan(lastWriteStart);
  });

  it('onBeforeEach / onOutcome hooks fire in correct order', async () => {
    const events: string[] = [];
    const ctx = makeCtx({
      tools: [makeTool('readfile')],
      invokeTool: async (tool) => {
        events.push(`exec:${tool.name}`);
        return { output: `${tool.name}:ok`, success: true };
      },
    });
    const calls: ToolCall[] = [
      makeToolCall('readfile', { file_path: '/a' }, 'c1'),
      makeToolCall('readfile', { file_path: '/b' }, 'c2'),
    ];
    await runOrchestratedBatch(calls, {
      ctx,
      onBeforeEach: (tc) => events.push(`before:${tc.id}`),
      onOutcome: (outcome) => events.push(`after:${outcome.toolCallId}`),
    });
    // 每个 tool 的 before 在 exec 之前, after 在 exec 之后
    for (const id of ['c1', 'c2']) {
      const beforeIdx = events.indexOf(`before:${id}`);
      const afterIdx = events.indexOf(`after:${id}`);
      expect(beforeIdx).toBeGreaterThanOrEqual(0);
      expect(afterIdx).toBeGreaterThan(beforeIdx);
    }
  });

  it('outcomes are aligned to input order', async () => {
    const ctx = makeCtx({
      tools: [makeTool('readfile')],
      invokeTool: async (tool, args) => ({
        output: `${tool.name}:${(args as any).file_path}`,
        success: true,
      }),
    });
    // 即使并发乱序完成, outcomes 也应该按输入顺序排
    const calls = Array.from({ length: 5 }, (_, i) =>
      makeToolCall('readfile', { file_path: `/${i}` }, `c${i}`),
    );
    const r = await runOrchestratedBatch(calls, { ctx });
    expect(r.outcomes.map((o) => o.toolCallId)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4']);
  });

  it('hasForceTerminate bubbles up HARD loop / critical risk', async () => {
    const ctx = makeCtx({
      tools: [makeTool('execute_shell')],
      risk: { evaluate: () => ({ level: 'critical', summary: 'dangerous' }) },
    });
    const calls = [
      makeToolCall('execute_shell', { command: 'rm -rf /' }, 'c1'),
    ];
    const r = await runOrchestratedBatch(calls, { ctx });
    expect(r.hasForceTerminate).toBe(true);
    expect(r.outcomes[0].blockedBy).toBe('risk');
  });

  it('aborted signal stops serial phase early', async () => {
    const ac = new AbortController();
    const tracker = makeTracker();
    const ctx = makeCtx({
      tools: [makeTool('execute_shell')],
      invokeTool: async (tool) => {
        tracker.order.push(`exec:${tool.name}`);
        await new Promise((r) => setTimeout(r, 5));
        return { output: 'ok', success: true };
      },
    });
    const calls = Array.from({ length: 5 }, (_, i) =>
      makeToolCall('execute_shell', { command: `echo ${i}` }, `c${i}`),
    );
    ac.abort();
    const r = await runOrchestratedBatch(calls, { ctx, signal: ac.signal });
    // 已 aborted, 串行 phase 应该立刻跳过 —— 0 个 outcome(或远少于 5)
    expect(r.outcomes.length).toBeLessThan(calls.length);
  });

  it('tool.isConcurrencySafe(args) overrides global whitelist', async () => {
    const tracker = makeTracker();
    // big_readfile 不在白名单里, 但 tool 自身 isConcurrencySafe 返回 true
    const bigReadTool = makeTool('big_readfile', {
      isConcurrencySafe: (args: any) => (args?.num_lines ?? 0) <= 100,
    } as any);
    const ctx = makeCtx({
      tools: [bigReadTool],
      invokeTool: tracker.makeInvoke(20),
    });
    // num_lines=50 → isConcurrencySafe=true → 允许并发
    const smallCalls = [
      makeToolCall('big_readfile', { num_lines: 50 }, 'c1'),
      makeToolCall('big_readfile', { num_lines: 50 }, 'c2'),
      makeToolCall('big_readfile', { num_lines: 50 }, 'c3'),
    ];
    await runOrchestratedBatch(smallCalls, { ctx });
    expect(tracker.peak).toBeGreaterThan(1);

    // num_lines=99999 → isConcurrencySafe=false → 串行
    const tracker2 = makeTracker();
    const ctx2 = makeCtx({
      tools: [bigReadTool],
      invokeTool: tracker2.makeInvoke(20),
    });
    const bigCalls = [
      makeToolCall('big_readfile', { num_lines: 99999 }, 'c1'),
      makeToolCall('big_readfile', { num_lines: 99999 }, 'c2'),
    ];
    await runOrchestratedBatch(bigCalls, { ctx: ctx2 });
    expect(tracker2.peak).toBe(1);
  });

  it('tool.isConcurrencySafe throwing → fail-closed to serial', async () => {
    const tracker = makeTracker();
    const badTool = makeTool('bad', {
      isConcurrencySafe: () => { throw new Error('bad judge'); },
    } as any);
    const ctx = makeCtx({
      tools: [badTool],
      invokeTool: tracker.makeInvoke(10),
    });
    const calls = [
      makeToolCall('bad', {}, 'c1'),
      makeToolCall('bad', {}, 'c2'),
    ];
    await runOrchestratedBatch(calls, { ctx });
    // 判定异常 → 归到 serial(不并发)
    expect(tracker.peak).toBe(1);
  });

  it('falls back to global whitelist when tool has no isConcurrencySafe', async () => {
    const tracker = makeTracker();
    // readfile 在白名单里, 但 tool 定义没有 isConcurrencySafe
    const ctx = makeCtx({
      tools: [makeTool('readfile')],
      invokeTool: tracker.makeInvoke(20),
    });
    const calls = [
      makeToolCall('readfile', {}, 'c1'),
      makeToolCall('readfile', {}, 'c2'),
    ];
    await runOrchestratedBatch(calls, { ctx });
    expect(tracker.peak).toBeGreaterThan(1);
  });

  it('custom isParallelSafe override', async () => {
    const tracker = makeTracker();
    const ctx = makeCtx({
      tools: [makeTool('custom_tool')],
      invokeTool: tracker.makeInvoke(20),
    });
    const calls = Array.from({ length: 3 }, (_, i) =>
      makeToolCall('custom_tool', {}, `c${i}`),
    );
    // 默认 custom_tool 不在 PARALLEL_SAFE_TOOLS 里, 会串行
    await runOrchestratedBatch(calls, { ctx });
    expect(tracker.peak).toBe(1);

    // 覆盖 isParallelSafe 后 → 并行
    const tracker2 = makeTracker();
    const ctx2 = makeCtx({
      tools: [makeTool('custom_tool')],
      invokeTool: tracker2.makeInvoke(20),
    });
    await runOrchestratedBatch(calls, {
      ctx: ctx2,
      isParallelSafe: () => true,
    });
    expect(tracker2.peak).toBeGreaterThan(1);
  });
});
