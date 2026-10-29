import { describe, test, expect } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { normalizeLooseLists } from '../normalizeLooseLists';
import { remarkSoftBreaks } from '../remarkSoftBreaks';


const parse = (src: string, soft = true) => {
  const p = unified().use(remarkParse).use(remarkGfm);
  if (soft) p.use(remarkSoftBreaks as never);
  /* runSync 返回 unified 的 Node, 跟这个结构没交集 —— 单层 as 会被 TS2352 拦 */
  return p.runSync(p.parse(src)) as unknown as { children: Array<{ type: string; children?: unknown[] }> };
};
const shape = (src: string, soft = true) => parse(src, soft).children.map((n) => n.type).join('+');
const countBreaks = (src: string) => {
  let n = 0;
  const walk = (node: { type?: string; children?: unknown[] }) => {
    if (node.type === 'break') n++;
    (node.children as Array<{ type?: string }> | undefined)?.forEach((c) => walk(c));
  };
  walk(parse(src) as never);
  return n;
};

describe('序号后漏空格仍要成列表', () => {
  test('实测原文形状: 1.读 / 2.列 / 3.读', () => {
    const raw = '1.读 package.json\n2.列 src/lib\n3.读 config-store.js';
    expect(shape(raw, false)).toBe('paragraph');                    /* ← 修之前 */
    expect(shape(normalizeLooseLists(raw), false)).toBe('list');    /* ← 修之后 */
  });

  test('1) 这种右括号写法同样兜住', () => {
    expect(shape(normalizeLooseLists('1)甲\n2)乙'), false)).toBe('list');
  });

  test('小数不许被拆成列表项', () => {
    expect(normalizeLooseLists('3.14 是圆周率')).toBe('3.14 是圆周率');
    expect(shape(normalizeLooseLists('3.14 是圆周率'), false)).toBe('paragraph');
  });

  test('已经规范的写法一字不动', () => {
    const ok = '1. 甲\n2. 乙';
    expect(normalizeLooseLists(ok)).toBe(ok);
  });

  test('围栏代码块里的行首数字不许动', () => {
    const src = '```js\n1.foo()\n2.bar()\n```';
    expect(normalizeLooseLists(src)).toBe(src);
  });

  test('无序项要 ≥2 行才认, 免得误伤 *强调* 与 --- 分隔线', () => {
    expect(normalizeLooseLists('*只有一行强调*')).toBe('*只有一行强调*');
    expect(normalizeLooseLists('---')).toBe('---');
    expect(shape(normalizeLooseLists('-甲\n-乙'), false)).toBe('list');
  });
});

describe('段内单换行 = 真换行', () => {
  test('两行文本产生一个 break', () => {
    expect(countBreaks('第一行\n第二行')).toBe(1);
  });

  test('实测那条 18 换行的清单不会再糊成一坨', () => {
    const raw = Array.from({ length: 19 }, (_, i) => `${i + 1}.第${i + 1}件事`).join('\n');
    /* 修完既是列表, 也不再是单段落 */
    const tree = parse(normalizeLooseLists(raw));
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0].type).toBe('list');
    expect(tree.children[0].children).toHaveLength(19);
  });

  test('代码块内的换行不产生 break', () => {
    expect(countBreaks('```\na\nb\nc\n```')).toBe(0);
  });

  test('行内 code 不受影响', () => {
    expect(countBreaks('用 `a b` 表示')).toBe(0);
  });

  test('空行分段仍然是两个段落, 不是 break', () => {
    const tree = parse('段一\n\n段二');
    expect(tree.children.map((c) => c.type)).toEqual(['paragraph', 'paragraph']);
    expect(countBreaks('段一\n\n段二')).toBe(0);
  });

  test('长文本多换行不会漏 (插入节点后游标要跳过, 否则会无限递归)', () => {
    const src = Array.from({ length: 200 }, (_, i) => `行${i}`).join('\n');
    expect(countBreaks(src)).toBe(199);
  });
});
