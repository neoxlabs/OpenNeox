/**
 * research_record —— worker 的唯一产出口
 * ═══════════════════════════════════════════════════════════════════════════
 * 这是整个 Deep Research 的闸所在, 锁住:
 *   · 抓取归档由**工具**做, 不由模型自称 (它说它读了但其实没读的空子在这儿堵上)
 *   · 引句编的 → 整条拒绝, 并把哪句不对说清楚 (这不是报错, 是让它回去原样复制)
 *   · 两个来源打架 → disputed, 两边都留
 *   · 滑动窗口下的并发写不丢 (load→改→save 要串行)
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'node:os';
import path from 'node:path';

const PAGES: Record<string, string> = {
  'https://docs.adyen.com/w': 'Webhooks returning 4xx are not retried by design. 5xx are retried.',
  'https://blog.example.com/p': '所有失败的 webhook 都会重试最多 8 次, 包括 4xx 的情况。',
  'https://lab.example.org/t': 'We confirmed in testing that 4xx responses are never retried.',
};

vi.mock('../../tools/webTools.js', () => ({
  webFetch: {
    name: 'web_fetch',
    description: 'mocked',
    parameters: { type: 'object', properties: {} },
    async function({ url }: { url: string }) {
      const content = PAGES[url];
      return JSON.stringify(content
        ? { status: 'success', content, metadata: { page_title: `T:${url}`, fetched_at: '2026-09-12T00:00:00Z' } }
        : { status: 'success', content: '', error: '抓不到', metadata: {} });
    },
  },
}));

const { createResearchRecordTool } = await import('../recordTool.js');
const { createLedger, loadLedger } = await import('../ledger.js');

let workDir: string;
let slug: string;
let tool: ReturnType<typeof createResearchRecordTool>;

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neox-rec-'));
  slug = (await createLedger(workDir, 'webhook 重试策略')).slug;
  tool = createResearchRecordTool({ workDir });
});
afterEach(async () => { await fs.rm(workDir, { recursive: true, force: true }); });

const call = async (args: any) => JSON.parse(String(await (tool.function as any)(args, {})));

describe('入账', () => {
  it('引句能对上 → 入账, 原文自动归档', async () => {
    const out = await call({
      slug,
      source_kind: 'vendor',
      claims: [{
        text: 'Adyen 的 webhook 不重试 4xx',
        support: [{ url: 'https://docs.adyen.com/w', quote: 'Webhooks returning 4xx are not retried by design.', loc: '§Webhooks' }],
      }],
    });
    expect(out.status).toBe('success');
    expect(out.metadata.accepted).toBe(1);

    const led = (await loadLedger(workDir, slug))!;
    expect(led.sources).toHaveLength(1);
    expect(led.sources[0].kind).toBe('vendor');
    expect(led.sources[0].fetchedAt).toBe('2026-09-12T00:00:00Z');
    expect(led.claims[0].status).toBe('single-source');
    /* 归档的就是校验用的那一份 */
    const archive = await fs.readFile(path.join(workDir, '.neox', 'research', slug, led.sources[0].archivePath), 'utf-8');
    expect(archive).toBe(PAGES['https://docs.adyen.com/w']);
  });

  it('两个来源支持 → supported', async () => {
    const out = await call({
      slug,
      claims: [{
        text: '4xx 不重试',
        support: [
          { url: 'https://docs.adyen.com/w', quote: 'Webhooks returning 4xx are not retried by design.' },
          { url: 'https://lab.example.org/t', quote: '4xx responses are never retried' },
        ],
      }],
    });
    expect(out.status).toBe('success');
    expect((await loadLedger(workDir, slug))!.claims[0].status).toBe('supported');
  });

  it('来源打架 → disputed, 两边都留', async () => {
    await call({
      slug,
      claims: [{
        text: '4xx 会不会重试',
        support: [{ url: 'https://docs.adyen.com/w', quote: 'Webhooks returning 4xx are not retried by design.' }],
        contradict: [{ url: 'https://blog.example.com/p', quote: '所有失败的 webhook 都会重试最多 8 次' }],
        lean: '官方文档更可信',
      }],
    });
    const c = (await loadLedger(workDir, slug))!.claims[0];
    expect(c.status).toBe('disputed');
    expect(c.support).toHaveLength(1);
    expect(c.contradict).toHaveLength(1);
    expect(c.lean).toBe('官方文档更可信');
  });
});

describe('闸', () => {
  it('引句是编的 → 整条拒绝, 什么都不入账', async () => {
    const out = await call({
      slug,
      claims: [{ text: '随便一个结论', support: [{ url: 'https://docs.adyen.com/w', quote: 'Adyen retries everything forever.' }] }],
    });
    expect(out.status).toBe('error');
    expect(out.precondition).toBe(true);
    expect(String(out.error)).toContain('原样复制');
    expect((await loadLedger(workDir, slug))!.claims).toHaveLength(0);
  });

  it('转述也拒 —— 意思对不算数', async () => {
    const out = await call({
      slug,
      claims: [{ text: 'x', support: [{ url: 'https://docs.adyen.com/w', quote: 'Adyen 对 4xx 不会重试' }] }],
    });
    expect(out.status).toBe('error');
  });

  it('抓不到的来源如实报出来', async () => {
    const out = await call({
      slug,
      claims: [{ text: 'x', support: [{ url: 'https://nope.example.com/x', quote: '这页根本抓不到内容' }] }],
    });
    expect(out.status).toBe('error');
    expect(String(out.error)).toContain('nope.example.com');
  });

  it('一条好一条坏 → 好的那条照样入账, 坏的点名', async () => {
    const out = await call({
      slug,
      claims: [
        { text: '好的', support: [{ url: 'https://docs.adyen.com/w', quote: 'Webhooks returning 4xx are not retried by design.' }] },
        { text: '坏的', support: [{ url: 'https://docs.adyen.com/w', quote: '原文里没有这句话存在过' }] },
      ],
    });
    expect(out.status).toBe('success');
    expect(out.metadata.accepted).toBe(1);
    expect(out.metadata.rejected).toBe(1);
    expect((await loadLedger(workDir, slug))!.claims).toHaveLength(1);
  });

  it('账本不存在 / 没给 slug 都按前置条件回', async () => {
    expect((await call({ slug: 'no-such', claims: [{ text: 'x', support: [] }] })).precondition).toBe(true);
    expect((await call({ claims: [] })).precondition).toBe(true);
  });
});

describe('并发写不丢 (滑动窗口下必然发生)', () => {
  it('三个 worker 同时记, 三条都在', async () => {
    const quotes = [
      { url: 'https://docs.adyen.com/w', quote: 'Webhooks returning 4xx are not retried by design.' },
      { url: 'https://blog.example.com/p', quote: '所有失败的 webhook 都会重试最多 8 次' },
      { url: 'https://lab.example.org/t', quote: '4xx responses are never retried' },
    ];
    await Promise.all(quotes.map((q, i) => call({ slug, claims: [{ text: `结论 ${i}`, support: [q] }] })));

    const led = (await loadLedger(workDir, slug))!;
    expect(led.claims).toHaveLength(3);
    expect(led.sources).toHaveLength(3);
    /* 编号不许撞 */
    expect(new Set(led.claims.map((c) => c.cid)).size).toBe(3);
    expect(new Set(led.sources.map((s) => s.sid)).size).toBe(3);
  });

  it('同一个 URL 被两个 worker 同时引用只登记一次', async () => {
    const q = { url: 'https://docs.adyen.com/w', quote: 'Webhooks returning 4xx are not retried by design.' };
    await Promise.all([
      call({ slug, claims: [{ text: 'A', support: [q] }] }),
      call({ slug, claims: [{ text: 'B', support: [q] }] }),
    ]);
    const led = (await loadLedger(workDir, slug))!;
    expect(led.sources).toHaveLength(1);
    expect(led.claims).toHaveLength(2);
  });
});
