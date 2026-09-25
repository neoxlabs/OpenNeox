import { describe, it, expect } from 'vitest';
import { ERROR_CODES, ERROR_CODE_ALIASES, ErrorCategory } from '../errors.js';

/**
 * Go 网关发出的每一个错误码, 客户端都必须能解析到文案.
 *
 * 网关使用独立错误码词表，与 kernel 规范码可能存在命名差异：网关发 'quota.rate_limit',
 *   kernel 认的是 'quota.rate_limited'; 而 'system.busy' / 'upstream.circuit_open'
 *   在 kernel 里**根本没注册**.
 *
 *   未注册的错误码会静默降级为通用兜底文案，用户在高峰期看到的
 *   是一句看不出该怎么办的报错 —— 而这恰恰是最需要好好解释的场景, 因为高峰期
 *   人人都会遇到, 且用户没做错任何事.
 *
 *   这类词表差异不会产生编译错误或运行时异常，因此由契约测试覆盖。
 *
 * 维护: 网关新增错误码时, 在 GATEWAY_CODES 里加一行. 加不上就说明客户端会看不懂它.
 */
const GATEWAY_CODES = [
  'quota.rate_limit',
  'quota.exhausted',
  'upstream.rate_limited',
  'upstream.circuit_open',
  'system.busy',
  /* 新增: 这个模型没有能干这件事的路由 (发了图但它不吃图).
   * 跟上面几个高负载码相反, 它**必须不可重试** —— 见下面 NON_RETRYABLE_CODES。 */
  'model.capability_unsupported',
] as const;

/** 重试没有意义的 —— 判成可重试的代价是客户端对着一件永远不会成功的事一直重发 */
const NON_RETRYABLE_CODES = ['model.capability_unsupported'] as const;

/** 高负载类 —— 用户没做错任何事, 必须是"可重试", 不能被当成致命错误 */
const HIGH_LOAD_CODES = [
  'quota.rate_limit',
  'upstream.rate_limited',
  'upstream.circuit_open',
  'system.busy',
] as const;

function resolve(code: string) {
  const direct = ERROR_CODES[code];
  if (direct) return direct;
  const alias = ERROR_CODE_ALIASES[code];
  return alias ? ERROR_CODES[alias] : undefined;
}

describe('网关错误码在客户端可解析', () => {
  for (const code of GATEWAY_CODES) {
    it(`${code} 能解析到文案`, () => {
      const r = resolve(code);
      expect(
        r,
        `网关会发 ${code}, 但 kernel 既没注册也没别名 —— 客户端会落到通用兜底文案, ` +
          `而且不会有任何报错提示我们漏了.`,
      ).toBeTruthy();
      expect(r!.defaultMessage.zh.length).toBeGreaterThan(0);
      expect(r!.defaultMessage.en.length).toBeGreaterThan(0);
    });
  }

  for (const code of HIGH_LOAD_CODES) {
    it(`${code} 必须是可重试 (高负载不是用户的错)`, () => {
      const r = resolve(code)!;
      expect(
        r.retryable,
        `${code} 被标成不可重试. 高负载场景用户没做错任何事, 标成致命错误会让客户端` +
          `停止重试并显示红色报错 —— 而正确行为是等一下自动恢复.`,
      ).toBe(true);
      expect(r.category).toBe(ErrorCategory.RETRYABLE_RATE_LIMIT);
    });
  }

  for (const code of NON_RETRYABLE_CODES) {
    it(`${code} 必须是不可重试 (重试永远不会成功)`, () => {
      const r = resolve(code)!;
      expect(
        r.retryable,
        `${code} 被标成可重试. 这类错误换多少次、等多久都一样 —— 标成可重试会让客户端` +
          `对着一件永远不会成功的事一直重发 (线上见过 4 秒一次).`,
      ).toBe(false);
    });
  }
});
