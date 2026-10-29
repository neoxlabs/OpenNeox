import { describe, expect, it } from 'vitest';
import {
  MARKDOWN_CHUNK_THRESHOLD,
  planMarkdownChunks,
  shouldChunkMarkdown,
} from '../markdownChunks';

function makeLongMarkdown(sections: number): string {
  const parts: string[] = ['# 标题\n\n'];
  for (let i = 0; i < sections; i++) {
    parts.push(`## 第 ${i} 节\n\n正文段落 ${i}，包含一些中英文 mixed content。\n\n`);
    parts.push(`| 指标 | 数值 |\n|---|---|\n| 第 ${i} 项 | ${i * 7} |\n\n`);
    parts.push('- 要点一\n- 要点二\n\n');
  }
  return parts.join('');
}

describe('planMarkdownChunks', () => {
  it('短文档不分块, 行为与改动前一致', () => {
    const md = makeLongMarkdown(5);
    expect(shouldChunkMarkdown(md)).toBe(false);
    expect(planMarkdownChunks(md)).toEqual([md]);
  });

  it('长文档分块, 且拼接后逐字等于原文', () => {
    const md = makeLongMarkdown(3000);
    expect(md.length).toBeGreaterThan(MARKDOWN_CHUNK_THRESHOLD);
    const chunks = planMarkdownChunks(md);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(md);
    for (const chunk of chunks) expect(chunk.length).toBeGreaterThan(0);
  });

  it('首块是小的, 后面的块更大', () => {
    const md = makeLongMarkdown(4000);
    const chunks = planMarkdownChunks(md);
    expect(chunks[0].length).toBeLessThan(chunks[1].length + 500);
  });

  it('不在代码围栏中间切开', () => {
    const blocks: string[] = [];
    for (let i = 0; i < 2500; i++) {
      blocks.push(`段落 ${i} 的正文内容。\n\n`);
      if (i % 10 === 0) {
        blocks.push('```js\nconst a = 1;\n\nconst b = 2;\n```\n\n');
      }
    }
    const md = blocks.join('');
    const chunks = planMarkdownChunks(md);
    for (const chunk of chunks) {
      const fences = (chunk.match(/^```/gm) || []).length;
      expect(fences % 2).toBe(0);
    }
  });

  it('带脚注定义时退回单块 (切分会改变渲染结果)', () => {
    const md = makeLongMarkdown(3000) + '\n\n[^1]: 脚注内容\n';
    expect(planMarkdownChunks(md)).toEqual([md]);
  });

  it('空内容返回空数组', () => {
    expect(planMarkdownChunks('')).toEqual([]);
  });
});
