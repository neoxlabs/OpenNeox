import { describe, it, expect } from 'vitest';
import { shouldCollapsePaste, pasteToken, expandPastes, prunePastes } from '../pastedText';

const log = Array.from({ length: 60 }, (_, i) => `line ${i + 1}: ERROR at module_${i}.py`).join('\n');

describe('长文本粘贴折叠', () => {
  it('短文本照常进输入框, 超过 12 行或 1200 字才折', () => {
    expect(shouldCollapsePaste('hello')).toBe(false);
    expect(shouldCollapsePaste(Array(12).fill('x').join('\n'))).toBe(false);
    expect(shouldCollapsePaste(Array(13).fill('x').join('\n'))).toBe(true);
    expect(shouldCollapsePaste('x'.repeat(1200))).toBe(true);
  });

  it('占位词说清是第几段、有多少行', () => {
    expect(pasteToken(1, log, true)).toBe('[粘贴的文本 #1 · 60 行]');
    expect(pasteToken(2, log, false)).toBe('[Pasted text #2 · 60 lines]');
  });

  it('发送时占位词换回原文, 自己打的字原样保留', () => {
    const token = pasteToken(1, log, true);
    const map = new Map([[token, log]]);
    expect(expandPastes(`帮我看看这个报错 ${token} 是哪里的问题`, map))
      .toBe(`帮我看看这个报错 ${log} 是哪里的问题`);
  });

  it('占位词被删掉, 那段原文就不要了; 普通方括号不受影响', () => {
    const t1 = pasteToken(1, log, true);
    const t2 = pasteToken(2, 'a\n'.repeat(20), true);
    const map = new Map([[t1, log], [t2, 'b']]);
    const kept = prunePastes(`只留 ${t2} 和 [普通方括号]`, map);
    expect([...kept.keys()]).toEqual([t2]);
    expect(expandPastes('[普通方括号]', kept)).toBe('[普通方括号]');
  });
});
