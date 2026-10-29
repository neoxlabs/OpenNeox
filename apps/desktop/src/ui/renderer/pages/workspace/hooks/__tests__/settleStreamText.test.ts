import { describe, test, expect } from 'vitest';
import { settleStreamText } from '../settleStreamText';

const id = (t: string | undefined) => t;

describe('settleStreamText', () => {
  test('流式少了尾巴 → 补成定稿全文', () => {
    expect(settleStreamText('画面是暖水彩的日式插画风，下', '画面是暖水彩的日式插画风，下面开始画。', id))
      .toBe('画面是暖水彩的日式插画风，下面开始画。');
  });

  test('两份一致 → 原样返回, 不跳打字过程', () => {
    expect(settleStreamText('画好了', '画好了', id)).toBe('画好了');
  });

  test('定稿更短 (被 trim / 剥离器改过) → 保留流式文本', () => {
    expect(settleStreamText('画好了，还有一句', '画好了', id)).toBe('画好了，还有一句');
  });

  test('流式文本不是定稿前缀 (中途被改写) → 不拼, 保留流式', () => {
    expect(settleStreamText('甲说完了', '乙说完了并且多一句', id)).toBe('甲说完了');
  });

  test('气泡空着 → 直接用定稿', () => {
    expect(settleStreamText('', '画好了', id)).toBe('画好了');
    expect(settleStreamText(undefined, '画好了', id)).toBe('画好了');
  });

  test('两份都没有 → undefined, 不塞空串', () => {
    expect(settleStreamText(undefined, undefined, id)).toBeUndefined();
  });

  test('补完之后仍要过剥离器 (DSML 残骸)', () => {
    const strip = (t: string | undefined) => t?.replace(/<\|DSML\|>/g, '');
    expect(settleStreamText('前半句', '前半句<|DSML|>后半句', strip)).toBe('前半句后半句');
  });
});
