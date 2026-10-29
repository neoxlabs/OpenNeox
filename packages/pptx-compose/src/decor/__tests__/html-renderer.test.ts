/**
 * 审计 F04: 没有渲染运行时时 renderHtmlToImage 曾返回 1x1 透明 PNG, 调用方当成功嵌进幻灯片。
 * 现在必须明确失败, 并把每条路为什么不行都写进错误。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('playwright-core', () => ({
  chromium: { launch: async () => { throw new Error('Executable doesn\'t exist'); } },
}));

import { HtmlRenderUnavailableError, renderHtmlToImage } from '../html-renderer.js';

const HTML = '<html><body>x</body></html>';

describe('renderHtmlToImage 无运行时', () => {
  const env = process.env.NEOX_PPTX_BRIDGE_URL;
  afterEach(() => {
    if (env === undefined) delete process.env.NEOX_PPTX_BRIDGE_URL;
    else process.env.NEOX_PPTX_BRIDGE_URL = env;
    vi.unstubAllGlobals();
  });

  it('没有桥、playwright 起不来 → 抛错, 不返回占位图', async () => {
    delete process.env.NEOX_PPTX_BRIDGE_URL;
    await expect(renderHtmlToImage(HTML, { width: 800, height: 450 }))
      .rejects.toThrow(HtmlRenderUnavailableError);
    await expect(renderHtmlToImage(HTML, { width: 800, height: 450 }))
      .rejects.toThrow(/playwright unavailable/);
  });

  it('HTTP 桥返回非 2xx → 错误里带状态码', async () => {
    process.env.NEOX_PPTX_BRIDGE_URL = 'http://127.0.0.1:9';
    vi.stubGlobal('fetch', async () => new Response('boom', { status: 502 }));
    await expect(renderHtmlToImage(HTML, { width: 800, height: 450 }))
      .rejects.toThrow(/render bridge HTTP 502/);
  });

  it('HTTP 桥连不上 → 错误里写 unreachable', async () => {
    process.env.NEOX_PPTX_BRIDGE_URL = 'http://127.0.0.1:9';
    vi.stubGlobal('fetch', async () => { throw new Error('ECONNREFUSED'); });
    await expect(renderHtmlToImage(HTML, { width: 800, height: 450 }))
      .rejects.toThrow(/render bridge unreachable: ECONNREFUSED/);
  });
});
