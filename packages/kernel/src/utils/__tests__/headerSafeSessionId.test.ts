/** 验证会话 ID 在发送给上游前变为确定性的 URL 安全值。 */
import { describe, expect, it } from 'vitest';
import { headerSafeSessionId } from '../headerSafeSessionId.js';

describe('清洗掉会截断 URL 的字符', () => {
  it('实拍那个子 agent id: `#` 换成 `-`', () => {
    expect(headerSafeSessionId('agent_Agent-7#3_1788765432100'))
      .toBe('agent_Agent-7-3_1788765432100');
  });

  it('主 agent 的 id 原样通过 —— 它本来就是安全的, 不能因为清洗而改变', () => {
    const main = 'session-1788618890134-abc123';
    expect(headerSafeSessionId(main)).toBe(main);
  });

  it('其他 URL 敏感字符一并清掉', () => {
    expect(headerSafeSessionId('a?b&c=d/e f%g')).toBe('a-b-c-d-e-f-g');
  });

  it('安全字符集保留: 字母数字 _ . : -', () => {
    const s = 'Abc_123.4:5-6';
    expect(headerSafeSessionId(s)).toBe(s);
  });
});

describe('⚠️ 确定性 (prompt cache 分区键靠它)', () => {
  it('同一输入永远同一输出', () => {
    const id = 'agent_Agent-9#12_1788';
    expect(headerSafeSessionId(id)).toBe(headerSafeSessionId(id));
  });

  it('替换而不是删除 —— a#b 和 ab 不能撞成同一个 id', () => {
    expect(headerSafeSessionId('a#b')).not.toBe(headerSafeSessionId('ab'));
  });
});

describe('边界', () => {
  it('空 / null / undefined 不炸, 返回空串', () => {
    expect(headerSafeSessionId('')).toBe('');
    expect(headerSafeSessionId(null)).toBe('');
    expect(headerSafeSessionId(undefined)).toBe('');
  });

  it('中文等非 ASCII 也清掉 (header 值只允许 VCHAR)', () => {
    /* 会→- 话→- 中划线保留 1保留 = 4 个字符 */
    expect(headerSafeSessionId('会话-1')).toBe('---1');
  });
});
