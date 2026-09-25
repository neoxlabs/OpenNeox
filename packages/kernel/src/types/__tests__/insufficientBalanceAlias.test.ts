/**
 * 402 余额不足错误必须解析为带有默认文案和下一步操作的标准错误定义。
 *
 *   classifyError 把 402 归为 code='INSUFFICIENT_BALANCE'；该 code 必须在别名表中解析，
 *   于是 ERROR_CODES 查不到 def -> UI 拿不到 defaultMessage / nextAction -> 只能显示裸码。
 *   同族的 QUOTA_EXCEEDED 一直有别名, 漏的就是它。
 */
import { describe, it, expect } from 'vitest';
import { ERROR_CODES, ERROR_CODE_ALIASES, ErrorCategory } from '../errors.js';

function resolve(code: string) {
  return ERROR_CODES[code] ?? (ERROR_CODE_ALIASES[code] ? ERROR_CODES[ERROR_CODE_ALIASES[code]] : undefined);
}

describe('402 / 额度类错误码都能解析到 def', () => {
  it('INSUFFICIENT_BALANCE 能解析 (原先解析不到, 导致 UI 裸码)', () => {
    const def = resolve('INSUFFICIENT_BALANCE');
    expect(def).toBeDefined();
    expect(def!.code).toBe('quota.exhausted');
  });

  it('解析到的 def 带中文文案和 nextAction — UI 才有话可说', () => {
    const def = resolve('INSUFFICIENT_BALANCE')!;
    expect(def.defaultMessage.zh.length).toBeGreaterThan(0);
    expect(def.nextAction).toBe('topup');
    expect(def.category).toBe(ErrorCategory.FATAL_LIMIT);
    expect(def.retryable).toBe(false);
  });

  it('同族的额度码一个都不能漏', () => {
    for (const code of ['QUOTA_EXCEEDED', 'USAGE_LIMIT_REACHED', 'INSUFFICIENT_BALANCE']) {
      expect(resolve(code), `${code} 解析不到 def`).toBeDefined();
    }
  });

  it('rate_limited 不能被归进"额度用尽" — 它是等一下就好', () => {
    expect(resolve('HTTP_429')!.code).toBe('quota.rate_limited');
    expect(resolve('HTTP_429')!.retryable).toBe(true);
  });
});
