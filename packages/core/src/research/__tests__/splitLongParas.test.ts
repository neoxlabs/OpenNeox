import { describe, expect, it } from 'vitest';

import { splitLongParas } from '../report';

const sent = (n: number, mark = '。') => '这是一句用来凑长度的正文内容'.repeat(n) + mark;

describe('splitLongParas', () => {
  it('⚠️ 不动模型已经分好的短段 (原样返回)', () => {
    const paras = ['第一段很短。', '第二段也不长。'];
    expect(splitLongParas(paras)).toEqual(paras);
  });

  it('一整章挤成一坨时按句末标点断开 (实拍的那种砖墙)', () => {
    const wall = sent(4) + sent(4) + sent(4) + sent(4);
    const out = splitLongParas([wall]);
    expect(out.length).toBeGreaterThan(1);
    /* 断点必须落在句末标点上, 不许把句子切两半 */
    for (const p of out.slice(0, -1)) expect(p.endsWith('。')).toBe(true);
    /* 内容一个字不能丢 */
    expect(out.join('')).toBe(wall);
  });

  it('收尾的半句太短就并回上一段, 不留孤句', () => {
    const out = splitLongParas([sent(10) + '短尾。']);
    expect(out[out.length - 1].length).toBeGreaterThanOrEqual(40);
  });

  it('整段没有句末标点时不硬切 (宁可长, 不切出断句)', () => {
    const noPunct = '没有任何句末标点的一长串文字'.repeat(20);
    expect(splitLongParas([noPunct])).toEqual([noPunct]);
  });
});
