import { describe, expect, it } from 'vitest';
import { prepareToolResultForMemory } from '../runnerToolResultPreparationUtils.js';
import { RepeatedTestFailureDetector } from '../reasoning/repeatedTestFailure.js';

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

const FAIL_OUTPUT = ` FAIL  a.test.ts > math > adds
AssertionError: expected 1 to be 2`;

function options(detector: RepeatedTestFailureDetector, id: string) {
  const args = { command: 'npm test' };
  return {
    result: { id, name: 'run_tests', output: FAIL_OUTPUT, success: false },
    toolCalls: [{ id, type: 'function' as const, function: { name: 'run_tests', arguments: JSON.stringify(args) } }],
    executableToolCalls: [{ id }],
    parsedArgsByToolId: new Map([[id, { args, valid: true, raw: JSON.stringify(args) }]]),
    autoVerifyPipeline: fakeAutoVerifyPipeline,
    extractVerifyFilePath: () => undefined,
    executionPolicyOrchestrator: passthroughPolicy,
    repeatedTestFailure: detector,
  };
}

describe('VERIFY-11 接线: prepareToolResultForMemory', () => {
  it('第 1/2 次: 不 append 提醒, askUserAfterTurn 为 false', async () => {
    const detector = new RepeatedTestFailureDetector();
    const first = await prepareToolResultForMemory(options(detector, 'r1'));
    const second = await prepareToolResultForMemory(options(detector, 'r2'));
    expect(first.truncatedResult).not.toContain('ask_user');
    expect(second.truncatedResult).not.toContain('ask_user');
    expect(second.askUserAfterTurn).toBe(false);
  });

  it('第 3 次: tool result 里带 ask_user 提醒, 且 askUserAfterTurn=true', async () => {
    const detector = new RepeatedTestFailureDetector();
    await prepareToolResultForMemory(options(detector, 'r1'));
    await prepareToolResultForMemory(options(detector, 'r2'));
    const third = await prepareToolResultForMemory(options(detector, 'r3'));
    expect(third.truncatedResult).toContain('ask_user');
    expect(third.truncatedResult).toContain('同一个测试失败已经第 3 次');
    expect(third.askUserAfterTurn).toBe(true);
  });

  it('不传检测器 → 老行为完全不变', async () => {
    const out = await prepareToolResultForMemory({
      ...options(new RepeatedTestFailureDetector(), 'r1'),
      repeatedTestFailure: undefined,
    });
    expect(out.askUserAfterTurn).toBe(false);
    expect(out.truncatedResult).not.toContain('ask_user');
  });

  it('成功的测试不计数, 也不会触发停下', async () => {
    const detector = new RepeatedTestFailureDetector();
    for (let i = 0; i < 5; i++) {
      const out = await prepareToolResultForMemory({
        ...options(detector, `ok${i}`),
        result: { id: `ok${i}`, name: 'run_tests', output: 'Tests: 10 passed', success: true },
      });
      expect(out.askUserAfterTurn).toBe(false);
    }
  });
});
