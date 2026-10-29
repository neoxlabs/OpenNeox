import { describe, expect, test } from 'vitest';
import { rehypeStatusMarks, splitStatusMarks } from '../rehypeStatusMarks';

const text = (value: string) => ({ type: 'text', value });
const el = (tagName: string, children: any[], properties: any = {}) => ({ type: 'element', tagName, properties, children });
const kinds = (nodes: any[]) => nodes.map((n) => (n.type === 'text' ? n.value : n.properties.className[1]));

describe('splitStatusMarks', () => {
  test('replaces each mark, with or without the variation selector', () => {
    expect(kinds(splitStatusMarks('✅ 言语 50 题')!)).toEqual(['md-mark--done', ' 言语 50 题']);
    expect(kinds(splitStatusMarks('a✔️b❌c⬜')!)).toEqual(['a', 'md-mark--done', 'b', 'md-mark--fail', 'c', 'md-mark--todo']);
  });

  test('leaves plain text alone', () => {
    expect(splitStatusMarks('nothing to see ✓')).toBeNull();
  });
});

describe('rehypeStatusMarks', () => {
  test('replaces marks in table cells but not in code', () => {
    const tree = el('root', [
      el('td', [text('✅')]),
      el('p', [el('code', [text('✅ keep')])]),
      el('span', [text('⬜')], { className: ['katex'] }),
    ]);
    (tree as any).type = 'root';
    rehypeStatusMarks()(tree);
    expect((tree.children[0] as any).children[0].properties.className).toEqual(['md-mark', 'md-mark--done']);
    expect((tree.children[1] as any).children[0].children[0].value).toBe('✅ keep');
    expect((tree.children[2] as any).children[0].value).toBe('⬜');
  });
});
