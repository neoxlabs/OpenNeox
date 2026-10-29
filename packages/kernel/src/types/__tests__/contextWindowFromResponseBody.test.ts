/*
 * HTTP 400 响应体里的「上下文超长」必须落成 FATAL_CONTEXT
 *
 * 曾经的 bug: 400 分支拿 error.message ("Request failed with status code 400")
 * 去匹配上下文超长, 而真正的原因在 response.data 里 —— 于是模型上下文满了却报
 * fatal_invalid, 上层不做压缩/截断直接失败。
 */
import { describe, expect, it } from 'vitest';
import { classifyError, ErrorCategory } from '../errors.js';

function http400(data: unknown): Error {
  const err = new Error('Request failed with status code 400') as Error & {
    isAxiosError?: boolean;
    response?: unknown;
  };
  err.isAxiosError = true;
  err.response = { status: 400, data };
  return err;
}

describe('400 响应体里的上下文超长信息参与分类', () => {
  it('DeepSeek / [OI] 风格: maximum context length + context_length_exceeded', () => {
    const error = classifyError(
      http400({
        error: {
          message:
            "This model's maximum context length is 65536 tokens. However, you requested 70000 tokens (70000 in the messages).",
          type: 'invalid_request_error',
          code: 'context_length_exceeded',
        },
      })
    );
    expect(error.code).toBe('CONTEXT_WINDOW_EXCEEDED');
    expect(error.category).toBe(ErrorCategory.FATAL_CONTEXT);
    expect(error.retryable).toBe(false);
  });

  it('Anthropic 风格: prompt is too long', () => {
    const error = classifyError(
      http400({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'prompt is too long: 210000 tokens > 200000 maximum' },
      })
    );
    expect(error.code).toBe('CONTEXT_WINDOW_EXCEEDED');
  });

  it('中文 body: 上下文超长', () => {
    const error = classifyError(
      http400({ error: { message: '上下文超长: 本次请求 70000 tokens, 超过模型上限 65536 tokens' } })
    );
    expect(error.code).toBe('CONTEXT_WINDOW_EXCEEDED');
  });

  it('普通 400 不被误判', () => {
    const error = classifyError(
      http400({ error: { message: 'Invalid value for temperature', type: 'invalid_request_error' } })
    );
    expect(error.category).toBe(ErrorCategory.FATAL_INVALID);
  });
});
