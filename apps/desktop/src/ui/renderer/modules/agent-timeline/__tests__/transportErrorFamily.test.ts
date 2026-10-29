import { describe, expect, it } from 'vitest';

function errorKeyOf(rawCode: string): string {
  const family = /^(network|stream)\./.test(rawCode) ? rawCode.split('.')[0] : null;
  return (family ?? rawCode).replace(/[^\w.-]/g, '_');
}

describe('传输类错误按族合并卡片身份', () => {
  it('network.* 全部折成同一张卡', () => {
    const codes = ['network.timeout', 'network.unreachable', 'network.dns', 'network.tls', 'network.proxy_unreachable'];
    expect(new Set(codes.map(errorKeyOf)).size).toBe(1);
    expect(errorKeyOf('network.timeout')).toBe('network');
  });

  it('stream.* 全部折成同一张卡', () => {
    expect(errorKeyOf('stream.disconnected')).toBe('stream');
    expect(errorKeyOf('stream.malformed')).toBe('stream');
  });

  it('network 与 stream 仍是两族, 不互相吞', () => {
    expect(errorKeyOf('network.timeout')).not.toBe(errorKeyOf('stream.disconnected'));
  });

  it('非传输类的码保持各自独立 —— 401 与超时不能合并', () => {
    expect(errorKeyOf('AUTH_FAILED')).toBe('AUTH_FAILED');
    expect(errorKeyOf('RUNTIME_ERROR')).toBe('RUNTIME_ERROR');
    expect(errorKeyOf('AUTH_FAILED')).not.toBe(errorKeyOf('network.timeout'));
  });

  it('码里的怪字符仍被清理 (要用作 DOM id 的一部分)', () => {
    expect(errorKeyOf('weird code/with:chars')).toBe('weird_code_with_chars');
  });
});
