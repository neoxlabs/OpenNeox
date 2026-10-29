import { describe, expect, test } from 'vitest';
import { splitMarkdownBlocks } from '../markdownBlocks';

const roundTrip = (md: string) => expect(splitMarkdownBlocks(md).join('')).toBe(md);

describe('splitMarkdownBlocks', () => {
  test('段落/标题/表格之间的空行处切开, 拼回去逐字相同', () => {
    const md = '# 标题\n\n第一段\n第一段续行\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n## 小节\n\n末段';
    const blocks = splitMarkdownBlocks(md);
    expect(blocks).toEqual(['# 标题\n\n', '第一段\n第一段续行\n\n', '| a | b |\n|---|---|\n| 1 | 2 |\n\n', '## 小节\n\n', '末段']);
    roundTrip(md);
  });

  test('代码围栏里的空行不切', () => {
    const md = '说明\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n后文';
    expect(splitMarkdownBlocks(md)).toEqual(['说明\n\n', '```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n', '后文']);
    roundTrip(md);
  });

  test('流式中围栏还没闭合: 后面全部留在同一块, 不会把半截代码当正文切走', () => {
    const md = '前文\n\n```py\nx = 1\n\ny = 2';
    expect(splitMarkdownBlocks(md)).toEqual(['前文\n\n', '```py\nx = 1\n\ny = 2']);
  });

  test('~~~ 围栏与更长的 ``` 围栏按开合配对', () => {
    const md = '````md\n```\n\ninner\n```\n````\n\n尾';
    expect(splitMarkdownBlocks(md)).toEqual(['````md\n```\n\ninner\n```\n````\n\n', '尾']);
    roundTrip(md);
  });

  test('$$ 公式块内的空行不切', () => {
    const md = '公式:\n\n$$\na = b\n\nc = d\n$$\n\n完';
    expect(splitMarkdownBlocks(md)).toEqual(['公式:\n\n', '$$\na = b\n\nc = d\n$$\n\n', '完']);
    roundTrip(md);
  });

  test('松散列表不拆: 空行后紧跟下一个列表项 / 缩进续段都留在同一块', () => {
    const md = '1. 第一项\n\n2. 第二项\n\n   第二项的续段\n\n- 另一种\n\n- 列表\n\n结束段';
    expect(splitMarkdownBlocks(md)).toEqual(['1. 第一项\n\n2. 第二项\n\n   第二项的续段\n\n- 另一种\n\n- 列表\n\n', '结束段']);
    roundTrip(md);
  });

  test('有脚注 / 引用式链接定义: 整条不切 (定义和引用可能跨块)', () => {
    const fn = '正文[^1]\n\n另一段\n\n[^1]: 脚注';
    expect(splitMarkdownBlocks(fn)).toEqual([fn]);
    const ref = '见 [文档][doc]\n\n另一段\n\n[doc]: https://example.com';
    expect(splitMarkdownBlocks(ref)).toEqual([ref]);
  });

  test('跨行块级 HTML (<details>): 开合之间不切, 合上之后照切', () => {
    const md = '前文\n\n<details>\n<summary>展开</summary>\n\n内容\n\n</details>\n\n后文';
    expect(splitMarkdownBlocks(md)).toEqual(['前文\n\n', '<details>\n<summary>展开</summary>\n\n内容\n\n</details>\n\n', '后文']);
    roundTrip(md);
  });

  test('嵌套同名标签按深度配对, 内层合上不算出块', () => {
    const md = '<div>\n<div>内</div>\n\n仍在外层\n\n</div>\n\n后文';
    expect(splitMarkdownBlocks(md)).toEqual(['<div>\n<div>内</div>\n\n仍在外层\n\n</div>\n\n', '后文']);
  });

  test('单行里自己闭合的 HTML (报告图注 <p class>) 不妨碍切分 —— 真机报告撞过: 全局拦截让整条退回一块', () => {
    const md = '图表\n\n<p class="nx-figsrc">数据来源: 官方</p>\n\n下一段';
    expect(splitMarkdownBlocks(md)).toEqual(['图表\n\n', '<p class="nx-figsrc">数据来源: 官方</p>\n\n', '下一段']);
    roundTrip(md);
  });

  /* Markdown.tsx 的"前缀元素缓存"直接建立在这条性质上: 它把除最后一块外的元素整段 memo,
   * 依赖是前缀拼串。若追加内容会改动前面的块, 缓存就会渲染出过期内容。
   * 这条性质来自实现本身 (纯前向扫描, 遇可切空行就 flush), 但必须有闸门钉住 ——
   * 以后谁把切分改成"回看/重排"就会在这里红, 而不是在用户的长报告里才发现。 */
  test('流式追加只影响最后一块 —— 前缀逐块不变 (前缀元素缓存的前提)', () => {
    const full = '# 标题\n\n第一段\n\n```ts\nconst a = 1;\n```\n\n表格前\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n收尾一句';
    let prev: string[] = [];
    for (let i = 1; i <= full.length; i++) {
      const blocks = splitMarkdownBlocks(full.slice(0, i));
      /* 上一帧的前缀 (除最后一块) 必须是这一帧前缀的前缀 —— 只许在末尾生长 */
      const head = blocks.slice(0, -1);
      const prevHead = prev.slice(0, -1);
      if (prevHead.length > 0 && head.length >= prevHead.length) {
        expect(head.slice(0, prevHead.length)).toEqual(prevHead);
      }
      prev = blocks;
    }
  });

  test('空串 / 无空行 / 结尾多个空行都能拼回原文', () => {
    expect(splitMarkdownBlocks('')).toEqual(['']);
    expect(splitMarkdownBlocks('单行')).toEqual(['单行']);
    roundTrip('a\n\n\n\nb\n\n');
    roundTrip('\n\n开头就是空行\n\n正文');
  });
});
