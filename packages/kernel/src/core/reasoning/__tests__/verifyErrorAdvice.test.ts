/**
 * VERIFY-06: 验证失败的最小修复建议 + 同错重复计数。
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_SAME_ERROR_RERUNS,
  RepeatErrorTracker,
  buildMinimalFixAdvice,
  parseFirstVerifyError,
  repeatWarning,
  verifyErrorSignature,
} from '../verifyErrorAdvice.js';

describe('parseFirstVerifyError', () => {
  it('解析 tsc --pretty false 的 file(line,col): error TSxxxx', () => {
    const out = [
      'some noise line',
      "src/app.ts(12,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      "src/app.ts(20,3): error TS2339: Property 'foo' does not exist on type 'Bar'.",
    ].join('\n');
    const err = parseFirstVerifyError(out);
    expect(err).toEqual({
      file: 'src/app.ts',
      line: 12,
      column: 7,
      code: 'TS2322',
      message: "Type 'string' is not assignable to type 'number'.",
    });
  });

  it('解析 go vet 的 file:line:col 格式', () => {
    const err = parseFirstVerifyError('./main.go:7:2: undefined: foo');
    expect(err?.file).toBe('./main.go');
    expect(err?.line).toBe(7);
    expect(err?.message).toContain('undefined');
  });

  it('解析 Python 的 File "x.py", line N + SyntaxError', () => {
    const out = [
      'Traceback (most recent call last):',
      '  File "src/a.py", line 3',
      '    def broken(:',
      'SyntaxError: invalid syntax',
    ].join('\n');
    const err = parseFirstVerifyError(out);
    expect(err?.file).toBe('src/a.py');
    expect(err?.line).toBe(3);
    expect(err?.code).toBe('SyntaxError');
  });

  it('没有可定位的行 → null (调用方保留原文, 不乱猜)', () => {
    expect(parseFirstVerifyError('npm ERR! code ELIFECYCLE\n(nothing here)')).toBeNull();
  });
});

describe('buildMinimalFixAdvice', () => {
  it('TS2322 → 指向具体行 + 类型不对', () => {
    const err = parseFirstVerifyError("src/a.ts(12,7): error TS2322: Type 'string' is not assignable to type 'number'.")!;
    const advice = buildMinimalFixAdvice(err);
    expect(advice).toContain('第 12 行');
    expect(advice).toContain('第 7 列');
    expect(advice).toContain('类型对不上');
  });

  it('TS2304 → 点名找不到的标识符', () => {
    const err = parseFirstVerifyError("src/a.ts(5,1): error TS2304: Cannot find name 'foo'.")!;
    expect(buildMinimalFixAdvice(err)).toContain('`foo`');
  });

  it('TS2339 → 点名属性与类型', () => {
    const err = parseFirstVerifyError("src/a.ts(9,2): error TS2339: Property 'bar' does not exist on type 'Baz'.")!;
    const advice = buildMinimalFixAdvice(err);
    expect(advice).toContain('`Baz`');
    expect(advice).toContain('`bar`');
  });

  it('未知错误码 → 通用建议, 不编造原因', () => {
    const err = parseFirstVerifyError('src/a.ts(2,1): error TS9999: something weird')!;
    const advice = buildMinimalFixAdvice(err);
    expect(advice).toContain('第 2 行');
    expect(advice).toContain('something weird');
  });
});

describe('同错重复计数', () => {
  it('同一签名累加, 超过上限才劝停', () => {
    const tracker = new RepeatErrorTracker();
    const sig = verifyErrorSignature("src/a.ts(3,1): error TS2322: Type 'x' is not assignable to type 'y'.");
    expect(tracker.record(sig)).toBe(1);
    expect(tracker.record(sig)).toBe(2);
    expect(repeatWarning(2)).toBe('');
    expect(tracker.record(sig)).toBe(3);
    expect(tracker.record(sig)).toBe(MAX_SAME_ERROR_RERUNS + 2);
    expect(repeatWarning(3)).toContain('别再重跑');
  });

  it('行号变了就是新签名 (改到别处了, 重新计数)', () => {
    const tracker = new RepeatErrorTracker();
    tracker.record(verifyErrorSignature("src/a.ts(3,1): error TS2322: Type 'x' is not assignable to type 'y'."));
    const moved = tracker.record(verifyErrorSignature("src/a.ts(8,1): error TS2322: Type 'x' is not assignable to type 'y'."));
    expect(moved).toBe(1);
  });

  it('reset 清空', () => {
    const tracker = new RepeatErrorTracker();
    const sig = 'TS1:1:x';
    tracker.record(sig);
    tracker.reset();
    expect(tracker.record(sig)).toBe(1);
  });
});
