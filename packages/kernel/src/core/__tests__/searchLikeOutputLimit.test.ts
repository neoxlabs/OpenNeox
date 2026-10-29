import { describe, expect, it } from 'vitest';
import { prepareToolResultForMemory } from '../runnerToolResultPreparationUtils.js';

/**
 * search / show_tree 的输出上限按模型窗口给 (LOOP-01), 内核不再统一 12K 中段挖空。
 */

const passthroughPolicy = {
  applyToolResultPolicy: async (input: { result: any; toolCalls: any[]; truncatedResult: string }) => ({
    truncatedResult: input.truncatedResult,
    toolInput: {},
    shouldBreak: false,
    encounteredError: false,
  }),
};

function options(output: string, name: string, modelMaxInputTokens?: number) {
  return {
    result: { id: 'r1', name, output, success: true },
    toolCalls: [{ id: 'r1', type: 'function' as const, function: { name, arguments: '{}' } }],
    executableToolCalls: [{ id: 'r1' }],
    parsedArgsByToolId: new Map(),
    autoVerifyPipeline: {
      shouldVerify: () => false,
      verify: async () => null,
      formatToolResult: () => undefined,
    },
    extractVerifyFilePath: () => undefined,
    executionPolicyOrchestrator: passthroughPolicy,
    modelMaxInputTokens,
  };
}

const body = (lines: number) => Array.from({ length: lines }, (_, i) => `line ${i} ${'x'.repeat(60)}`).join('\n');

describe('search / show_tree 的内核截断上限', () => {
  it('1M 窗口: 30K 字符的 search 结果原样保留 (改动前会被挖到 12K)', async () => {
    const output = body(400); // ≈ 28K 字符
    expect(output.length).toBeGreaterThan(12_000);
    expect(output.length).toBeLessThan(60_000);
    const out = await prepareToolResultForMemory(options(output, 'search', 1_000_000));
    expect(out.truncatedResult.length).toBeGreaterThan(12_000);
    expect(out.truncatedResult).not.toContain('已截断');
  });

  it('32K 窗口: 保底 12K × 1.2 的失控上限仍然生效', async () => {
    const output = body(400);
    const out = await prepareToolResultForMemory(options(output, 'search', 32_000));
    expect(out.truncatedResult.length).toBeLessThanOrEqual(14_400 + 200);
  });

  it('show_tree 同样按窗口: 1M 窗口不截', async () => {
    const output = body(400);
    const out = await prepareToolResultForMemory(options(output, 'show_tree', 1_000_000));
    expect(out.truncatedResult.length).toBeGreaterThan(12_000);
    expect(out.truncatedResult).not.toContain('已截断');
  });

  it('list_directory 不受影响: 仍按 12K 截', async () => {
    const output = body(400);
    const out = await prepareToolResultForMemory(options(output, 'list_directory', 1_000_000));
    expect(out.truncatedResult.length).toBeLessThanOrEqual(12_000 + 200);
  });
});
