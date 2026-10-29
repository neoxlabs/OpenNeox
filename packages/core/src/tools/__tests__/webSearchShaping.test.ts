/**
 * chat:C3-04 / C3-06 / C3-07 —— 聊天档搜索结果整形层的测试。
 *
 * 锁五件:
 *   1. 同域最多 2 条, 保持相关性顺序, 不同子域算不同来源 (C3-04);
 *   2. 单次注入 ≤1500 token (中英文都卡住, 含末尾省略提示) (C3-07);
 *   3. 3s 截止: 上游卡住时按时返回一句「换词 / 用已有信息答」, 不回 error (C3-06);
 *   4. 整形只作用于聊天档 —— Work / Code 的 web_search 一个字节不变;
 *   5. 错误 / 非 JSON / 老格式回执原样返回 (整形不吞掉「为什么搜不到」)。
 */
import { describe, expect, it, vi } from 'vitest';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { buildChatModeTools, selectToolsForTurn } from '../chatTools.js';
import {
  CHAT_SEARCH_PER_DOMAIN_LIMIT,
  CHAT_SEARCH_TIMEOUT_MS,
  CHAT_SEARCH_TOKEN_BUDGET,
  domainKeyOf,
  diversifyByDomain,
  estimateSearchTokens,
  shapeChatWebSearch,
  shapeSearchResults,
  shapeWebSearchPayload,
} from '../webSearchShaping.js';

function fakeTool(name: string, impl: (args: any) => any = () => `${name}-ok`): Tool {
  return {
    name,
    description: `${name} description`,
    parameters: { type: 'object', properties: { query: { type: 'string' } } },
    function: impl,
  };
}

/** 按 webTools.buildWebSearchResult 的结构造一份回执 (content 是给人看的, metadata 是给整形/UI 的)。 */
function searchPayload(results: Array<{ title?: string; url?: string; description?: string; published_at?: string }>): string {
  return JSON.stringify({
    type: 'contextual',
    status: 'success',
    tool: 'web_search',
    summary: `Found ${results.length} results for "q" via neox-gateway`,
    content: '原始给人看的文本 (整形层不该去解析它)',
    metadata: {
      query: 'q',
      backend: 'neox-gateway',
      result_count: results.length,
      results: results.map((r) => ({
        title: r.title ?? '标题',
        url: r.url ?? '',
        description: r.description ?? '摘要',
        published_at: r.published_at,
      })),
      images: [],
    },
  });
}

function parse(payload: string): any {
  return JSON.parse(payload);
}

const ctx = () => ({ signal: new AbortController().signal });

describe('chat:C3-04 按域名去重', () => {
  it('同一家网站的 8 个页面只留 2 条', () => {
    const hits = Array.from({ length: 8 }, (_, i) => ({ url: `https://example.com/${i}` }));
    expect(diversifyByDomain(hits)).toHaveLength(2);
  });

  it('相关性顺序不变: 只跳过超配额的那几条', () => {
    const hits = [
      { url: 'https://a.com/1' },
      { url: 'https://a.com/2' },
      { url: 'https://a.com/3' },
      { url: 'https://b.com/1' },
      { url: 'https://c.com/1' },
    ];
    expect(diversifyByDomain(hits).map((h) => h.url)).toEqual([
      'https://a.com/1',
      'https://a.com/2',
      'https://b.com/1',
      'https://c.com/1',
    ]);
  });

  it('www. / m. 前缀归一; 不同子域算不同来源', () => {
    expect(domainKeyOf('https://www.zhihu.com/q/1')).toBe('zhihu.com');
    expect(domainKeyOf('https://m.zhihu.com/q/1')).toBe('zhihu.com');
    expect(domainKeyOf('https://news.163.com/1')).toBe('news.163.com');
    expect(domainKeyOf('https://163.com/1')).toBe('163.com');
    expect(domainKeyOf('')).toBe('');
    expect(domainKeyOf('not a url')).toBe('not a url');
  });

  it('同域上限是 2 (方案验收口径)', () => {
    expect(CHAT_SEARCH_PER_DOMAIN_LIMIT).toBe(2);
  });

  it('8 条各来自不同站点时一条都不砍', () => {
    const hits = Array.from({ length: 8 }, (_, i) => ({ url: `https://site${i}.com/x` }));
    expect(diversifyByDomain(hits)).toHaveLength(8);
  });
});

describe('chat:C3-07 注入预算 ≤1500 token', () => {
  it('20 条长结果被截到预算内, 并如实说还有几条没显示', () => {
    const hits = Array.from({ length: 20 }, (_, i) => ({
      title: `标题 ${i} ${'很长的标题'.repeat(5)}`,
      url: `https://site${i}.com/a`,
      description: `摘要 ${i} ${'这是一段很长的摘要内容'.repeat(8)}`,
    }));
    const shaped = shapeSearchResults(hits);
    expect(shaped.tokens).toBeLessThanOrEqual(CHAT_SEARCH_TOKEN_BUDGET);
    expect(estimateSearchTokens(shaped.text)).toBeLessThanOrEqual(CHAT_SEARCH_TOKEN_BUDGET);
    expect(shaped.shown).toBeLessThan(hits.length);
    expect(shaped.truncated).toBe(true);
    expect(shaped.text).toContain(`还有 ${hits.length - shaped.shown} 条结果未显示`);
  });

  it('纯英文长结果同样卡在预算内', () => {
    const hits = Array.from({ length: 20 }, (_, i) => ({
      title: `title ${i} ${'very long english title '.repeat(4)}`,
      url: `https://site${i}.com/a`,
      description: `snippet ${i} ${'a fairly long english snippet body '.repeat(10)}`,
    }));
    const shaped = shapeSearchResults(hits);
    expect(estimateSearchTokens(shaped.text)).toBeLessThanOrEqual(CHAT_SEARCH_TOKEN_BUDGET);
    expect(shaped.shown).toBeLessThan(hits.length);
  });

  it('预算就是 1500 token', () => {
    expect(CHAT_SEARCH_TOKEN_BUDGET).toBe(1500);
  });

  it('结果少的时候一条不砍, 也不加省略提示', () => {
    const shaped = shapeSearchResults([
      { title: '短标题', url: 'https://a.com/1', description: '短摘要' },
    ]);
    expect(shaped.shown).toBe(1);
    expect(shaped.truncated).toBe(false);
    expect(shaped.text).not.toContain('未显示');
  });

  it('单条超长摘要也能放进预算 (截断, 不是整条丢)', () => {
    const shaped = shapeSearchResults([
      { title: '标题', url: 'https://a.com/1', description: '超长'.repeat(3000) },
    ]);
    expect(shaped.shown).toBe(1);
    expect(estimateSearchTokens(shaped.text)).toBeLessThanOrEqual(CHAT_SEARCH_TOKEN_BUDGET);
    expect(shaped.text).toContain('https://a.com/1');
  });
});

describe('shapeWebSearchPayload —— 回执整形', () => {
  it('去重 + 预算作用到 content 与 metadata.results (界面与模型看到同一批)', () => {
    const raw = searchPayload([
      ...Array.from({ length: 6 }, (_, i) => ({ url: `https://same.com/${i}` })),
      { url: 'https://other.com/1' },
    ]);
    const shaped = parse(shapeWebSearchPayload(raw));
    expect(shaped.metadata.results).toHaveLength(3); // same.com ×2 + other.com
    expect(shaped.metadata.results.filter((r: any) => r.url.startsWith('https://same.com'))).toHaveLength(2);
    expect(shaped.metadata.shaping.total).toBe(3);
    expect(shaped.metadata.shaping.per_domain_limit).toBe(2);
    expect(shaped.content).toContain('other.com');
    expect(shaped.content).not.toContain('same.com/2');
    expect(estimateSearchTokens(shaped.content)).toBeLessThanOrEqual(CHAT_SEARCH_TOKEN_BUDGET);
  });

  it('图片区保留并计入同一份预算 (Chat 找图靠这些直链)', () => {
    const raw = JSON.stringify({
      type: 'contextual',
      status: 'success',
      tool: 'web_search',
      summary: 'x',
      content: 'x',
      metadata: {
        query: 'q',
        results: [{ title: 'a', url: 'https://a.com/1', description: 'd' }],
        images: [
          { url: 'https://img.example.com/1.jpg', title: '图 1', width: 800, height: 600 },
          { url: 'https://img.example.com/2.jpg', title: '图 2', width: 400, height: 300 },
        ],
      },
    });
    const shaped = parse(shapeWebSearchPayload(raw));
    expect(shaped.content).toContain('https://img.example.com/1.jpg');
    expect(shaped.content).toContain('https://img.example.com/2.jpg');
    expect(shaped.content).toContain('https://a.com/1');
    expect(estimateSearchTokens(shaped.content)).toBeLessThanOrEqual(CHAT_SEARCH_TOKEN_BUDGET);
  });

  it('图片再多也只占预算内的一块, 不把文字结果全挤掉', () => {
    const raw = JSON.stringify({
      type: 'contextual',
      status: 'success',
      tool: 'web_search',
      summary: 'x',
      content: 'x',
      metadata: {
        query: 'q',
        results: [{ title: 'a', url: 'https://a.com/1', description: '一段够长的摘要'.repeat(3) }],
        images: Array.from({ length: 30 }, (_, i) => ({
          url: `https://img.example.com/${i}-${'x'.repeat(80)}.jpg`,
          title: '图'.repeat(30),
        })),
      },
    });
    const shaped = parse(shapeWebSearchPayload(raw));
    expect(estimateSearchTokens(shaped.content)).toBeLessThanOrEqual(CHAT_SEARCH_TOKEN_BUDGET);
    expect(shaped.content).toContain('https://a.com/1');
  });

  it('错误回执原样返回 (不吞掉「为什么搜不到」)', () => {
    const raw = JSON.stringify({ type: 'contextual', status: 'error', tool: 'web_search', content: 'x' });
    expect(shapeWebSearchPayload(raw)).toBe(raw);
  });

  it('非 JSON / 老格式原样返回', () => {
    expect(shapeWebSearchPayload('search-ok')).toBe('search-ok');
    expect(shapeWebSearchPayload(JSON.stringify({ status: 'success', content: 'x' }))).toBe(
      JSON.stringify({ status: 'success', content: 'x' }),
    );
  });
});

describe('chat:C3-06 3s 超时', () => {
  it('上游卡住时 3s 内返回一句人话, status 仍是 success (不诱导原样重试)', async () => {
    const tool = shapeChatWebSearch(
      fakeTool('web_search', () => new Promise<string>(() => {})),
      50, // 测试用短超时, 真值由下面那条断言锁住
    );
    const started = Date.now();
    const out = parse(String(await tool.function({ query: '今天金价' }, ctx())));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(out.status).toBe('success');
    expect(out.content).toContain('超时');
    expect(out.content).toContain('不要用同样的词重试');
  });

  it('真值是 3 秒', () => {
    expect(CHAT_SEARCH_TIMEOUT_MS).toBe(3000);
  });

  it('上游正常时照常整形 (不因超时层改变结果)', async () => {
    const raw = searchPayload([
      { url: 'https://same.com/1' },
      { url: 'https://same.com/2' },
      { url: 'https://same.com/3' },
    ]);
    const tool = shapeChatWebSearch(fakeTool('web_search', () => raw));
    const shaped = parse(String(await tool.function({ query: 'q' }, ctx())));
    expect(shaped.metadata.results).toHaveLength(2);
  });
});

describe('只作用于聊天档 (Work / Code 不变)', () => {
  it('聊天档拿到的 web_search 是整形过的, 非聊天档是原对象', async () => {
    const hits = Array.from({ length: 6 }, (_, i) => ({ url: `https://same.com/${i}` }));
    const raw = searchPayload(hits);
    const search = fakeTool('web_search', () => raw);

    const chatTools = buildChatModeTools([search, fakeTool('generate_image')]);
    const chatSearch = chatTools.find((t) => t.name === 'web_search')!;
    expect(chatSearch).not.toBe(search);
    const shaped = parse(String(await chatSearch.function({ query: 'q' }, ctx())));
    expect(shaped.metadata.results).toHaveLength(2);

    const workTools = selectToolsForTurn([search, fakeTool('generate_image')], false);
    expect(workTools[0]).toBe(search);
    expect(String(await workTools[0]!.function({ query: 'q' }, ctx()))).toBe(raw);
  });

  it('包装层不改变工具名 / 说明 / 参数 (工具表逐字节不变, 前缀缓存不断)', () => {
    const raw = fakeTool('web_search');
    const shaped = shapeChatWebSearch(raw);
    expect(shaped.name).toBe(raw.name);
    expect(shaped.description).toBe(raw.description);
    expect(shaped.parameters).toBe(raw.parameters);
  });
});
