import { describe, it, expect } from 'vitest';
import {
  NeoxError,
  ErrorCategory,
  classifyError,
  classifyToolError,
  isRetryableError,
  parseRetryAfter,
  parseRetryAfterFromHeaders,
  getDefaultProxyRetryDelay,
  getErrorRecoverySuggestion,
  sanitizeUpstreamErrorMessage,
} from '../errors.js';

const httpError = (status: number, data: any = {}, headers: Record<string, string> = {}) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status, data, headers },
  });

describe('classifyError — 流中断 / 重连', () => {
  it('已分类的 NeoxError 原样返回', () => {
    const e = new NeoxError({ category: ErrorCategory.RETRYABLE_STREAM, message: 'x', retryable: true, code: 'STREAM_X' });
    expect(classifyError(e)).toBe(e);
  });

  it('上游 stream_interrupted 帧 → RETRYABLE_STREAM', () => {
    const e = Object.assign(new Error('stream ended'), { isStreamError: true, code: 'upstream.stream_interrupted' });
    const out = classifyError(e);
    expect(out.category).toBe(ErrorCategory.RETRYABLE_STREAM);
    expect(out.retryable).toBe(true);
  });

  it('上游 quota.rate_limited → RATE_LIMIT 且可重试', () => {
    const e = Object.assign(new Error('rate limited'), { isStreamError: true, code: 'quota.rate_limited' });
    const out = classifyError(e);
    expect(out.category).toBe(ErrorCategory.RETRYABLE_RATE_LIMIT);
    expect(out.retryable).toBe(true);
  });

  it('上游 quota.exceeded → FATAL_LIMIT 不重试', () => {
    const e = Object.assign(new Error('quota exceeded'), { isStreamError: true, code: 'quota.exceeded' });
    const out = classifyError(e);
    expect(out.category).toBe(ErrorCategory.FATAL_LIMIT);
    expect(out.retryable).toBe(false);
  });

  it('STREAM_INCOMPLETE 错误码 → 可重试流错误', () => {
    const e = Object.assign(new Error('incomplete'), { code: 'STREAM_INCOMPLETE' });
    expect(classifyError(e).category).toBe(ErrorCategory.RETRYABLE_STREAM);
    expect(classifyError(e).code).toBe('STREAM_INCOMPLETE');
  });

  it('STREAM_TIMEOUT / STREAM_IDLE_TIMEOUT → 可重试流错误', () => {
    expect(classifyError(Object.assign(new Error('t'), { code: 'STREAM_TIMEOUT' })).code).toBe('STREAM_TIMEOUT');
    expect(classifyError(Object.assign(new Error('t'), { code: 'STREAM_IDLE_TIMEOUT' })).code).toBe('STREAM_IDLE_TIMEOUT');
  });

  it('普通“stream disconnected”消息 → STREAM_ERROR', () => {
    const out = classifyError(new Error('connection disconnected while reading stream'));
    expect(out.category).toBe(ErrorCategory.RETRYABLE_STREAM);
    expect(out.code).toBe('STREAM_ERROR');
  });

  it('EMPTY_STREAM 不重试，并带诊断建议', () => {
    const out = classifyError(Object.assign(new Error('empty SSE response'), { code: 'EMPTY_STREAM' }));
    expect(out.category).toBe(ErrorCategory.FATAL_INVALID);
    expect(out.retryable).toBe(false);
    expect(out.message).toContain('空响应');
  });

  it('EMPTY_STREAM 带 text/html 时提示检查 Base URL', () => {
    const out = classifyError(Object.assign(new Error('got text/html page'), { code: 'EMPTY_STREAM' }));
    expect(out.message).toContain('Base URL');
    expect(out.message).toContain('网页');
  });
});

describe('classifyError — HTTP 状态分类', () => {
  it('429 → 限流可重试，并读 retry-after', () => {
    const out = classifyError(httpError(429, {}, { 'retry-after': '7' }));
    expect(out.category).toBe(ErrorCategory.RETRYABLE_RATE_LIMIT);
    expect(out.retryable).toBe(true);
    expect(out.retryAfter).toBe(7000);
  });

  it('401 → FATAL_AUTH', () => {
    expect(classifyError(httpError(401, { error: { message: 'bad key' } })).category).toBe(ErrorCategory.FATAL_AUTH);
  });

  it('401 但上游说模型不支持 → MODEL_NOT_SUPPORTED（不改 key 提示）', () => {
    const out = classifyError(httpError(401, { error: { type: 'ModelError', message: 'Model grok-4.5 is not supported for format anthropic' } }));
    expect(out.category).toBe(ErrorCategory.FATAL_INVALID);
    expect(out.code).toBe('MODEL_NOT_SUPPORTED');
  });

  it('403 带 quota/balance 语义 → FATAL_LIMIT', () => {
    const out = classifyError(httpError(403, { error: { message: 'insufficient balance' } }));
    expect(out.category).toBe(ErrorCategory.FATAL_LIMIT);
    expect(out.code).toBe('QUOTA_EXCEEDED');
  });

  it('403 普通拒绝 → FATAL_AUTH', () => {
    expect(classifyError(httpError(403, { error: { message: 'forbidden' } })).category).toBe(ErrorCategory.FATAL_AUTH);
  });

  it('402 余额不足 → FATAL_LIMIT', () => {
    expect(classifyError(httpError(402, { error: { message: 'Insufficient Balance' } })).category).toBe(ErrorCategory.FATAL_LIMIT);
  });

  it('400 代理上游失败 → 可重试', () => {
    const out = classifyError(httpError(400, { error: { message: 'Upstream request failed' } }));
    expect(out.category).toBe(ErrorCategory.RETRYABLE_HTTP);
    expect(out.code).toBe('PROXY_UPSTREAM_FAILED');
  });

  it('400 其他 → FATAL_INVALID', () => {
    expect(classifyError(httpError(400, { error: { message: 'bad request' } })).category).toBe(ErrorCategory.FATAL_INVALID);
  });

  it('404 → FATAL_INVALID', () => {
    expect(classifyError(httpError(404, { error: { message: 'not found' } })).category).toBe(ErrorCategory.FATAL_INVALID);
  });

  it('502/503/504 → 代理可重试且使用更长默认间隔', () => {
    const out = classifyError(httpError(502));
    expect(out.category).toBe(ErrorCategory.RETRYABLE_RATE_LIMIT);
    expect(out.code).toBe('PROXY_502');
    expect(out.retryAfter).toBe(3000);
    expect(classifyError(httpError(503)).retryAfter).toBe(5000);
    expect(classifyError(httpError(504)).retryAfter).toBe(2000);
  });

  it('500 → 可重试 HTTP', () => {
    expect(classifyError(httpError(500)).category).toBe(ErrorCategory.RETRYABLE_HTTP);
  });
});

describe('classifyError — 网络 / 取消 / 工具超时 / 上下文', () => {
  it('ECONNRESET / EPIPE / ECONNREFUSED → RETRYABLE_NETWORK', () => {
    for (const code of ['ECONNRESET', 'EPIPE', 'ECONNREFUSED', 'ENOTFOUND']) {
      const out = classifyError(Object.assign(new Error('net'), { isAxiosError: true, code }));
      expect(out.category, code).toBe(ErrorCategory.RETRYABLE_NETWORK);
      expect(out.retryable, code).toBe(true);
    }
  });

  it('ETIMEDOUT / ECONNABORTED → TIMEOUT 可重试', () => {
    const out = classifyError(Object.assign(new Error('timeout'), { isAxiosError: true, code: 'ETIMEDOUT' }));
    expect(out.code).toBe('TIMEOUT');
    expect(out.category).toBe(ErrorCategory.RETRYABLE_NETWORK);
  });

  it('取消错误 → CANCELED 不重试', () => {
    const out = classifyError(Object.assign(new Error('canceled'), { name: 'AbortError' }));
    expect(out.category).toBe(ErrorCategory.CANCELED);
    expect(out.retryable).toBe(false);
  });

  it('tool_timeout → TOOL_TIMEOUT 可重试', () => {
    const out = classifyError(Object.assign(new Error('tool slow'), { code: 'tool_timeout' }));
    expect(out.category).toBe(ErrorCategory.TOOL_TIMEOUT);
    expect(out.retryable).toBe(true);
  });

  it('上下文超限消息优先于 stream 关键词', () => {
    const out = classifyError(new Error('context length exceeded while streaming'));
    expect(out.category).toBe(ErrorCategory.FATAL_CONTEXT);
    expect(out.retryable).toBe(false);
  });

  it('“不支持 stream” → STREAMING_UNSUPPORTED 不重试', () => {
    const out = classifyError(new Error('this provider does not support streaming'));
    expect(out.category).toBe(ErrorCategory.FATAL_INVALID);
    expect(out.code).toBe('STREAMING_UNSUPPORTED');
  });

  it('完全未知的错误 → INTERNAL / UNKNOWN', () => {
    const out = classifyError(new Error('something odd'));
    expect(out.category).toBe(ErrorCategory.INTERNAL);
    expect(out.code).toBe('UNKNOWN');
    expect(out.retryable).toBe(false);
  });
});

describe('parseRetryAfter', () => {
  it('纯秒数与小数秒', () => {
    expect(parseRetryAfter('5')).toBe(5000);
    expect(parseRetryAfter('2.5')).toBe(2500);
  });

  it('毫秒写法', () => {
    expect(parseRetryAfter('1500ms')).toBe(1500);
    expect(parseRetryAfter(' 1200 MS ')).toBe(1200);
  });

  it('HTTP-date（未来）', () => {
    const future = new Date(Date.now() + 10_000).toUTCString();
    const parsed = parseRetryAfter(future)!;
    expect(parsed).toBeGreaterThan(8000);
    expect(parsed).toBeLessThanOrEqual(10_000);
  });

  it('无效 / 空 / 负数 / 过去时间 → undefined', () => {
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter('0')).toBeUndefined();
    expect(parseRetryAfter('-3')).toBeUndefined();
    expect(parseRetryAfter('not-a-date')).toBeUndefined();
    expect(parseRetryAfter(new Date(Date.now() - 1000).toUTCString())).toBeUndefined();
  });
});

describe('parseRetryAfterFromHeaders', () => {
  it('标准头与非标准毫秒头', () => {
    expect(parseRetryAfterFromHeaders({ 'retry-after': '4' })).toBe(4000);
    expect(parseRetryAfterFromHeaders({ 'Retry-After': '4' })).toBe(4000);
    expect(parseRetryAfterFromHeaders({ 'retry-after-ms': '250' })).toBe(250);
  });

  it('x-ratelimit-reset-requests 与 Anthropic 专用头', () => {
    expect(parseRetryAfterFromHeaders({ 'x-ratelimit-reset-requests': '3' })).toBe(3000);
    const reset = new Date(Date.now() + 5000).toISOString();
    const out = parseRetryAfterFromHeaders({ 'anthropic-ratelimit-requests-reset': reset })!;
    expect(out).toBeGreaterThan(3000);
  });

  it('没有头 / 无效头 → undefined', () => {
    expect(parseRetryAfterFromHeaders(undefined)).toBeUndefined();
    expect(parseRetryAfterFromHeaders({})).toBeUndefined();
    expect(parseRetryAfterFromHeaders({ 'retry-after': 'nope' })).toBeUndefined();
  });

  it('代理状态默认延迟', () => {
    expect(getDefaultProxyRetryDelay(502)).toBe(3000);
    expect(getDefaultProxyRetryDelay(503)).toBe(5000);
    expect(getDefaultProxyRetryDelay(504)).toBe(2000);
    expect(getDefaultProxyRetryDelay(500)).toBe(2000);
  });
});

describe('classifyToolError', () => {
  it('参数未闭合 → TOOL_TRUNCATED，不可重试', () => {
    const out = classifyToolError('readfile', '{"path":"a"', new Error('stream cut'));
    expect(out.category).toBe(ErrorCategory.TOOL_TRUNCATED);
    expect(out.code).toBe('TOOL_ARGS_TRUNCATED');
    expect(out.retryable).toBe(false);
  });

  it('write_file 缺 content → TOOL_MISSING_CONTENT', () => {
    const out = classifyToolError('write_file', '{"file_path":"a"}', new Error('missing'));
    expect(out.code).toBe('TOOL_MISSING_CONTENT');
    expect(out.retryable).toBe(false);
  });

  it('edit 缺 old/new 对 → TOOL_MISSING_EDIT_PAYLOAD', () => {
    const out = classifyToolError('edit', '{"file_path":"a"}', new Error('missing'));
    expect(out.code).toBe('TOOL_MISSING_EDIT_PAYLOAD');
    expect(out.retryable).toBe(false);
  });

  it('edit 带 insert_after + new_string 时不算缺失', () => {
    const out = classifyToolError('edit', '{"file_path":"a","insert_after":"x","new_string":"y"}', new Error('some failure'));
    expect(out.code).not.toBe('TOOL_MISSING_EDIT_PAYLOAD');
  });

  it('JSON 解析失败 → TOOL_JSON_INVALID，可重试', () => {
    const out = classifyToolError('x', '{}', new Error('Unexpected token in JSON'));
    expect(out.category).toBe(ErrorCategory.TOOL_JSON_INVALID);
    expect(out.code).toBe('JSON_PARSE_ERROR');
    expect(out.retryable).toBe(true);
  });

  it('其他工具错误 → TOOL_JSON_INVALID / TOOL_ERROR', () => {
    const out = classifyToolError('x', '{}', new Error('boom'));
    expect(out.code).toBe('TOOL_ERROR');
    expect(out.context?.toolName).toBe('x');
  });
});

describe('辅助函数', () => {
  it('isRetryableError 读 category / retryable', () => {
    expect(isRetryableError(new NeoxError({ category: ErrorCategory.RETRYABLE_HTTP, message: 'x', retryable: true }))).toBe(true);
    expect(isRetryableError(new NeoxError({ category: ErrorCategory.FATAL_AUTH, message: 'x', retryable: false }))).toBe(false);
    expect(isRetryableError(new Error('x'))).toBe(false);
  });

  it('重试耗尽与否给出不同建议', () => {
    const fresh = getErrorRecoverySuggestion(new NeoxError({ category: ErrorCategory.RETRYABLE_STREAM, message: 'x' }));
    const exhausted = getErrorRecoverySuggestion(new NeoxError({ category: ErrorCategory.RETRYABLE_STREAM, message: 'x' }), { exhausted: true });
    expect(fresh).not.toBe(exhausted);
    expect(fresh.length).toBeGreaterThan(0);
    expect(exhausted.length).toBeGreaterThan(0);
  });

  it('各不可重试类别都有非空建议', () => {
    for (const category of [ErrorCategory.FATAL_AUTH, ErrorCategory.FATAL_LIMIT, ErrorCategory.FATAL_CONTEXT, ErrorCategory.FATAL_INVALID]) {
      expect(getErrorRecoverySuggestion(new NeoxError({ category, message: 'x' })).length).toBeGreaterThan(0);
    }
  });

  it('清洗上游错误里的 HTML 与多余空白', () => {
    const raw = '<html><body><h1>Error</h1><p>bad   request</p></body></html>';
    const out = sanitizeUpstreamErrorMessage(raw);
    expect(out).not.toContain('<html>');
    expect(out).not.toContain('<body>');
    expect(out.length).toBeGreaterThan(0);
  });
});
