/**
 * 错误分类的顺序契约。stream、SSE、disconnected 和 incomplete 等网络信号使用通用
 * 重试规则；context length exceeded 与 model does not support streaming 等确定性错误
 * 必须先分类，避免把不可重试的问题误判为网络中断。
 */
import { describe, expect, it } from 'vitest';
import { classifyError, ErrorCategory } from '../errors.js';

const cls = (msg: string) => classifyError(new Error(msg));

describe('确定性判定必须排在通用 stream 分支之前', () => {
  it('上下文超窗 —— 即使消息里带 streaming, 也不许当网络问题重试', () => {
    const e = cls('context length exceeded while streaming the response');
    expect(e.code).toBe('CONTEXT_WINDOW_EXCEEDED');
    expect(e.retryable).toBe(false);
  });

  it('不支持流式 = 配置问题, 不是网络问题', () => {
    for (const msg of [
      'This model does not support streaming',
      'Streaming is not supported for this endpoint',
      "Invalid value for 'stream': expected false",
    ]) {
      const e = cls(msg);
      expect(e.code, msg).toBe('STREAMING_UNSUPPORTED');
      expect(e.retryable, msg).toBe(false);
      expect(e.category, msg).toBe(ErrorCategory.FATAL_INVALID);
    }
  });

  /* 对照组 —— 真的传输中断仍然要能重试。
     把这条判死会让每一次网络抖动都变成一次硬失败, 比原来的 bug 更糟。 */
  it('真·传输中断照旧可重试', () => {
    const e = cls('stream disconnected unexpectedly');
    expect(e.code).toBe('STREAM_ERROR');
    expect(e.retryable).toBe(true);
    expect(e.category).toBe(ErrorCategory.RETRYABLE_STREAM);
  });

  it('文案不再声称"网络中断" —— 那是对原因的断言, 而这里只知道流断了', () => {
    expect(cls('SSE incomplete').message).not.toContain('网络中断');
  });
});
