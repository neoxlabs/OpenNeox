/**
 * 插件卡片 / 详情页上的**平台声明** —— 真实渲染断言, 不是扫源码文本。
 *
 * ─── 为什么必须渲一遍 ────────────────────────────────────────────────────────
 * 逻辑层 (plugin-platform.ts / installFromPath) 早就有单测了, 但"逻辑对"和"页面上
 * 真写着这行字"是两件事 —— 卡片里那个 chip 挂在 `{platforms && ...}` 上, 一个条件
 * 写反就整块不渲染, 而逻辑测试全绿。
 *
 * 断言用的是**用户看得见的文字**(去掉标签后)'仅 macOS' / '不支持当前系统',
 * 以及安装按钮上那个 disabled —— 类名在不在跟"用户能不能点"没关系。
 *
 * 用 renderToStaticMarkup: 仓库 environment 是 'node' 且没有 jsdom, 这几条断言只
 * 关心输出文本 (同 askSettledRender.test.tsx 的做法)。navigator 是 stub 出来的,
 * 所以这两条用例在任何开发机上结论一致 (不会"在 mac 上过、在 win 上红")。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PluginCard } from '../components/PluginCard.js';
import { PluginDetail } from '../components/PluginDetail.js';

/** mac-only 的 computer-use —— 市场上是嵌在 manifest 里的那种形状 */
const MARKET_PLUGIN = {
  name: 'computer-use',
  version: '0.1.0',
  description: '桌面操作',
  author: { name: 'Neox' },
  category: 'productivity',
  keywords: [],
  downloads: 0,
  rating: 0,
  ratingCount: 0,
  publishedAt: '2026-09-14T00:00:00.000Z',
  source: { type: 'marketplace', registry: 'https://example.com' },
  manifest: { platform: ['darwin'] },
};

/** 本机装的 / 目录导入的插件, platform 在顶层 */
const LOCAL_MAC_PLUGIN = { ...MARKET_PLUGIN, manifest: undefined, platform: ['darwin'] };
const NO_PLATFORM_PLUGIN = { ...MARKET_PLUGIN, manifest: {} };

function onHost(platform: string): void {
  /* 用真实的 navigator.platform 取值: Win32 / MacIntel */
  vi.stubGlobal('navigator', { platform, userAgent: platform });
}

afterEach(() => { vi.unstubAllGlobals(); });

/** 只取用户看得见的文字 —— 去掉标签顺带去掉 title 这类悬浮才可见的属性 */
const visible = (html: string) => html.replace(/<[^>]+>/g, ' ');

function card(plugin: Record<string, unknown>, isZh = true): string {
  return renderToStaticMarkup(React.createElement(PluginCard, { plugin, isZh } as never));
}

function detail(plugin: Record<string, unknown>): string {
  return renderToStaticMarkup(React.createElement(PluginDetail, { plugin } as never));
}

/** 自检: 这些组件确实渲染出了东西, 免得下面在空串上平凡通过 */
describe('自检', () => {
  it('卡片和详情页都渲染出了内容', () => {
    onHost('Win32');
    expect(card(MARKET_PLUGIN).length).toBeGreaterThan(200);
    expect(detail(MARKET_PLUGIN).length).toBeGreaterThan(200);
  });
});

describe('插件卡片 (市场页那一格)', () => {
  it('Windows 上: 写清「仅 macOS」, 安装按钮禁用且不再写「安装」', () => {
    onHost('Win32');
    const html = card(MARKET_PLUGIN);
    const text = visible(html);
    expect(text).toContain('仅 macOS');
    expect(text).toContain('不支持当前系统');
    expect(html).toContain('is-warn');
    /* 按钮上真带 disabled —— 灰是渲染出来的, 不是我们自己嘴说的 */
    expect(html).toMatch(/<button[^>]*neox-plugin-card__install[^>]*disabled/);
  });

  it('mac 上: 同一个插件是普通 chip, 按钮可点', () => {
    onHost('MacIntel');
    const html = card(MARKET_PLUGIN);
    const text = visible(html);
    expect(text).toContain('macOS');
    expect(text).not.toContain('仅 macOS');
    expect(html).not.toContain('is-warn');
    expect(html).not.toMatch(/<button[^>]*neox-plugin-card__install[^>]*disabled/);
  });

  it('本机/目录装的插件 (platform 在顶层) 一样认得出', () => {
    onHost('Win32');
    expect(visible(card(LOCAL_MAC_PLUGIN))).toContain('仅 macOS');
  });

  it('没声明 platform 的插件: 一个平台 chip 都不出 (不能因为没写就标成不支持)', () => {
    onHost('Win32');
    const text = visible(card(NO_PLATFORM_PLUGIN));
    expect(text).not.toContain('macOS');
    expect(text).not.toContain('不支持当前系统');
    expect(card(NO_PLATFORM_PLUGIN)).not.toContain('is-warn');
  });
});

describe('插件详情页', () => {
  it('Windows 上: 信息栏有「支持平台 = macOS」, 安装按钮禁用并说明原因', () => {
    onHost('Win32');
    const html = detail(MARKET_PLUGIN);
    const text = visible(html);
    expect(text).toContain('支持平台');
    expect(text).toContain('macOS');
    expect(text).toContain('这个插件不支持当前系统');
    expect(html).toMatch(/<button[^>]*is-primary[^>]*disabled/);
  });

  it('mac 上: 正常显示可点的安装按钮', () => {
    onHost('MacIntel');
    const html = detail(MARKET_PLUGIN);
    expect(html).toMatch(/<button[^>]*npd-get[^>]*>安装<\/button>/);
    expect(html).not.toMatch(/<button[^>]*npd-get[^>]*disabled/);
    expect(visible(html)).toContain('v0.1.0');
    expect(visible(html)).not.toContain('这个插件不支持当前系统');
  });
});
