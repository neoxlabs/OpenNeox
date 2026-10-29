/**
 * 代理 5xx 重试耗尽后必须给出区分于真实限流的建议。
 *
 *   502/503/504 被有意归进 RETRYABLE_RATE_LIMIT (中转站限流恢复慢, 要更长退避) ——
 *   分类本身可辩护, 但这一档里混着两种完全不同的处境:
 *     · 真 429           code=HTTP_429 —— 确实是限流, "等一等"对
 *     · 代理 5xx         code=PROXY_5xx —— 可能过载, 也可能**根本没配通道**
 *
 *   上游可能返回 "No available channel for model X under group ..."，此时应
 *   「被上游限流, 稍等片刻再试」—— 说错原因, 也给错动作: 通道没配, 等到天亮也不会好。
 */
import { describe, it, expect } from 'vitest';
import { NeoxError, ErrorCategory, getErrorRecoverySuggestion } from '../errors.js';

const mk = (code: string) => new NeoxError({
  category: ErrorCategory.RETRYABLE_RATE_LIMIT,
  code,
  message: 'No available channel for model gpt-5.4-mini under group grok heavy (distributor)',
  retryable: true,
});

describe('重试耗尽后的建议要分清"等"和"换"', () => {
  for (const code of ['PROXY_502', 'PROXY_503', 'PROXY_504']) {
    it(`${code} 不得断言"被上游限流"`, () => {
      const s = getErrorRecoverySuggestion(mk(code), { exhausted: true });
      expect(s).not.toContain('被上游限流');
      expect(s).not.toContain('稍等片刻再试');
    });

    it(`${code} 要给"换模型/服务商"这个可执行动作`, () => {
      const s = getErrorRecoverySuggestion(mk(code), { exhausted: true });
      expect(s).toMatch(/换个模型|服务商/);
    });
  }

  it('真 429 保持原文案, 不回归 —— 它确实该等', () => {
    const s = getErrorRecoverySuggestion(mk('HTTP_429'), { exhausted: true });
    expect(s).toContain('被上游限流');
  });

  it('还没耗尽时仍说"自动重试", 不受影响', () => {
    const s = getErrorRecoverySuggestion(mk('PROXY_503'));
    expect(s).toMatch(/重试/);
    expect(s).not.toContain('重试已用尽');
  });

  it('不回显上游原话 —— 调用方已经原样打过一行了, 再抄一遍会把 request-id 截半截', () => {
    const s = getErrorRecoverySuggestion(mk('PROXY_503'), { exhausted: true });
    expect(s).not.toContain('No available channel');
  });
});
