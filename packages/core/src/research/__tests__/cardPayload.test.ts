import { describe, expect, it } from 'vitest';
import { buildCardPayload, enforceBudget } from '../cardPayload.js';
import { computeClaimStatus, type ResearchLedger, type LedgerStats } from '../ledger.js';

const stats: LedgerStats = {
  sources: 20, domains: 10, claims: 25,
  supported: 0, singleSource: 23, disputed: 2, unverified: 0,
  archivedChars: 422_753,
};

function mkLedger(over: Partial<ResearchLedger> = {}): ResearchLedger {
  return {
    topic: 't', slug: 't', startedAt: '2026-09-12T00:00:00Z', updatedAt: '2026-09-12T00:00:00Z',
    sources: [], claims: [], ...over,
  };
}

const src = (n: number, host: string) => ({
  sid: `S${n}`, url: `https://${host}/${n}`, title: `T${n}`, hostname: host,
  kind: 'unknown' as const, fetchedAt: '2026-09-12T00:00:00Z', archivePath: `archive/S${n}.md`, chars: 9000,
});

const dispute = (n: number, textLen = 40, quoteLen = 200) => ({
  cid: `C${n}`,
  text: '结'.repeat(textLen),
  support: [{ sid: 'S1', quote: 'a'.repeat(quoteLen) }],
  contradict: [{ sid: 'S2', quote: 'b'.repeat(quoteLen) }],
  status: computeClaimStatus([{ sid: 'S1', quote: 'x' }], [{ sid: 'S2', quote: 'y' }]),
  lean: '倾'.repeat(60),
});

const base = {
  topic: '题目', scale: 'compare', stats, stopReason: 'converged', dispatched: 4,
  leaderModel: 'deepseek-v4-pro', workerModel: 'deepseek-v4-flash', modelKind: 'subscription',
  reportPath: '/tmp/x/report.md', unexplored: [] as string[],
};

describe('控量', () => {
  it('正常规模的载荷远小于宿主的 12000 闸', () => {
    const ledger = mkLedger({
      sources: Array.from({ length: 20 }, (_, i) => src(i + 1, `site${i % 10}.com`)),
      claims: [dispute(1), dispute(2)] as any,
    });
    const p = buildCardPayload({ ...base, ledger, unexplored: ['没查完的线索 A', '没查完的线索 B'] });
    expect(JSON.stringify(p).length).toBeLessThan(6000);
  });

  it('账本再大, 载荷也不许超预算 —— 超了整张卡会消失', () => {
    const ledger = mkLedger({
      sources: Array.from({ length: 200 }, (_, i) => src(i + 1, `very-long-domain-name-${i}.example.com`)),
      claims: Array.from({ length: 50 }, (_, i) => dispute(i + 1, 200, 4000)) as any,
    });
    const p = buildCardPayload({
      ...base, ledger,
      unexplored: Array.from({ length: 30 }, (_, i) => `很长的没查完线索 ${'x'.repeat(300)} ${i}`),
    });
    expect(JSON.stringify(p).length).toBeLessThanOrEqual(5200);
  });

  it('正常路径下兜底根本不该被触发 —— 单项上限已经把载荷压得很小', () => {
    const ledger = mkLedger({
      sources: Array.from({ length: 200 }, (_, i) => src(i + 1, `d${i}-${'y'.repeat(40)}.com`)),
      claims: Array.from({ length: 50 }, (_, i) => dispute(i + 1, 200, 4000)) as any,
    });
    const p = buildCardPayload({
      ...base, ledger,
      unexplored: Array.from({ length: 30 }, (_, i) => `线索 ${'x'.repeat(300)} ${i}`),
    });
    /* 极端输入下仍然远低于预算, 所以该留的都留着 */
    expect(JSON.stringify(p).length).toBeLessThanOrEqual(5200);
    expect(p.disputes).toHaveLength(3);
    expect(p.unexplored).toHaveLength(3);
    expect(p.domains).toHaveLength(8);
    /* 统计数字永远留着 —— 它是这张卡的骨架 */
    expect(p.stats.disputed).toBe(2);
    expect(p.stats.sources).toBe(20);
  });

  it('兜底真被触发时, 砍的顺序是: 没查完的 → 站点名单 → 分歧 (至少留一条)', () => {
    /* 直接喂一个超大的载荷 —— 走 buildCardPayload 是进不来这条路的 (上限已经拦住了),
     * 这里测的是"哪天有人放宽了上限"时的最坏情况行为。 */
    const fat = enforceBudget({
      topic: '题'.repeat(40),
      scale: 'deep',
      stats,
      stopReason: 'time-budget',
      dispatched: 30,
      leaderModel: 'm', workerModel: 'm', modelKind: 'byok',
      reportPath: '/tmp/report.md',
      domains: Array.from({ length: 60 }, (_, i) => `site-${'d'.repeat(60)}-${i}.com`),
      disputes: Array.from({ length: 12 }, (_, i) => ({
        cid: `C${i}`,
        text: '结'.repeat(300),
        support: { sid: 'S1', host: 'a.com', quote: 'q'.repeat(1200) },
        contradict: { sid: 'S2', host: 'b.com', quote: 'w'.repeat(1200) },
        lean: '倾'.repeat(300),
      })),
      unexplored: Array.from({ length: 40 }, (_, i) => `线索${'x'.repeat(200)}${i}`),
    });

    expect(JSON.stringify(fat).length).toBeLessThanOrEqual(5200);
    expect(fat.unexplored).toHaveLength(0);
    expect(fat.domains).toHaveLength(0);
    /* "有分歧"这件事本身最该被看见, 所以至少留一条 */
    expect(fat.disputes.length).toBeGreaterThanOrEqual(1);
    expect(fat.stats.sources).toBe(20);
  });
});

describe('内容', () => {
  it('分歧带两边原话和出处站点', () => {
    const ledger = mkLedger({
      sources: [src(1, 'docs.adyen.com'), src(2, 'blog.example.com')],
      claims: [dispute(1, 10, 30)] as any,
    });
    const p = buildCardPayload({ ...base, ledger });
    expect(p.disputes[0].support.host).toBe('docs.adyen.com');
    expect(p.disputes[0].contradict.host).toBe('blog.example.com');
    expect(p.disputes[0].support.quote.length).toBeGreaterThan(0);
    expect(p.disputes[0].lean).toBeTruthy();
  });

  it('最多列 3 条分歧 —— 卡片是回执不是文档', () => {
    const ledger = mkLedger({
      sources: [src(1, 'a.com'), src(2, 'b.com')],
      claims: Array.from({ length: 9 }, (_, i) => dispute(i + 1, 10, 30)) as any,
    });
    expect(buildCardPayload({ ...base, ledger }).disputes).toHaveLength(3);
  });

  it('站点去重且封顶 8 个', () => {
    const ledger = mkLedger({
      sources: [...Array.from({ length: 30 }, (_, i) => src(i + 1, `s${i % 12}.com`))],
    });
    const p = buildCardPayload({ ...base, ledger });
    expect(p.domains).toHaveLength(8);
    expect(new Set(p.domains).size).toBe(8);
  });

  it('没有分歧时是空数组, 不是 undefined', () => {
    const p = buildCardPayload({ ...base, ledger: mkLedger() });
    expect(p.disputes).toEqual([]);
    expect(p.domains).toEqual([]);
  });
});
