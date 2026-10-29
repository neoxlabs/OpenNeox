/**
 * work:H-18 · 失败重试口径在 Work 复核 —— 额度不足 / 鉴权失败 / 400 不许自动重试。
 *
 * 之前的事故形状: 网关回「Insufficient Balance」, core 的 classifyError 因为消息里含 quota
 * 把 429 那条分支抢走, 判成 rate_limit → withLLMRetry/进程重试反复重试, 用户等半天只拿到报错。
 *
 * 这里把四类**不可重试**（额度 / 鉴权 / 400 / 上下文超限）和三类**可重试**（429 限流 / 5xx / 网络）
 * 从各种真实形态各过一遍，并验证 Work 与 Code 走的是同一份判定（core 的判定就是 kernel 的判定，
 * 不存在第二套口径）。
 */
import { describe, it, expect } from 'vitest';
import { ErrorCategory as KernelErrorCategory, NeoxError, classifyError as classifyKernelError } from '@neoxlabs/kernel/types/errors.js';
import {
  classifyError,
  isRetryable,
  shouldRetryProcess,
  withLLMRetry,
  DEFAULT_RESILIENCE_CONFIG,
  type ErrorCategory,
} from '../../runtime/resilience/agentResiliencePolicy.js';
import { buildGracefulReply, buildWorkerFailureNotice } from '../../runtime/resilience/gracefulErrorResponder.js';

/** axios 形状的 HTTP 错误（上游真回的状态码） */
function httpError(status: number, data: any, message = `Request failed with status code ${status}`): Error {
  const err = new Error(message) as Error & { response?: any };
  err.response = { status, data, headers: {} };
  return err;
}

const NEVER_RETRY: Array<[string, Error]> = [
  ['402 余额不足 (axios)', httpError(402, { error: { message: 'Insufficient Balance' } })],
  [
    '403 带 insufficient_quota',
    httpError(403, { error: { message: 'You exceeded your current quota, please check your plan and billing details', type: 'insufficient_quota' } }),
  ],
  ['429 usage_limit_reached (套餐额度用完)', httpError(429, { error: { type: 'usage_limit_reached', message: 'Usage limit reached' } })],
  ['401 鉴权失败', httpError(401, { error: { message: 'Invalid API key' } })],
  ['403 无权限', httpError(403, { error: { message: 'Forbidden' } })],
  ['400 参数错', httpError(400, { error: { message: 'messages[0].content must be a string' } })],
  ['400 模型不支持', httpError(400, { error: { message: 'Model grok-4.5 is not supported for format anthropic' } })],
  /* 纯文本形态（后台进程只回传 lastError 字符串）—— 这是最容易被兜底吃掉的一类 */
  ['纯文本: 余额不足', new Error('Error 402: Insufficient Balance')],
  ['纯文本: 额度用完', new Error('You exceeded your current quota for this billing period')],
  ['纯文本: 401', new Error('401 Unauthorized')],
  ['纯文本: 400', new Error('400 Bad Request: invalid model parameter')],
  ['纯文本: 上下文超限', new Error('This model\'s maximum context length is 128000 tokens')],
];

const ALWAYS_RETRY: Array<[string, Error]> = [
  ['429 普通限流', httpError(429, { error: { message: 'Rate limit exceeded' } })],
  ['503 网关过载', httpError(503, { error: { message: 'Service temporarily unavailable' } })],
  ['500 服务端错误', httpError(500, { error: { message: 'Internal Server Error' } })],
  ['纯文本: 500', new Error('500 Internal Server Error')],
  ['纯文本: 429', new Error('429 Too Many Requests')],
  ['网络: ECONNRESET', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })],
];

describe('work:H-18 失败重试口径', () => {
  describe.each(NEVER_RETRY)('%s', (_label, err) => {
    it('归类为不可重试类别', () => {
      const category = classifyError(err);
      expect(isRetryable(category)).toBe(false);
    });

    it('withLLMRetry 只尝试一次就结束', async () => {
      const calls: number[] = [];
      const result = await withLLMRetry(
        async () => { calls.push(1); throw err; },
        { ...DEFAULT_RESILIENCE_CONFIG, initialBackoffMs: 1, maxBackoffMs: 2 },
      );
      expect(result.success).toBe(false);
      expect(result.attempts).toBe(1);
      expect(calls).toHaveLength(1);
    });

    it('进程级重试也不重试', () => {
      /* 上下文超限是特例: 进程级重试**带着压缩**再试一次, 这是既定设计 (见
       * shouldRetryProcess 的 token_limit 分支), 不属于「原样重试」。 */
      const category = classifyError(err);
      if (category === 'token_limit') return;
      const ctx = {
        pid: 'p1', task: '周报', role: 'worker', attempt: 0, maxAttempts: 3, lastError: err.message,
        /* 调用方手里有分类结果时直给, 不靠文本重猜 */
        errorCategory: category,
      };
      expect(shouldRetryProcess(ctx).shouldRetry).toBe(false);
    });
  });

  describe.each(ALWAYS_RETRY)('%s', (_label, err) => {
    it('仍然可重试', () => {
      expect(isRetryable(classifyError(err))).toBe(true);
    });

    it('withLLMRetry 会在失败后继续尝试', async () => {
      let attempts = 0;
      const result = await withLLMRetry(
        async () => {
          attempts += 1;
          if (attempts < 2) throw err;
          return 'ok';
        },
        { ...DEFAULT_RESILIENCE_CONFIG, initialBackoffMs: 1, maxBackoffMs: 2 },
      );
      expect(result.success).toBe(true);
      expect(result.attempts).toBe(2);
    });
  });

  it('额度不足给的是「去充值」而不是「稍等再试」', () => {
    const reply = buildGracefulReply(httpError(402, { error: { message: 'Insufficient Balance' } }));
    expect(reply.category).toBe('quota_exhausted');
    expect(reply.suggestRetry).toBe(false);
    expect(reply.userMessage).toContain('额度');
    expect(reply.actionHint).not.toContain('稍等几秒');
  });

  it('鉴权失败不会建议重试', () => {
    const reply = buildGracefulReply(httpError(401, { error: { message: 'Invalid API key' } }));
    expect(reply.category).toBe('auth');
    expect(reply.suggestRetry).toBe(false);
  });

  it('后台进程因额度不足失败 → 文案不说「稍后重试」', () => {
    const notice = buildWorkerFailureNotice({
      pid: 'p2', task: '做一份周报', error: 'Insufficient Balance', willRetry: false,
    });
    expect(notice.userMessage).toContain('额度不足');
  });

  it('网关信封的 quota.* 与模型侧同一口径（不重试）', () => {
    /* 真实形状: axios 错误 + 网关信封 (kernel 只认带 HTTP 状态的信封) */
    const envelope = httpError(429, {
      error: { code: 'quota.exhausted', message: '额度不足', retryable: false, requestId: 'req_1' },
    });
    expect(classifyError(envelope)).toBe('quota_exhausted');
    expect(classifyKernelError(envelope).category).toBe(KernelErrorCategory.FATAL_LIMIT);
    expect(classifyKernelError(envelope).retryable).toBe(false);
  });

  it('流中途的 quota 错误帧不会被当成限流重连', () => {
    const frame = Object.assign(new Error('额度不足'), { code: 'quota.exhausted', isStreamError: true });
    expect(classifyError(frame)).toBe('quota_exhausted');
    expect(classifyKernelError(frame).retryable).toBe(false);
  });

  it('已经是 NeoxError 时沿用它的分类', () => {
    const e = new NeoxError({
      category: KernelErrorCategory.FATAL_LIMIT,
      code: 'quota.exhausted',
      message: '额度不足',
      retryable: false,
    });
    expect(classifyError(e)).toBe('quota_exhausted');
  });

  it('Work 与 Code 同一份口径: core 的判定与 kernel 的 retryable 完全一致', () => {
    /* 这两条链路共用 kernel 的模型客户端，所以「能不能重试」只该有一个答案。
     * 有结构性证据的错误必须与 kernel 的 retryable 逐条相等。 */
    const withEvidence = [...NEVER_RETRY, ...ALWAYS_RETRY]
      .filter(([, err]) => typeof (err as any).response?.status === 'number' || (err as any).code);
    expect(withEvidence.length).toBeGreaterThan(0);
    for (const [label, err] of withEvidence) {
      const coreRetryable = isRetryable(classifyError(err));
      expect(coreRetryable, label).toBe(classifyKernelError(err).retryable);
    }
  });

  it('分类结果是固定枚举，UI 开关能穷尽', () => {
    const categories: ErrorCategory[] = [
      'rate_limit', 'server_error', 'network', 'token_limit',
      'quota_exhausted', 'auth', 'invalid_request', 'unknown',
    ];
    for (const c of categories) expect(typeof isRetryable(c)).toBe('boolean');
  });
});
