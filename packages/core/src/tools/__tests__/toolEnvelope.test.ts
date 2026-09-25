/**
 * toolEnvelope 单测 — D17 helpers 的契约固化.
 *
 * 防止重构改坏 timeout / abort / error 序列化逻辑。
 */

import { describe, expect, test, vi } from 'vitest';
import {
  withTimeout,
  safeError,
  normalizeAbortReason,
  DEFAULT_TOOL_TIMEOUT_MS,
  TOOL_TIMEOUT_CODE,
} from '../toolEnvelope';

describe('withTimeout', () => {
  test('fn 正常返回值原样透传', async () => {
    const result = await withTimeout(async () => 42, 1000);
    expect(result).toBe(42);
  });

  test('超时 → 抛 Error code=tool_timeout', async () => {
    const promise = withTimeout(
      (signal) => new Promise<void>((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('cancelled')));
      }),
      50,
    );
    await expect(promise).rejects.toMatchObject({ code: TOOL_TIMEOUT_CODE });
  });

  test('外部 signal 已 aborted → 立即抛 abort 错', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      withTimeout(async () => 'x', 1000, ctrl.signal),
    ).rejects.toMatchObject({ code: 'aborted' });
  });

  test('外部 signal 中途 abort → 抛 abort 错而非 timeout', async () => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 20);
    const promise = withTimeout(
      (signal) => new Promise<void>((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('cancelled')));
      }),
      500,
      ctrl.signal,
    );
    await expect(promise).rejects.toMatchObject({ code: 'aborted' });
  });

  test('fn 自己 throw → 错误透传 (不变 code)', async () => {
    const promise = withTimeout(async () => {
      const e: any = new Error('boom');
      e.code = 'my_code';
      throw e;
    }, 1000);
    await expect(promise).rejects.toMatchObject({ code: 'my_code', message: 'boom' });
  });
});

describe('safeError', () => {
  test('带 code 字段的 Error → 透传 code', () => {
    const e: any = new Error('quota exceeded');
    e.code = 'quota_exceeded';
    expect(safeError(e)).toEqual({ error: 'quota exceeded', code: 'quota_exceeded' });
  });

  test('AbortError → code=aborted, 不当 tool 失败', () => {
    const e: any = new Error('cancelled');
    e.name = 'AbortError';
    e.code = 'aborted';
    expect(safeError(e)).toEqual({ error: 'Operation cancelled', code: 'aborted' });
  });

  test('普通 Error 无 code → tool_throw 兜底', () => {
    expect(safeError(new Error('bad'))).toEqual({ error: 'bad', code: 'tool_throw' });
  });

  test('非 Error throw (字符串/对象) → String() 兜底', () => {
    expect(safeError('string thrown')).toEqual({ error: 'string thrown', code: 'tool_throw' });
    expect(safeError({ msg: 'object' })).toMatchObject({ code: 'tool_throw' });
  });

  test('空消息 → "tool failed"', () => {
    expect(safeError(new Error(''))).toEqual({ error: 'tool failed', code: 'tool_throw' });
  });
});

describe('normalizeAbortReason', () => {
  test('signal aborted → "aborted"', () => {
    const ctrl = new AbortController();
    ctrl.abort();
    expect(normalizeAbortReason(ctrl.signal)).toBe('aborted');
  });

  test('signal 未 aborted → undefined', () => {
    const ctrl = new AbortController();
    expect(normalizeAbortReason(ctrl.signal)).toBeUndefined();
  });

  test('signal 缺失 → undefined', () => {
    expect(normalizeAbortReason(undefined)).toBeUndefined();
  });
});

describe('常量', () => {
  test('DEFAULT_TOOL_TIMEOUT_MS = 60 秒', () => {
    expect(DEFAULT_TOOL_TIMEOUT_MS).toBe(60_000);
  });

  test('TOOL_TIMEOUT_CODE = tool_timeout', () => {
    expect(TOOL_TIMEOUT_CODE).toBe('tool_timeout');
  });
});
