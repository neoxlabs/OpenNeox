import { describe, test, expect } from 'vitest';
import { buildSnippet, stripMarkdownNoise, hitFromMessage } from '../sessionSearch';

/** 从 snippet + 偏移量取出真正会被 <mark> 包住的那一段 */
const marked = (r: { snippet: string; matchStart: number; matchEnd: number }) =>
  r.snippet.slice(r.matchStart, r.matchEnd);

describe('buildSnippet 偏移量', () => {
  test('命中词左边有连续空白时不再漂移', () => {
    /* 旧实现: 先整体折叠空白再用折叠前的下标 → 每压掉一个空白就右移一格 */
    const text = 'a   b\t\t c     README.md 后面还有一些内容';
    const idx = text.indexOf('README');
    expect(marked(buildSnippet(text, 'README', idx))).toBe('README');
  });

  test('命中词左边有换行也不漂移', () => {
    const text = '第一行\n\n\n第二行里提到 README.md';
    const idx = text.indexOf('README');
    expect(marked(buildSnippet(text, 'README', idx))).toBe('README');
  });

  test('没有多余空白时行为不变', () => {
    const text = '前面 README 后面';
    const idx = text.indexOf('README');
    const r = buildSnippet(text, 'README', idx);
    expect(marked(r)).toBe('README');
    expect(r.snippet).toBe('前面 README 后面');
  });

  test('长文本前后截断时偏移仍然对得上', () => {
    const text = 'x'.repeat(200) + '  \n  README ' + 'y'.repeat(200);
    const idx = text.indexOf('README');
    const r = buildSnippet(text, 'README', idx);
    expect(marked(r)).toBe('README');
    expect(r.snippet.startsWith('…')).toBe(true);
    expect(r.snippet.endsWith('…')).toBe(true);
  });
});

describe('stripMarkdownNoise', () => {
  test('脱掉行内 ** __ ` 记号, 留文字', () => {
    expect(stripMarkdownNoise('没有 `app.js`, 只有 `utils.js`')).toBe('没有 app.js, 只有 utils.js');
    expect(stripMarkdownNoise('这是 **重点** 内容')).toBe('这是 重点 内容');
    expect(stripMarkdownNoise('这是 __重点__ 内容')).toBe('这是 重点 内容');
  });
  test('行首标题 / 引用 / 列表记号', () => {
    expect(stripMarkdownNoise('## 标题')).toBe('标题');
    expect(stripMarkdownNoise('> 引用')).toBe('引用');
    expect(stripMarkdownNoise('- 列表项')).toBe('列表项');
  });
  test('代码围栏行去掉, 内容留着', () => {
    expect(stripMarkdownNoise('```ts\nconst a = 1\n```')).toBe('\nconst a = 1\n');
  });
});

describe('hitFromMessage', () => {
  test('剥完 markdown 之后, 高亮仍然正好圈住查询词', () => {
    const hit = hitFromMessage(
      { id: 's1', name: 'S', updatedAt: 1 },
      { id: 'm1', role: 'assistant', timestamp: 1, text: '目录里只有 `README.md` 和 `notes.md`' },
      'README',
    );
    expect(hit).not.toBeNull();
    expect(marked(hit!)).toBe('README');
    /* 预览里不该再出现反引号 */
    expect(hit!.snippet).not.toContain('`');
  });
});
