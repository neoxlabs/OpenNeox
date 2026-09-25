import { describe, it, expect } from 'vitest';
import { classifyError, ErrorCategory } from '../errors.js';

const axiosLike = (status: number, data: unknown) => Object.assign(new Error(`Request failed with status code ${status}`), {
  isAxiosError: true,
  code: 'ERR_BAD_RESPONSE',
  response: { status, data, headers: {} },
});

describe('中转站没配通道 → 模型不可用, 不重试', () => {
  it('503 + code=model_not_found', () => {
    const e = classifyError(axiosLike(503, {
      error: {
        code: 'model_not_found',
        message: 'No available channel for model glm-5.2 under group grok heavy (distributor) (request id: 20260922)',
        type: 'new_api_error',
      },
    }));
    expect(e.code).toBe('MODEL_NOT_SUPPORTED');
    expect(e.category).toBe(ErrorCategory.FATAL_INVALID);
    expect(e.retryable).toBe(false);
    expect(e.message).toContain('No available channel');
  });

  it('只有原话、没有 code 的老版本 one-api 也认', () => {
    const e = classifyError(axiosLike(502, { error: { message: 'No available channels for model grok-4.5 under group default' } }));
    expect(e.code).toBe('MODEL_NOT_SUPPORTED');
    expect(e.retryable).toBe(false);
  });

  it('普通 503 (过载) 照旧按代理限流重试', () => {
    const e = classifyError(axiosLike(503, { error: { message: 'Service temporarily unavailable' } }));
    expect(e.code).toBe('PROXY_503');
    expect(e.category).toBe(ErrorCategory.RETRYABLE_RATE_LIMIT);
    expect(e.retryable).toBe(true);
  });
});
