import { describe, expect, it } from 'vitest';
import {
  captureTaskAgentRuntimeError,
  resolveTaskAgentRunError,
  stripCapturedErrorPriority,
} from '../agent/taskAgentRunFailure.js';

/* E5 回归: sub-agent 具体错因不能被 generic 'Task failed' status 覆盖.
 *   之前 captureTaskAgentRuntimeError 简单 "后来覆盖前面", 导致 log 顺序里 explore 先
 *   yield 'Reached max iterations (30)', 紧接着 agentRuntimeHost 3663 yield generic
 *   status:'Task failed' → 具体错因丢失, PARTIAL header 只显示 'Task failed'.
 *   现在按优先级 error_classified > error > status/error 保留最具体的信息. */

describe('captureTaskAgentRuntimeError priority ordering (E5)', () => {
  it('error_classified is not overridden by later generic status/error', () => {
    let acc: string | undefined;
    acc = captureTaskAgentRuntimeError(
      { type: 'error_classified', message: 'Reached max iterations (30). Please summarize.' } as any,
      acc,
    );
    acc = captureTaskAgentRuntimeError(
      { type: 'status', status: 'error', message: 'Task failed' } as any,
      acc,
    );
    /* 剥掉内部优先级前缀 (\x01P... 语义) */
    expect(stripCapturedErrorPriority(acc)).toBe('Reached max iterations (30). Please summarize.');
  });

  it('error is overridden by later error_classified (更具体)', () => {
    let acc: string | undefined;
    acc = captureTaskAgentRuntimeError({ type: 'error', message: 'network hiccup' } as any, acc);
    acc = captureTaskAgentRuntimeError(
      { type: 'error_classified', message: 'FATAL_LIMIT: quota exhausted' } as any,
      acc,
    );
    expect(stripCapturedErrorPriority(acc)).toBe('FATAL_LIMIT: quota exhausted');
  });

  it('status/error is NOT overridden by another status/error (first wins at same priority)', () => {
    let acc: string | undefined;
    acc = captureTaskAgentRuntimeError(
      { type: 'status', status: 'error', message: 'Iteration timeout' } as any,
      acc,
    );
    acc = captureTaskAgentRuntimeError(
      { type: 'status', status: 'error', message: 'Task failed' } as any,
      acc,
    );
    /* 首个 status/error 保留, 后来的通用 'Task failed' 不再覆盖 */
    expect(stripCapturedErrorPriority(acc)).toBe('Iteration timeout');
  });

  it('non-error events are ignored', () => {
    let acc: string | undefined = undefined;
    acc = captureTaskAgentRuntimeError(
      { type: 'text_chunk', chunk: 'hello' } as any,
      acc,
    );
    expect(acc).toBeUndefined();
  });
});

describe('resolveTaskAgentRunError strips priority prefix (E5)', () => {
  it('returns clean message for failed summary with captured error', () => {
    let acc: string | undefined;
    acc = captureTaskAgentRuntimeError(
      { type: 'error_classified', message: 'iteration_limit(30)' } as any,
      acc,
    );
    const resolved = resolveTaskAgentRunError(
      { failed: true, interrupted: false, output: 'partial content' } as any,
      acc,
      'fallback',
    );
    expect(resolved).toBe('iteration_limit(30)');
  });

  it('falls back to output when no runtime error captured', () => {
    const resolved = resolveTaskAgentRunError(
      { failed: true, interrupted: false, output: 'Error: something wrong' } as any,
      undefined,
      'fallback',
    );
    expect(resolved).toBe('Error: something wrong');
  });

  it('returns aborted for interrupted', () => {
    const resolved = resolveTaskAgentRunError(
      { failed: false, interrupted: true, output: '' } as any,
      undefined,
      'fallback',
    );
    expect(resolved).toBe('aborted');
  });
});
