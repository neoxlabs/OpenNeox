import { describe, expect, it } from 'vitest';

import { stripToolHintHeader } from '../toolResultHint';

describe('stripToolHintHeader', () => {
  it('摘掉耗时提示头后, 结构化回执重新以 { 开头 (这正是卡片没出来的真因)', () => {
    const raw = '⏱️ [deep_research took 512.8s]\n\n{"type":"contextual","status":"success"}';
    expect(stripToolHintHeader(raw).startsWith('{')).toBe(true);
  });

  it('没有表情符号也认', () => {
    expect(stripToolHintHeader('[web_search took 3.2s]\n{"a":1}')).toBe('{"a":1}');
  });

  it('被拼过两层也摘得干净', () => {
    const raw = '⏱️ [a took 2s]\n\n⏱️ [b took 3s]\n\n{"x":1}';
    expect(stripToolHintHeader(raw)).toBe('{"x":1}');
  });

  it('⚠️ 不碰正常输出 —— 没有这个头就原样返回', () => {
    expect(stripToolHintHeader('{"type":"contextual"}')).toBe('{"type":"contextual"}');
    expect(stripToolHintHeader('普通文本结果')).toBe('普通文本结果');
  });

  it('⚠️ 不误伤正文里长得像的方括号行 (没有 took 就不算提示头)', () => {
    expect(stripToolHintHeader('[WARN] 磁盘将满\n{"a":1}')).toBe('[WARN] 磁盘将满\n{"a":1}');
  });
});
