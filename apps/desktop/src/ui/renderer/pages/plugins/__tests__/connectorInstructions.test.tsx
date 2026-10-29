import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { linkifyInstructions } from '../components/ConnectorPanel';

const html = (t: string) => renderToStaticMarkup(<p>{linkifyInstructions(t)}</p>);

describe('linkifyInstructions', () => {
  it('「去哪拿令牌」的网址变成可点的链接, 补上 https', () => {
    expect(html('打开 dash.cloudflare.com/profile/api-tokens → 创建令牌'))
      .toContain('<a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noreferrer">dash.cloudflare.com/profile/api-tokens</a> → 创建令牌');
  });

  it('权限名 Zone.Zone 不当成域名 (没有路径)', () => {
    expect(html('要勾 Zone.Zone 读取 + Zone.DNS 编辑')).not.toContain('<a');
  });

  it('句末标点不吃进链接', () => {
    expect(html('Open linear.app/settings/account/security. Then paste it.'))
      .toContain('href="https://linear.app/settings/account/security"');
  });
});
