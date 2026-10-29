import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from '../Markdown';
import { PLUGIN_STORE_LINK } from '../../pages/plugins/pluginFocus';

describe('neox://plugins 链接', () => {
  it('渲染成可点的插件链接', () => {
    const html = renderToStaticMarkup(<Markdown content="商店里有 [在插件页打开 linear](neox://plugins/linear)" />);
    expect(html).toContain('href="neox://plugins/linear"');
    expect(html).toContain('md-plugin-link');
  });

  it('别的 neox:// 链接照旧清掉', () => {
    const html = renderToStaticMarkup(<Markdown content="[x](neox://oauth/callback?code=1)" />);
    expect(html).not.toContain('neox://oauth');
  });

  it('只认合法插件名', () => {
    expect(PLUGIN_STORE_LINK.exec('neox://plugins/office-kit')?.[1]).toBe('office-kit');
    expect(PLUGIN_STORE_LINK.test('neox://plugins/../etc')).toBe(false);
    expect(PLUGIN_STORE_LINK.test('neox://plugins/a b')).toBe(false);
  });
});
