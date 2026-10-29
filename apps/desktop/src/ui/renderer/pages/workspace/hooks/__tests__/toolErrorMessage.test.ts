import { describe, expect, it } from 'vitest';
import { pickToolErrorMessage, toolErrorFallbackText, ERROR_MESSAGE_KEYS } from '../toolErrorMessage';

describe('pickToolErrorMessage', () => {
  it('裸字符串就是错误信息, 原样返回 (去掉首尾空白)', () => {
    expect(pickToolErrorMessage('  ENOENT: no such file  ')).toBe('ENOENT: no such file');
  });

  it('对象里有 message 就用 message', () => {
    expect(pickToolErrorMessage({ message: 'File not found', file_path: '/a/b.ts' }))
      .toBe('File not found');
  });

  it('按 ERROR_MESSAGE_KEYS 的顺序取第一个非空字段', () => {
    /* message 为空白时不能占坑, 要继续往后找 */
    expect(pickToolErrorMessage({ message: '   ', error: 'boom' })).toBe('boom');
    expect(pickToolErrorMessage({ stderr: 'command not found', reason: 'x' }))
      .toBe('command not found');
  });

  it('shell 工具的参数载荷 → 认不出错误信息 (真机实拍形状)', () => {
    expect(pickToolErrorMessage({ command: 'ls -la /private/tmp/neox-tbl/demo' })).toBe('');
  });

  it('write_file 的参数载荷 → 认不出错误信息 (真机实拍形状)', () => {
    expect(pickToolErrorMessage({
      file_path: '/private/tmp/neox-tbl/demo/utils.js',
      content: '/** 求和 */\nfunction sum(...nums) {\n  return nums.reduce((a, n) => a + n, 0);\n}\n',
    })).toBe('');
  });

  it('非对象 / 空值 / 数组一律认不出', () => {
    expect(pickToolErrorMessage(null)).toBe('');
    expect(pickToolErrorMessage(undefined)).toBe('');
    expect(pickToolErrorMessage(42)).toBe('');
    expect(pickToolErrorMessage(['boom'])).toBe('');
    expect(pickToolErrorMessage({})).toBe('');
  });

  it('字段值不是字符串时不采用 (避免把对象再 stringify 一遍甩给用户)', () => {
    expect(pickToolErrorMessage({ message: { nested: 'x' } })).toBe('');
    expect(pickToolErrorMessage({ error: 500 })).toBe('');
  });

  it('ERROR_MESSAGE_KEYS 里不含任何工具参数名 —— 判据是"像错误"而不是"像参数"', () => {
    const argKeys = ['command', 'file_path', 'content', 'path', 'query', 'pattern', 'args'];
    for (const k of argKeys) {
      expect(ERROR_MESSAGE_KEYS as readonly string[]).not.toContain(k);
    }
  });
});

describe('toolErrorFallbackText', () => {
  it('中文界面给中文兜底, 并指向「复制错误详情」', () => {
    const zh = toolErrorFallbackText('zh');
    expect(zh).toContain('工具没有返回错误信息');
    expect(zh).toContain('复制错误详情');
  });

  it('其他语言回落英文', () => {
    expect(toolErrorFallbackText('en')).toContain('no error message');
    expect(toolErrorFallbackText('ja')).toContain('no error message');
  });
});
