import { describe, it, expect } from 'vitest';
import { decodeTtyTypeahead } from '../bootstrap/earlyInputCapture.js';

/* 启动那 ~1s 里按下的回车以前被当控制字符丢掉: 用户敲完字回车, 输入框是空的, 那一下白按。
 * 现在解码时保留「用户按过回车」这个意图, 由 App 在输入框就绪后补一次提交。 */
describe('启动期按键缓冲 (typeahead)', () => {
  it('文字后面跟回车 → 保留文字并记住提交意图', () => {
    expect(decodeTtyTypeahead('neox\r')).toEqual({ text: 'neox', submit: true });
  });

  it('只按了回车 → 空输入 + 提交意图 (空提交本身 no-op)', () => {
    expect(decodeTtyTypeahead('\r')).toEqual({ text: '', submit: true });
  });

  it('没按回车 → 不提交', () => {
    expect(decodeTtyTypeahead('abc')).toEqual({ text: 'abc', submit: false });
  });

  it('方向键等转义序列被丢掉, 不该被当成回车', () => {
    expect(decodeTtyTypeahead('\x1b[Aab')).toEqual({ text: 'ab', submit: false });
  });

  it('回车前后的字都保留, 退格仍然删字', () => {
    expect(decodeTtyTypeahead('ab\rcd\x7f')).toEqual({ text: 'abc', submit: true });
  });
});
