/**
 * work H-14: 网页调研并行抓取。
 *
 * 验收口径: 5 个 URL 的墙钟 ≤ 串行 50%。这里用假抓取器 (可控延迟) 验证调度语义,
 * 不碰网络; 真实抓取路径 (重定向 / SSRF / 重试) 复用 web_fetch 原逻辑, 另有单 URL 测试覆盖。
 */
import { describe, it, expect } from 'vitest';
import {
  WEB_FETCH_BATCH_MAX_URLS,
  WEB_FETCH_BATCH_TOTAL_CHARS,
  composeBatchOutput,
  fetchUrlsInParallel,
  normalizeFetchUrls,
  toBatchItem,
  type WebFetchBatchItem,
} from '../web/webFetchBatch.js';
import { webFetch } from '../webTools.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeItem(url: string, delayMs: number, body = `body of ${url}`): Promise<WebFetchBatchItem> {
  return sleep(delayMs).then(() => ({
    url,
    ok: true,
    summary: `Fetched ${url}`,
    content: body,
    elapsedMs: delayMs,
  }));
}

describe('normalizeFetchUrls', () => {
  it('接受 url 与 urls, 去重并保持顺序', () => {
    expect(normalizeFetchUrls({ url: 'https://a', urls: ['https://b', 'https://a', '  '] }))
      .toEqual(['https://a', 'https://b']);
  });

  it(`最多 ${WEB_FETCH_BATCH_MAX_URLS} 个`, () => {
    const urls = Array.from({ length: 12 }, (_, i) => `https://x/${i}`);
    expect(normalizeFetchUrls({ urls })).toHaveLength(WEB_FETCH_BATCH_MAX_URLS);
  });

  it('空输入返回空数组', () => {
    expect(normalizeFetchUrls({})).toEqual([]);
    expect(normalizeFetchUrls({ urls: [1, null, ''] })).toEqual([]);
  });
});

describe('fetchUrlsInParallel', () => {
  it('5 个 URL 并行: 墙钟 ≤ 串行的 50%', async () => {
    const urls = Array.from({ length: 5 }, (_, i) => `https://site/${i}`);
    const serialMs = 5 * 60;
    const started = Date.now();
    const { items, elapsedMs } = await fetchUrlsInParallel(urls, (u) => fakeItem(u, 60));
    const wall = Date.now() - started;

    expect(items.map((i) => i.url)).toEqual(urls); // 顺序保持
    expect(items.every((i) => i.ok)).toBe(true);
    expect(elapsedMs).toBeLessThan(serialMs * 0.5);
    expect(wall).toBeLessThan(serialMs * 0.5);
  });

  it('并发上限生效: 12 个任务在并发 5 下分 3 轮', async () => {
    const urls = Array.from({ length: 12 }, (_, i) => `https://site/${i}`);
    const started = Date.now();
    const { items } = await fetchUrlsInParallel(urls, (u) => fakeItem(u, 40), { concurrency: 5 });
    const wall = Date.now() - started;

    expect(items).toHaveLength(12);
    expect(wall).toBeLessThan(40 * 3 * 2); // 3 轮 × 40ms, 留足余量
  });

  it('单个 URL 卡住不拖垮整批: 超时后标记失败并继续', async () => {
    const urls = ['https://slow', 'https://fast'];
    const started = Date.now();
    const { items } = await fetchUrlsInParallel(
      urls,
      (u) => (u === 'https://slow' ? sleep(5000).then(() => fakeItem(u, 0)) : fakeItem(u, 10)),
      { perUrlTimeoutMs: 80 },
    );
    const wall = Date.now() - started;

    expect(wall).toBeLessThan(1000);
    expect(items[0]!.ok).toBe(false);
    expect(items[0]!.timedOut).toBe(true);
    expect(items[1]!.ok).toBe(true);
  });

  it('空列表直接返回', async () => {
    const { items, elapsedMs } = await fetchUrlsInParallel([], (u) => fakeItem(u, 10));
    expect(items).toEqual([]);
    expect(elapsedMs).toBeGreaterThanOrEqual(0);
  });
});

describe('toBatchItem', () => {
  it('解析 web_fetch 的 contextual 结果', () => {
    const raw = JSON.stringify({ status: 'success', summary: 'Fetched a', content: 'hello' });
    expect(toBatchItem('https://a', raw, 12)).toMatchObject({
      url: 'https://a', ok: true, summary: 'Fetched a', content: 'hello', elapsedMs: 12,
    });
  });

  it('error 结果标失败, 不可解析也标失败', () => {
    expect(toBatchItem('https://a', JSON.stringify({ status: 'error', summary: 'bad url' }), 1).ok).toBe(false);
    expect(toBatchItem('https://a', 'not json', 1).ok).toBe(false);
  });
});

describe('web_fetch 工具接线 (urls 参数)', () => {
  const urls = ['https://a.example', 'https://b.example', 'https://c.example', 'https://d.example', 'https://e.example'];

  /** 把单 URL 抓取换掉, 不碰网络; 批处理分支内部调的正是 webFetch.function。 */
  async function withFakeFetcher<T>(fn: (calls: string[], original: any) => Promise<T>): Promise<T> {
    const original = (webFetch as any).function;
    const calls: string[] = [];
    (webFetch as any).function = async ({ url }: any) => {
      calls.push(url);
      await sleep(60);
      return JSON.stringify({ status: 'success', summary: `Fetched ${url}`, content: `body ${url}` });
    };
    try {
      return await fn(calls, original);
    } finally {
      (webFetch as any).function = original;
    }
  }

  it('5 个 URL 一次调用并行抓完, 墙钟 ≤ 串行的 50%', async () => {
    await withFakeFetcher(async (calls, original) => {
      const started = Date.now();
      const raw = await original({ urls });
      const wall = Date.now() - started;
      const parsed = JSON.parse(String(raw));

      expect(wall).toBeLessThan(5 * 60 * 0.5);
      expect(calls.sort()).toEqual([...urls].sort());
      expect(parsed.status).toBe('success');
      expect(parsed.summary).toContain('成功 5');
      expect(parsed.content).toContain('[1/5]');
      for (const u of urls) expect(parsed.content).toContain(u);
    });
  });

  it('url 和 urls 都没给时报错, 不发起抓取', async () => {
    await withFakeFetcher(async (calls, original) => {
      const raw = await original({});
      const parsed = JSON.parse(String(raw));

      expect(calls).toEqual([]);
      expect(parsed.status).toBe('error');
    });
  });
});

describe('composeBatchOutput', () => {
  const items: WebFetchBatchItem[] = [
    { url: 'https://a', ok: true, summary: 'ok a', content: 'A'.repeat(100), elapsedMs: 2000 },
    { url: 'https://b', ok: false, summary: '没有拿到内容 (HTTP 404)', content: '', elapsedMs: 1000 },
  ];

  it('头部给成功数/并发/墙钟与串行对照, 正文按 URL 分段', () => {
    const out = composeBatchOutput(items, { elapsedMs: 2000, concurrency: 5 });
    expect(out.summary).toContain('成功 1');
    expect(out.summary).toContain('失败 1');
    expect(out.content).toContain('并行抓取 2 个 URL');
    expect(out.content).toContain('(逐个抓约 3.0s)');
    expect(out.content).toContain('[1/2] ✓ https://a');
    expect(out.content).toContain('[2/2] ✗ https://b');
    expect(out.content).toContain('A'.repeat(100));
    expect(out.trimmedCount).toBe(0);
  });

  it('总字符预算: 超出部分截断并提示单独抓', () => {
    const big: WebFetchBatchItem[] = [
      { url: 'https://a', ok: true, summary: 'ok', content: 'A'.repeat(100), elapsedMs: 10 },
      { url: 'https://b', ok: true, summary: 'ok', content: 'B'.repeat(100), elapsedMs: 10 },
    ];
    const out = composeBatchOutput(big, { elapsedMs: 10, totalChars: 150 });
    expect(out.trimmedCount).toBe(1);
    expect(out.content).toContain('整批正文已到预算上限');
    expect(out.content.length).toBeLessThan(WEB_FETCH_BATCH_TOTAL_CHARS);
  });
});
