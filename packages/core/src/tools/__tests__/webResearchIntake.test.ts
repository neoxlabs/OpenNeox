/**
 * 抓取层四刀 (· Deep Research 的地基)
 * ═══════════════════════════════════════════════════════════════════════════
 * 调研质量卡在入口: 搜索结果没有时间就分不清新旧, 正文被拍成纯文本就引不了原句、
 * 顺不了文中给的出处。这里锁住改过的两条纯函数, 别再退回去。
 *
 *   ① 发布时间归一化 —— 各家字段名不一样, 能解析的压成 YYYY-MM-DD, 解析不了的原样留
 *   ② HTML → markdown —— 链接必须保成 [锚文本](绝对URL), 表格按行走, 粗斜体和引用留住
 */
import { describe, expect, it } from 'vitest';
import { pickPublishedAt, htmlToReadableText } from '../webTools.js';

describe('发布时间归一化 (pickPublishedAt)', () => {
  it('ISO 时间压成 YYYY-MM-DD', () => {
    expect(pickPublishedAt({ datePublished: '2026-07-02T10:11:12Z' })).toBe('2026-07-02');
  });

  it('serper 的人话日期也能解析', () => {
    expect(pickPublishedAt({ date: 'Sep 3, 2026' })).toBe('2026-09-03');
  });

  it('相对说法解析不了就原样留 —— 对判新旧一样有用, 不许丢', () => {
    expect(pickPublishedAt({ date: '3 days ago' })).toBe('3 days ago');
  });

  it('未来时间当脏数据跳过, 落到下一个字段', () => {
    const future = new Date(Date.now() + 30 * 86_400_000).toISOString();
    expect(pickPublishedAt({ datePublished: future, dateLastCrawled: '2026-01-05T00:00:00Z' })).toBe('2026-01-05');
  });

  it('datePublished 优先于 dateLastCrawled', () => {
    expect(pickPublishedAt({ dateLastCrawled: '2026-08-08T00:00:00Z', datePublished: '2026-03-03T00:00:00Z' }))
      .toBe('2026-03-03');
  });

  it('一个都没有就是 undefined —— 不猜', () => {
    expect(pickPublishedAt({ title: 'x' })).toBeUndefined();
    expect(pickPublishedAt(undefined)).toBeUndefined();
    expect(pickPublishedAt({ date: '   ' })).toBeUndefined();
  });
});

describe('HTML → markdown (htmlToReadableText)', () => {
  it('链接保成 [锚文本](绝对URL), 相对地址按 baseUrl 解析', () => {
    const { text } = htmlToReadableText(
      '<p>见 <a href="/docs/webhooks">Webhook 文档</a> 和 <a href="https://x.dev/spec">规范</a>。</p>',
      'https://docs.example.com/guide/intro',
    );
    expect(text).toContain('[Webhook 文档](https://docs.example.com/docs/webhooks)');
    expect(text).toContain('[规范](https://x.dev/spec)');
  });

  it('没给 baseUrl 时相对链接只留锚文本, 不编绝对地址', () => {
    const { text } = htmlToReadableText('<a href="/a/b">内网页</a>');
    expect(text).toContain('内网页');
    expect(text).not.toContain('](');
  });

  it('javascript:/mailto:/锚点 只留文字', () => {
    const { text } = htmlToReadableText(
      '<a href="javascript:void(0)">展开</a><a href="#top">回顶部</a>',
      'https://e.com/',
    );
    expect(text).toContain('展开');
    expect(text).toContain('回顶部');
    expect(text).not.toContain('](');
  });

  it('表格按 markdown 行走', () => {
    const { text } = htmlToReadableText(
      '<table><tr><td>Adyen</td><td>不重试</td></tr><tr><td>Stripe</td><td>重试 8 次</td></tr></table>',
    );
    expect(text).toMatch(/\|\s*Adyen\s*\|\s*不重试/);
    expect(text).toMatch(/\|\s*Stripe\s*\|\s*重试 8 次/);
  });

  it('标题层级 / 列表 / 粗斜体 / 引用都留住', () => {
    const { text } = htmlToReadableText(
      '<h2>重试策略</h2><ul><li>4xx <strong>不重试</strong></li><li>5xx <em>会重试</em></li></ul>'
      + '<blockquote>官方文档如是说</blockquote>',
    );
    expect(text).toContain('## 重试策略');
    expect(text).toContain('- 4xx **不重试**');
    expect(text).toContain('- 5xx *会重试*');
    expect(text).toContain('> 官方文档如是说');
  });

  it('代码块保形, 不被空白折叠吃掉', () => {
    const { text } = htmlToReadableText('<pre>line1\n  line2\n</pre>');
    expect(text).toContain('```');
    expect(text).toContain('line1\n  line2');
  });

  it('标题和正文容器判定照旧', () => {
    const r = htmlToReadableText(
      '<html><head><title>选型笔记</title></head><body><nav>菜单</nav>'
      + `<main><p>${'正文内容。'.repeat(40)}</p></main></body></html>`,
    );
    expect(r.title).toBe('选型笔记');
    expect(r.usedMain).toBe(true);
    expect(r.text).not.toContain('菜单');
  });
});
