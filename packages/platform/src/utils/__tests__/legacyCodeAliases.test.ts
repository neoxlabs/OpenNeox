/**
 * kernel 的大写老码 → catalogue 的 dot-namespace key.
 *
 *   presentNeoxError 通过别名表将 kernel 的大写错误码映射到目录 key；未知码继续使用
 *   `title = envelope.message 第一行 || 裸 code` 作为兜底。
 *
 *   测试覆盖已定义的别名和明确保留的未知码，确保 UNKNOWN 等上游原始信息不会被错误
 *   替换为泛化文案。
 */

import { describe, expect, test } from 'vitest';
import { presentNeoxError } from '../neoxErrorCatalogue';

const present = (code: string, message = '') =>
  presentNeoxError({ code, severity: 'error', retryable: false, message } as never);

describe('老码别名 — 实测难看的那批', () => {
  test.each(['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'EPIPE'])(
    '%s 不再把 `Network error: connect ...` 当标题', (code) => {
      const p = present(code, `Network error: connect ${code} 127.0.0.1:443`);
      expect(p.title).toBe('网络连接异常');
      expect(p.title).not.toMatch(/[A-Z]{5,}/);
    });

  test.each(['CANCELED', 'ERR_CANCELED'])(
    '%s 是用户自己点的停止, 标题不该是英文 (kernel 带的是 Request was canceled)', (code) => {
      const p = present(code, 'Request was canceled');
      expect(p.title).toBe('请求已取消');
      expect(p.severity).toBe('info');
    });

  test('FORBIDDEN 不再摊英文 Access denied, 且给出可操作的下一步', () => {
    const p = present('FORBIDDEN', 'Access denied. Please check your API permissions.');
    expect(p.title).toBe('API 密钥无效');
    expect(p.action?.kind).toBe('open_providers');
  });

  test('CONTEXT_WINDOW_EXCEEDED 不再摊 kernel 里写死的那句英文', () => {
    const p = present('CONTEXT_WINDOW_EXCEEDED',
      'Context window exceeded. Please start a new conversation or clear history.');
    expect(p.title).toBe('上下文超出模型窗口');
    expect(p.message).not.toMatch(/Context window exceeded/);
    /* 换个窗口更大的模型是这里唯一能立刻继续的操作 */
    expect(p.action?.kind).toBe('switch_model');
  });
});

describe('故意不映的, 别"看着码表补齐"', () => {
  test('UNKNOWN 保留上游原话 —— 那是这时候唯一的信息', () => {
    const p = present('UNKNOWN', 'upstream said something specific');
    expect(p.title).toBe('upstream said something specific');
  });

  test('STREAM_ERROR / STREAM_INCOMPLETE 的 message 本来就是中文, 兜底够用', () => {
    expect(present('STREAM_ERROR', '网络中断: socket hang up').title).toBe('网络中断: socket hang up');
    expect(present('STREAM_INCOMPLETE', '网络中断: aborted').title).toBe('网络中断: aborted');
  });
});

describe('别名表的健康度', () => {
  test('每条别名都指向真实存在的 catalogue key (映到不存在的 key = 静默失效)', () => {
    /* 映丢了不会报错, 只会安静地继续走兜底 —— 所以必须有这条。
     * 判据: 走到了 preset 的一定不等于 fallback (fallback 的 title = message 原样)。 */
    const probe = '___never_a_real_message___';
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'EPIPE',
                        'CANCELED', 'ERR_CANCELED', 'FORBIDDEN', 'CONTEXT_WINDOW_EXCEEDED',
                        'INSUFFICIENT_BALANCE', 'QUOTA_EXCEEDED', 'USAGE_LIMIT_REACHED',
                        'HTTP_429', 'UNAUTHORIZED', 'CONNECT_TIMEOUT', 'TIMEOUT',
                        'STREAM_TIMEOUT', 'STREAM_IDLE_TIMEOUT', 'PROXY_UPSTREAM_FAILED',
                        'INVALID_REQUEST']) {
      expect(present(code, probe).title, `${code} 的别名指向了不存在的 key`).not.toBe(probe);
    }
  });
});
