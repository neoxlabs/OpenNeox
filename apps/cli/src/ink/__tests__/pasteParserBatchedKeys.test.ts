import { describe, it, expect } from 'vitest';
import { PasteParser } from '../../../vendor/ink/src/PasteParser.js';

function feed(data: string): string[] {
  const out: string[] = [];
  const p = new PasteParser();
  p.parse(data, (text) => { out.push(text); });
  p.dispose();
  return out;
}

describe('PasteParser 拆分同一次读到的多个按键', () => {
  it('两次 ↑ = 两个事件', () => {
    expect(feed('\x1b[A\x1b[A')).toEqual(['\x1b[A', '\x1b[A']);
  });

  it('方向键后面紧跟的字不丢', () => {
    expect(feed('\x1b[Dhello')).toEqual(['\x1b[D', 'hello']);
  });

  it('带参数的 CSI (Shift+↑ / SGR 鼠标) 整个算一个', () => {
    expect(feed('\x1b[1;2A\x1b[<0;10;5M')).toEqual(['\x1b[1;2A', '\x1b[<0;10;5M']);
  });

  it('SS3 与 Meta 键', () => {
    expect(feed('\x1bOA\x1bbx')).toEqual(['\x1bOA', '\x1bb', 'x']);
  });

  it('ESC ESC [A (Option+↑) 是一个键', () => {
    expect(feed('\x1b\x1b[A')).toEqual(['\x1b\x1b[A']);
  });

  it('粘贴序列照旧整段交出', () => {
    const got: Array<[string, boolean]> = [];
    const p = new PasteParser();
    p.parse('\x1b[A\x1b[200~a\x1b[Bb\x1b[201~', (t, isPaste) => { got.push([t, isPaste]); });
    p.dispose();
    expect(got).toEqual([['\x1b[A', false], ['a\x1b[Bb', true]]);
  });
});
