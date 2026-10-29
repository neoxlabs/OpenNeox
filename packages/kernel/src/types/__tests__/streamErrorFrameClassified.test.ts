import { describe, it, expect } from 'vitest';
import { classifyError, ErrorCategory } from '../errors.js';

/* openai.ts 解析 SSE 错误帧后抛出的形状 */
const frame = (code: string) => Object.assign(new Error('上游服务暂时不可用'), { code, retryable: false, isStreamError: true });

describe('流中途的网关错误帧', () => {
  it('upstream.* → 流中断, 可重试 (原来落到 INTERNAL, 长任务直接退出)', () => {
    const e = classifyError(frame('upstream.stream_interrupted'));
    expect(e.category).toBe(ErrorCategory.RETRYABLE_STREAM);
    expect(e.retryable).toBe(true);
  });
  it('quota.* / auth.* 仍是终态', () => {
    expect(classifyError(frame('quota.exceeded')).category).toBe(ErrorCategory.FATAL_LIMIT);
    expect(classifyError(frame('auth.invalid_key')).category).toBe(ErrorCategory.FATAL_AUTH);
  });
});
