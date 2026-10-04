import { describe, expect, it } from 'vitest';
import { dropDiscardedTail, runnerStreamRetryToUi } from '../agentRuntimeHostHelpers.js';

describe('runnerStreamRetryToUi', () => {
  it('runner.stream_retry → 界面 stream_retry, 带上作废正文; fullResponse 撤掉那段', () => {
    const r = runnerStreamRetryToUi({
      error: 'ECONNRESET', errorCode: 'ECONNRESET', attempt: 1, maxRetries: 3, delayMs: 1000,
      isNetworkError: true, discardedText: '我先看看本机的情况。', discardPartialToolCalls: true,
    }, '前文。我先看看本机的情况。');
    expect(r.fullResponse).toBe('前文。');
    expect(r.event).toMatchObject({
      type: 'stream_retry', errorCode: 'ECONNRESET', attempt: 1, isNetworkError: true,
      discardedText: '我先看看本机的情况。', discardPartialToolCalls: true,
    });
  });

  it('prefill 续写 (discardedText 空) → fullResponse 不动', () => {
    expect(runnerStreamRetryToUi({ discardedText: '' }, 'abc').fullResponse).toBe('abc');
  });

  it('末尾对不上就不动', () => {
    expect(dropDiscardedTail('abc', 'xyz')).toBe('abc');
    expect(dropDiscardedTail('abcxyz', 'xyz')).toBe('abc');
  });
});
