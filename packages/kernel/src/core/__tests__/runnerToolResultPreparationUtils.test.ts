/**
 * runnerToolResultPreparationUtils — F1 ToolCallDeduplicator wire 集成测试
 *
 * 验证 prepareToolResultForMemory 接入 dedup 的端到端行为:
 *   - dedup 触发 r1/r2/r3 reminder 被 append 到 truncatedResult
 *   - dedup 触发 forceStop 时返回 dedupForceStop=true
 *   - 未传 toolCallDedup 时不影响原逻辑 (兼容性)
 */

import { describe, expect, it } from 'vitest';
import { prepareToolResultForMemory } from '../runnerToolResultPreparationUtils.js';
import { ToolCallDeduplicator, REPEAT_FORCE_STOP_STREAK } from '../reasoning/toolCallDeduplicator.js';

const fakeAutoVerifyPipeline = {
  shouldVerify: () => false,
  verify: async () => null,
  formatForToolResult: () => undefined,
};

const passthroughPolicy = {
  applyToolResultPolicy: async (input: { result: any; toolCalls: any[]; truncatedResult: string }) => ({
    truncatedResult: input.truncatedResult,
    toolInput: {},
    shouldBreak: false,
    encounteredError: false,
  }),
};

function makeBasicOptions(result: { id: string; name: string; output: string; success: boolean }, args: Record<string, any>) {
  return {
    result,
    toolCalls: [{ id: result.id, type: 'function' as const, function: { name: result.name, arguments: JSON.stringify(args) } }],
    executableToolCalls: [{ id: result.id }],
    parsedArgsByToolId: new Map([[result.id, { args, valid: true, raw: JSON.stringify(args) }]]),
    autoVerifyPipeline: fakeAutoVerifyPipeline,
    extractVerifyFilePath: () => undefined,
    executionPolicyOrchestrator: passthroughPolicy,
  };
}

describe('prepareToolResultForMemory + ToolCallDeduplicator wire', () => {
  it('未传 toolCallDedup → 行为不变, 不 append dedup reminder, dedupForceStop=undefined', async () => {
    const result = { id: 'r1', name: 'readfile', output: 'hello', success: true };
    const args = { path: '/a.ts' };

    const out = await prepareToolResultForMemory(makeBasicOptions(result, args));

    expect(out.truncatedResult).not.toContain('system-reminder');
    expect(out.dedupForceStop).toBeFalsy();
  });

  it('streak=1 (首次) → 无 reminder', async () => {
    const dedup = new ToolCallDeduplicator();
    const result = { id: 'r1', name: 'readfile', output: 'hello', success: true };
    const args = { path: '/a.ts' };

    const out = await prepareToolResultForMemory({ ...makeBasicOptions(result, args), toolCallDedup: dedup });

    expect(out.truncatedResult).not.toContain('system-reminder');
    expect(out.dedupForceStop).toBe(false);
  });

  it('streak >= 3 → r1 reminder append 到 result', async () => {
    const dedup = new ToolCallDeduplicator();
    const args = { path: '/a.ts' };

    /* 3 次相同调用 */
    let lastOut: Awaited<ReturnType<typeof prepareToolResultForMemory>> | null = null;
    for (let i = 0; i < 3; i++) {
      const result = { id: `r${i}`, name: 'readfile', output: 'hello', success: true };
      lastOut = await prepareToolResultForMemory({ ...makeBasicOptions(result, args), toolCallDedup: dedup });
    }

    expect(lastOut!.truncatedResult).toContain('system-reminder');
    expect(lastOut!.truncatedResult).toContain('重复同一个 tool call');
    expect(lastOut!.dedupForceStop).toBe(false);
  });

  it('streak >= 5 → r2 reminder (含 tool name + 重复次数 + args)', async () => {
    const dedup = new ToolCallDeduplicator();
    const args = { path: '/a.ts' };

    let lastOut: Awaited<ReturnType<typeof prepareToolResultForMemory>> | null = null;
    for (let i = 0; i < 5; i++) {
      const result = { id: `r${i}`, name: 'readfile', output: 'hello', success: true };
      lastOut = await prepareToolResultForMemory({ ...makeBasicOptions(result, args), toolCallDedup: dedup });
    }

    expect(lastOut!.truncatedResult).toContain('readfile');
    expect(lastOut!.truncatedResult).toContain('重复次数: 5');
    expect(lastOut!.truncatedResult).toContain('/a.ts');
    expect(lastOut!.dedupForceStop).toBe(false);
  });

  it(`streak >= ${REPEAT_FORCE_STOP_STREAK} → dedupForceStop=true + r3 reminder`, async () => {
    const dedup = new ToolCallDeduplicator();
    const args = { path: '/a.ts' };

    let lastOut: Awaited<ReturnType<typeof prepareToolResultForMemory>> | null = null;
    for (let i = 0; i < REPEAT_FORCE_STOP_STREAK; i++) {
      const result = { id: `r${i}`, name: 'readfile', output: 'hello', success: true };
      lastOut = await prepareToolResultForMemory({ ...makeBasicOptions(result, args), toolCallDedup: dedup });
    }

    expect(lastOut!.dedupForceStop).toBe(true);
    expect(lastOut!.truncatedResult).toContain('死循环');
    expect(lastOut!.truncatedResult).toContain('立即停止');
  });

  it('不同 args 反复切, dedup 不触发 (streak 每次重置)', async () => {
    const dedup = new ToolCallDeduplicator();

    for (let i = 0; i < 10; i++) {
      const args = { path: `/file${i}.ts` };
      const result = { id: `r${i}`, name: 'readfile', output: 'hello', success: true };
      const out = await prepareToolResultForMemory({ ...makeBasicOptions(result, args), toolCallDedup: dedup });
      expect(out.truncatedResult).not.toContain('system-reminder');
      expect(out.dedupForceStop).toBe(false);
    }
  });

  it('dedup check 失败 (args 拿不到等) 静默跳过, 不影响主流程', async () => {
    const dedup = new ToolCallDeduplicator();
    /* 模拟: executableToolCalls 不含对应 id, args 拿不到 → dedup 用 undefined args 但仍能工作 */
    const result = { id: 'r1', name: 'readfile', output: 'hello', success: true };
    const opts = {
      ...makeBasicOptions(result, {}),
      executableToolCalls: [],   // empty - matching find 返 undefined
      toolCallDedup: dedup,
    };

    /* 不应该 throw */
    const out = await prepareToolResultForMemory(opts);
    expect(out).toBeDefined();
    expect(out.dedupForceStop).toBe(false);
  });

  it('R3: 不传 modelMaxInputTokens → 12K 老行为 (长 output 截到 12K 内)', async () => {
    const longOutput = 'A'.repeat(20000);
    const result = { id: 'r1', name: 'readfile', output: longOutput, success: true };
    const args = { path: '/a.ts' };

    const out = await prepareToolResultForMemory(makeBasicOptions(result, args));
    expect(out.truncatedResult.length).toBeLessThan(20000);
    expect(out.truncatedResult.length).toBeLessThanOrEqual(15000);  // truncate default 15000 max bytes
  });

  it('R3: modelMaxInputTokens=200000 (Sonnet/Kimi) → softLimit = 10000', async () => {
    const longOutput = 'B'.repeat(20000);
    const result = { id: 'r1', name: 'execute_shell', output: longOutput, success: true };
    const args = { command: 'cat /a.ts' };

    const out = await prepareToolResultForMemory({
      ...makeBasicOptions(result, args),
      modelMaxInputTokens: 200_000,
    });
    /* effectiveSoftLimit = min(12000, 200000 * 0.05) = min(12000, 10000) = 10000.
     * truncateToolOutput 用 10000 作 maxBytes 截掉 */
    expect(out.truncatedResult.length).toBeLessThanOrEqual(10500);  // 含少量元信息
  });

  it('R3: modelMaxInputTokens=32000 (GLM 32K) → softLimit clamp 到 MIN=2000', async () => {
    const longOutput = 'C'.repeat(10000);
    const result = { id: 'r1', name: 'execute_shell', output: longOutput, success: true };
    const args = { command: 'cat /a.ts' };

    const out = await prepareToolResultForMemory({
      ...makeBasicOptions(result, args),
      modelMaxInputTokens: 32_000,
    });
    /* effectiveSoftLimit = clamp(32000 * 0.05, 2000, 12000) = clamp(1600, 2000, 12000) = 2000 */
    expect(out.truncatedResult.length).toBeLessThanOrEqual(2500);
  });

  it('读类工具 (readfile) 不吃 5% 动态截断 — 账本登记的必须就是模型看到的 (2026-09-01)', async () => {
    const longOutput = 'C'.repeat(10000);
    const result = { id: 'r1', name: 'readfile', output: longOutput, success: true };

    const out = await prepareToolResultForMemory({
      ...makeBasicOptions(result, { path: '/a.ts' }),
      modelMaxInputTokens: 32_000,
    });
    /* readfile 自己按 12K 控量; 这里若再按 32K*5%=2000 砍, 模型拿到的就是中段被挖掉的文件,
     * 而 readLedger 已按全文登记 → edit 失败时被误诊成 fresh ("是你抄错了")。 */
    expect(out.truncatedResult.length).toBeGreaterThanOrEqual(10000);
  });

  it('大窗口模型读文件不再截 12K — readfile 自己按 25k token 控量 (2026-09-16)', async () => {
    const longOutput = 'E'.repeat(60000);
    const result = { id: 'r1', name: 'readfile', output: longOutput, success: true };

    const out = await prepareToolResultForMemory({
      ...makeBasicOptions(result, { path: '/a.ts' }),
      modelMaxInputTokens: 1_000_000,
    });
    expect(out.truncatedResult).toContain(longOutput);
  });

  it('大窗口下 search 仍截 12K, 小窗口下 readfile 仍截 12K', async () => {
    const longOutput = 'F'.repeat(60000);
    const search = await prepareToolResultForMemory({
      ...makeBasicOptions({ id: 'r1', name: 'search', output: longOutput, success: true }, { pattern: 'x' }),
      modelMaxInputTokens: 1_000_000,
    });
    expect(search.truncatedResult.length).toBeLessThanOrEqual(15000);

    const smallWindowRead = await prepareToolResultForMemory({
      ...makeBasicOptions({ id: 'r2', name: 'readfile', output: longOutput, success: true }, { path: '/a.ts' }),
      modelMaxInputTokens: 128_000,
    });
    expect(smallWindowRead.truncatedResult.length).toBeLessThanOrEqual(15000);
  });

  it('R3: modelMaxInputTokens=1000 极小 → clamp 到 MIN=2000 (不会截更狠)', async () => {
    const longOutput = 'D'.repeat(5000);
    const result = { id: 'r1', name: 'execute_shell', output: longOutput, success: true };

    const out = await prepareToolResultForMemory({
      ...makeBasicOptions(result, { command: 'cat /a.ts' }),
      modelMaxInputTokens: 1000,
    });
    /* 1000 * 0.05 = 50 → clamp 到 MIN=2000, 不会让 tool result 短到没用 */
    expect(out.truncatedResult.length).toBeGreaterThanOrEqual(1500);
    expect(out.truncatedResult.length).toBeLessThanOrEqual(2500);
  });

  it('streak 在 fakePolicy passthrough 下端到端工作 — truncatedResult 含 reminder 透传给 memory', async () => {
    const dedup = new ToolCallDeduplicator();
    const args = { path: '/a.ts' };

    /* 跑 3 次, 第 3 次应当出现 r1 reminder */
    let result, out;
    for (let i = 0; i < 3; i++) {
      result = { id: `r${i}`, name: 'readfile', output: `output-${i}`, success: true };
      out = await prepareToolResultForMemory({ ...makeBasicOptions(result, args), toolCallDedup: dedup });
    }

    /* tool 原始 output 应该还在前面 */
    expect(out!.truncatedResult).toMatch(/output-2/);
    /* reminder 在 output 之后 */
    expect(out!.truncatedResult).toMatch(/output-2[\s\S]*system-reminder/);
  });

  it('computer_snapshot 图片协议超过 12K 且耗时长 → 不截断、不加耗时头', async () => {
    const { IMAGE_RESULT_PREFIX, extractToolImages } = await import('../../utils/imageToolResult.js');
    const img = IMAGE_RESULT_PREFIX + JSON.stringify({
      type: 'image',
      images: [{ data: 'B'.repeat(20_000), media_type: 'image/jpeg', label: 'QQ 窗口截图' }],
    });
    const wrapped = JSON.stringify({
      type: 'contextual',
      status: 'success',
      tool: 'computer_snapshot',
      summary: '看了一眼 qq',
      content: img,
    });
    expect(wrapped.length).toBeGreaterThan(12_000);
    const out = await prepareToolResultForMemory(makeBasicOptions(
      { id: 'r1', name: 'computer_snapshot', output: wrapped, success: true, executionTime: 8500 },
      { app: 'QQ' },
    ));
    expect(out.truncatedResult).not.toContain('⏱️');
    expect(extractToolImages(out.truncatedResult)?.[0]?.data.length).toBe(20_000);
  });
});
