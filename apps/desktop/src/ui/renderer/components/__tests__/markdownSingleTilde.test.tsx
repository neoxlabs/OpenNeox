import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { markdownGfmOptions } from '../../utils/markdownGfm';

const render = (text: string): string => renderToStaticMarkup(
  <ReactMarkdown remarkPlugins={[[remarkGfm, markdownGfmOptions] as any]}>{text}</ReactMarkdown>,
);

describe('markdownGfmOptions', () => {
  it('singleTilde 关着 (Markdown.tsx 用的就是这个对象)', () => {
    expect(markdownGfmOptions.singleTilde).toBe(false);
  });

  it('「4~5 级」原样显示, 不产生 <del>', () => {
    const html = render('东南风 4~5 级，阵风 6~7 级');
    expect(html).not.toContain('<del>');
    expect(html).toContain('4~5');
    expect(html).toContain('6~7');
  });

  it('双波浪线仍然是删除线', () => {
    const html = render('这是~~删掉~~的字');
    expect(html).toContain('<del>');
    expect(html).toContain('删掉');
  });
});
