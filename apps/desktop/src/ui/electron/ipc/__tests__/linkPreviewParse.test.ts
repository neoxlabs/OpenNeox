import { describe, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, net: { fetch: vi.fn() } }));

const { parseLinkPreview } = await import('../linkPreviewHandlers');

describe('parseLinkPreview', () => {
  test('og 优先, 相对 og:image 按最终地址补全, icon 相对补全', () => {
    const html = `<html><head>
      <title>Fallback Title</title>
      <meta property="og:title" content="useSyncExternalStore &ndash; React" />
      <meta name="description" content="plain desc">
      <meta property="og:description" content="React Hook that lets you subscribe to an external store.">
      <meta content="/images/og-home.png" property="og:image">
      <link rel="icon" href="/favicon.ico">
      <meta property="og:site_name" content="react.dev">
    </head><body></body></html>`;
    const p = parseLinkPreview('https://react.dev/reference/react/useSyncExternalStore', html, 'https://react.dev/reference/react/useSyncExternalStore');
    expect(p.ok).toBe(true);
    expect(p.title).toBe('useSyncExternalStore – React');
    expect(p.description).toBe('React Hook that lets you subscribe to an external store.');
    expect(p.image).toBe('https://react.dev/images/og-home.png');
    expect(p.icon).toBe('https://react.dev/favicon.ico');
    expect(p.site).toBe('react.dev');
  });
  test('没有 og 就退到 <title> 和 meta description, 实体解码', () => {
    const p = parseLinkPreview('https://x.test/a', '<title>A &amp; B</title><meta name="description" content="hello &quot;w&quot;">');
    expect(p.title).toBe('A & B');
    expect(p.description).toBe('hello "w"');
    expect(p.image).toBeUndefined();
    expect(p.icon).toBe('https://x.test/favicon.ico');
  });
  test('og:image 是 javascript:/data: 之外的怪协议一律丢弃', () => {
    const p = parseLinkPreview('https://x.test/', '<meta property="og:image" content="javascript:alert(1)">');
    expect(p.image).toBeUndefined();
  });
});
