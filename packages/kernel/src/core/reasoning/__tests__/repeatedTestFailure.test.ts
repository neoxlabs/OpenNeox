/**
 * VERIFY-11 — 同一测试失败第 3 次就停下问
 */
import { describe, expect, it } from 'vitest';
import {
  RepeatedTestFailureDetector,
  REPEATED_TEST_FAILURE_THRESHOLD,
  computeFailureSignature,
  isTestFailure,
  normalizeFailureLine,
} from '../repeatedTestFailure.js';
import {
  beginWrapUp,
  dropWrapUpToolCalls,
  markAskUserWrapUp,
  WRAP_UP_AFTER_BLOCK_REMINDER,
  WRAP_UP_ASK_USER_ALLOWED,
  WRAP_UP_ASK_USER_REMINDER,
} from '../../runnerWrapUp.js';

const VITEST_FAIL = `
 FAIL  packages/core/src/a.test.ts > math > adds
AssertionError: expected 1 to be 2 // Object.is equality

- Expected
+ Received

- 2
+ 1

 ❯ packages/core/src/a.test.ts:12:9
`;

describe('VERIFY-11 测试失败签名', () => {
  it('同一错误换行号/耗时/路径 → 同一签名', () => {
    const a = computeFailureSignature(VITEST_FAIL);
    const b = computeFailureSignature(VITEST_FAIL.replace('a.test.ts:12:9', 'a.test.ts:88:3').replace(' FAIL ', ' FAIL '));
    expect(a).toBe(b);
  });

  it('不同断言 → 不同签名', () => {
    const a = computeFailureSignature(VITEST_FAIL);
    const b = computeFailureSignature(VITEST_FAIL.replace('expected 1 to be 2', 'expected "x" to equal "y"'));
    expect(a).not.toBe(b);
  });

  it('pytest / go / cargo 的失败行都能被抽到', () => {
    const pytest = 'FAILED tests/test_a.py::test_math - assert 1 == 2';
    const go = '--- FAIL: TestMath (0.00s)';
    const cargo = 'test math::adds ... FAILED';
    expect(computeFailureSignature(pytest)).not.toBe(computeFailureSignature(go));
    expect(computeFailureSignature(go)).toBe(computeFailureSignature('--- FAIL: TestMath (1.23s)'));
    expect(computeFailureSignature(cargo)).toBe(computeFailureSignature('test math::adds ... FAILED'));
  });

  it('归一化抹掉行号/耗时/地址', () => {
    expect(normalizeFailureLine('at /Users/a/b/c.ts:12:3 (1.2s)')).toBe('at <path>');
    expect(normalizeFailureLine('heap at 0xdeadbeef')).toBe('heap at <addr>');
  });

  it('只认测试类失败', () => {
    expect(isTestFailure('run_tests', undefined, false, 'x')).toBe(true);
    expect(isTestFailure('run_tests', undefined, true, 'x')).toBe(false);
    expect(isTestFailure('execute_shell', 'npm test', false, 'FAIL a')).toBe(true);
    expect(isTestFailure('execute_shell', 'pytest -q', false, 'FAILED a')).toBe(true);
    /* 普通命令失败不算测试失败 */
    expect(isTestFailure('execute_shell', 'npm run build', false, 'error TS2322')).toBe(false);
    expect(isTestFailure('readfile', 'npm test', false, 'FAIL a')).toBe(false);
  });
});

describe('VERIFY-11 第 3 次停下问', () => {
  it('前两次不提醒, 第 3 次提醒并要求问用户', () => {
    const d = new RepeatedTestFailureDetector();
    expect(REPEATED_TEST_FAILURE_THRESHOLD).toBe(3);

    const r1 = d.record({ toolName: 'run_tests', success: false, output: VITEST_FAIL });
    const r2 = d.record({ toolName: 'run_tests', success: false, output: VITEST_FAIL });
    expect(r1?.shouldAskUser).toBe(false);
    expect(r2?.shouldAskUser).toBe(false);
    expect(r2?.reminder).toBeNull();

    const r3 = d.record({ toolName: 'run_tests', success: false, output: VITEST_FAIL });
    expect(r3?.shouldAskUser).toBe(true);
    expect(r3?.streak).toBe(3);
    expect(r3?.reminder).toContain('ask_user');
  });

  it('成功一次不清零 —— 后面又出现同一个错仍是第 3 次', () => {
    const d = new RepeatedTestFailureDetector();
    d.record({ toolName: 'run_tests', success: false, output: VITEST_FAIL });
    d.record({ toolName: 'run_tests', success: false, output: VITEST_FAIL });
    expect(d.record({ toolName: 'run_tests', success: true, output: 'ok' })).toBeNull();
    const third = d.record({ toolName: 'run_tests', success: false, output: VITEST_FAIL });
    expect(third?.shouldAskUser).toBe(true);
  });

  it('换了一个错误重新从 1 数', () => {
    const d = new RepeatedTestFailureDetector();
    d.record({ toolName: 'run_tests', success: false, output: VITEST_FAIL });
    d.record({ toolName: 'run_tests', success: false, output: VITEST_FAIL });
    const other = d.record({
      toolName: 'run_tests',
      success: false,
      output: 'FAIL b.test.ts > other > case\nAssertionError: expected 3 to be 4',
    });
    expect(other?.streak).toBe(1);
    expect(other?.shouldAskUser).toBe(false);
  });

  it('非测试失败不计数', () => {
    const d = new RepeatedTestFailureDetector();
    expect(d.record({ toolName: 'execute_shell', command: 'npm run build', success: false, output: 'error TS1' })).toBeNull();
    expect(d.record({ toolName: 'edit', success: false, output: VITEST_FAIL })).toBeNull();
  });

  it('reset 清空计数 (每次 run 独立)', () => {
    const d = new RepeatedTestFailureDetector();
    d.record({ toolName: 'run_tests', success: false, output: VITEST_FAIL });
    d.record({ toolName: 'run_tests', success: false, output: VITEST_FAIL });
    d.reset();
    expect(d.record({ toolName: 'run_tests', success: false, output: VITEST_FAIL })?.streak).toBe(1);
  });
});

describe('VERIFY-11 收尾轮放行 ask_user', () => {
  const calls = () => [
    { id: 'a', function: { name: 'ask_user' } },
    { id: 'b', function: { name: 'run_tests' } },
  ];

  it('默认收尾轮丢弃全部工具调用 (老行为不变)', () => {
    const tc = calls();
    dropWrapUpToolCalls(true, tc);
    expect(tc).toHaveLength(0);
  });

  it('放行 ask_user, 其它仍然丢弃', () => {
    const tc = calls();
    dropWrapUpToolCalls(true, tc, WRAP_UP_ASK_USER_ALLOWED);
    expect(tc.map((c) => c.function.name)).toEqual(['ask_user']);
  });

  it('非收尾轮不动工具调用', () => {
    const tc = calls();
    dropWrapUpToolCalls(false, tc, WRAP_UP_ASK_USER_ALLOWED);
    expect(tc).toHaveLength(2);
  });
});

describe('VERIFY-11 收尾轮: flag 决定文案与放行名单', () => {
  function fakeMemory() {
    const reminders: string[] = [];
    return { reminders, appendReminder: (t: string) => reminders.push(t) };
  }

  it('markAskUserWrapUp 后: 用问用户文案, 且自动放行 ask_user', () => {
    const mem = fakeMemory();
    markAskUserWrapUp();
    beginWrapUp(mem);
    expect(mem.reminders[0]).toBe(WRAP_UP_ASK_USER_REMINDER);

    const tc = [{ function: { name: 'ask_user' } }, { function: { name: 'run_tests' } }];
    dropWrapUpToolCalls(true, tc);
    expect(tc.map((c) => c.function.name)).toEqual(['ask_user']);
  });

  it('没有标记时: 老行为 (工具被拦文案 + 全部丢弃)', () => {
    const mem = fakeMemory();
    beginWrapUp(mem);   // 先消费掉上一次的 flag
    const mem2 = fakeMemory();
    beginWrapUp(mem2);
    expect(mem2.reminders[0]).toBe(WRAP_UP_AFTER_BLOCK_REMINDER);

    const tc = [{ function: { name: 'ask_user' } }];
    dropWrapUpToolCalls(true, tc);
    expect(tc).toHaveLength(0);
  });

  it('flag 是一次性的 —— 下一次普通收尾回到老行为', () => {
    markAskUserWrapUp();
    beginWrapUp(fakeMemory());
    const mem = fakeMemory();
    beginWrapUp(mem);
    expect(mem.reminders[0]).toBe(WRAP_UP_AFTER_BLOCK_REMINDER);
  });
});
