import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  slugifyTopic, createLedger, loadLedger, addSource, addClaim, readArchive,
  verifyQuote, normalizeForQuoteMatch, computeClaimStatus, ledgerStats, researchDir,
  MIN_QUOTE_CHARS,
} from '../ledger.js';

let workDir: string;

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neox-ledger-'));
});
afterEach(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

const ADYEN_DOC = `# Webhooks

Adyen sends each webhook once. **Webhooks returning 4xx are not retried.**
For 5xx we retry with exponential backoff, up to 8 attempts.
`;

describe('引句校验', () => {
  it('原样复制的一段能过', () => {
    expect(verifyQuote(ADYEN_DOC, 'Webhooks returning 4xx are not retried.').ok).toBe(true);
  });

  it('空白差异不影响 —— 换行/多空格都归一', () => {
    expect(verifyQuote(ADYEN_DOC, 'Webhooks   returning 4xx\n are not retried.').ok).toBe(true);
  });

  it('原文里的 markdown 强调符号不算差异', () => {
    /* 原文是 **...not retried.**, 引句没带星号 */
    expect(verifyQuote(ADYEN_DOC, 'are not retried').ok).toBe(true);
  });

  it('全角引号/破折号折成半角再比', () => {
    const src = '官方说法是“不重试”——这一点没有例外。';
    expect(verifyQuote(src, '官方说法是"不重试"--这一点没有例外。').ok).toBe(true);
  });

  it('转述的一律拒 —— 意思对也不行', () => {
    const r = verifyQuote(ADYEN_DOC, 'Adyen 对 4xx 的 webhook 不会重试');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('找不到');
  });

  it('太短的引句拒掉 (短句在任何文档里都能命中)', () => {
    const r = verifyQuote(ADYEN_DOC, 'not');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain(String(MIN_QUOTE_CHARS));
  });

  it('归一化不做同义改写 —— 只压空白/符号/大小写', () => {
    expect(normalizeForQuoteMatch('  **Foo**   BAR\n')).toBe('foo bar');
  });
});

describe('来源登记', () => {
  it('落归档 + 编号 + 能读回来', async () => {
    const ledger = await createLedger(workDir, 'Adyen vs Stripe 选型');
    const s = await addSource(workDir, ledger, {
      url: 'https://docs.adyen.com/webhooks',
      title: 'Adyen Webhooks',
      content: ADYEN_DOC,
      publishedAt: '2026-07-02',
    });
    expect(s.sid).toBe('S1');
    expect(s.hostname).toBe('docs.adyen.com');
    expect(s.publishedAt).toBe('2026-07-02');
    expect(await readArchive(workDir, ledger, 'S1')).toBe(ADYEN_DOC);
    const onDisk = await fs.readFile(path.join(researchDir(workDir, ledger.slug), s.archivePath), 'utf-8');
    expect(onDisk).toBe(ADYEN_DOC);
  });

  it('同一个 URL 只登记一次 —— 否则"几个独立来源"会失真', async () => {
    const ledger = await createLedger(workDir, 't');
    const a = await addSource(workDir, ledger, { url: 'https://x.dev/a', title: 'A', content: ADYEN_DOC });
    const b = await addSource(workDir, ledger, { url: 'https://x.dev/a', title: 'A 又抓了一次', content: '完全不同的内容' });
    expect(b.sid).toBe(a.sid);
    expect(ledger.sources).toHaveLength(1);
    expect(await readArchive(workDir, ledger, 'S1')).toBe(ADYEN_DOC);
  });

  it('存了能重新加载回来', async () => {
    const ledger = await createLedger(workDir, '选型笔记');
    await addSource(workDir, ledger, { url: 'https://x.dev/a', title: 'A', content: ADYEN_DOC });
    const again = await loadLedger(workDir, ledger.slug);
    expect(again?.sources).toHaveLength(1);
    expect(again?.topic).toBe('选型笔记');
  });

  it('账本结构坏了当读不出来, 不当空账本', async () => {
    const ledger = await createLedger(workDir, 't');
    await fs.writeFile(path.join(researchDir(workDir, ledger.slug), 'ledger.json'), '{"topic":"t"}', 'utf-8');
    expect(await loadLedger(workDir, ledger.slug)).toBeNull();
  });
});

describe('结论入账', () => {
  const seed = async () => {
    const ledger = await createLedger(workDir, 't');
    await addSource(workDir, ledger, { url: 'https://docs.adyen.com/w', title: 'Adyen 官方', content: ADYEN_DOC, kind: 'vendor' });
    await addSource(workDir, ledger, {
      url: 'https://blog.example.com/p',
      title: '三年前的博客',
      content: '所有失败的 webhook 都会重试最多 8 次, 包括 4xx。',
      kind: 'secondary',
    });
    return ledger;
  };

  it('引句能命中 → 入账, 单来源标 single-source', async () => {
    const ledger = await seed();
    const r = await addClaim(workDir, ledger, {
      text: 'Adyen 的 webhook 默认不重试 4xx',
      support: [{ sid: 'S1', quote: 'Webhooks returning 4xx are not retried.', loc: '§Webhooks' }],
    });
    expect(r.ok).toBe(true);
    expect(r.claim?.cid).toBe('C1');
    expect(r.claim?.status).toBe('single-source');
  });

  it('引句编的 → 整条拒绝, 并说清为什么', async () => {
    const ledger = await seed();
    const r = await addClaim(workDir, ledger, {
      text: '随便一个结论',
      support: [{ sid: 'S1', quote: 'Adyen retries every webhook forever and ever.' }],
    });
    expect(r.ok).toBe(false);
    expect(ledger.claims).toHaveLength(0);
    expect(r.rejected?.[0].reason).toContain('找不到');
  });

  it('一条坏引句拖垮整条 —— 不许留下好的那半', async () => {
    const ledger = await seed();
    const r = await addClaim(workDir, ledger, {
      text: '混着真假证据的结论',
      support: [
        { sid: 'S1', quote: 'Webhooks returning 4xx are not retried.' },
        { sid: 'S2', quote: '这句话原文里根本没有出现过。' },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.rejected).toHaveLength(1);
    expect(ledger.claims).toHaveLength(0);
  });

  it('来源号不存在也拒', async () => {
    const ledger = await seed();
    const r = await addClaim(workDir, ledger, {
      text: 'x',
      support: [{ sid: 'S99', quote: 'Webhooks returning 4xx are not retried.' }],
    });
    expect(r.ok).toBe(false);
    expect(r.rejected?.[0].reason).toContain('S99');
  });

  it('拿到反证 → disputed, 两边证据都留着', async () => {
    const ledger = await seed();
    const r = await addClaim(workDir, ledger, {
      text: 'Adyen 的 webhook 默认不重试 4xx',
      support: [{ sid: 'S1', quote: 'Webhooks returning 4xx are not retried.' }],
      contradict: [{ sid: 'S2', quote: '所有失败的 webhook 都会重试最多 8 次' }],
      lean: 'S1 是厂商官方文档, S2 是三年前的博客 —— 倾向 S1',
    });
    expect(r.ok).toBe(true);
    expect(r.claim?.status).toBe('disputed');
    expect(r.claim?.support).toHaveLength(1);
    expect(r.claim?.contradict).toHaveLength(1);
    expect(r.claim?.lean).toContain('倾向 S1');
  });
});

describe('同源自辩 ≠ 两家打架 (2026-09-12 真机发现)', () => {
  const seed = async () => {
    const ledger = await createLedger(workDir, 't');
    await addSource(workDir, ledger, {
      url: 'https://paper.example/p', title: '论文',
      content: 'Bun consumed more memory than Node.js. This result contrasts with findings by F. Ahmod.',
    });
    await addSource(workDir, ledger, { url: 'https://blog.example/b', title: '博客', content: BLOG_TEXT });
    return ledger;
  };
  const BLOG_TEXT = 'Bun 的内存占用明显低于 Node.js。';

  it('反证来自别的来源 → crossSource true', async () => {
    const ledger = await seed();
    const r = await addClaim(workDir, ledger, {
      text: 'Bun 内存占用更高',
      support: [{ sid: 'S1', quote: 'Bun consumed more memory than Node.js.' }],
      contradict: [{ sid: 'S2', quote: 'Bun 的内存占用明显低于 Node.js。' }],
    });
    expect(r.claim?.status).toBe('disputed');
    expect(r.claim?.crossSource).toBe(true);
  });

  it('支持和反对都来自同一份文档 → crossSource false', async () => {
    const ledger = await seed();
    const r = await addClaim(workDir, ledger, {
      text: 'Bun 内存占用更高',
      support: [{ sid: 'S1', quote: 'Bun consumed more memory than Node.js.' }],
      contradict: [{ sid: 'S1', quote: 'This result contrasts with findings by F. Ahmod.' }],
    });
    expect(r.claim?.status).toBe('disputed');
    expect(r.claim?.crossSource).toBe(false);
  });

  it('没有反证时不写这个字段 —— 它只在有分歧时才有意义', async () => {
    const ledger = await seed();
    const r = await addClaim(workDir, ledger, {
      text: 'x',
      support: [{ sid: 'S1', quote: 'Bun consumed more memory than Node.js.' }],
    });
    expect(r.claim?.crossSource).toBeUndefined();
  });
});

describe('状态由证据算出来, 不由调用方指定', () => {
  const ev = (sid: string) => ({ sid, quote: 'x'.repeat(20) });

  it('有反证压倒一切', () => {
    expect(computeClaimStatus([ev('S1'), ev('S2')], [ev('S3')])).toBe('disputed');
  });
  it('没有支持 → unverified', () => {
    expect(computeClaimStatus([], [])).toBe('unverified');
  });
  it('同一个来源引两段仍是 single-source', () => {
    expect(computeClaimStatus([ev('S1'), ev('S1')], [])).toBe('single-source');
  });
  it('两个不同来源 → supported', () => {
    expect(computeClaimStatus([ev('S1'), ev('S2')], [])).toBe('supported');
  });
});

describe('概览与 slug', () => {
  it('统计按来源域名去重', async () => {
    const ledger = await createLedger(workDir, 't');
    await addSource(workDir, ledger, { url: 'https://a.com/1', title: '1', content: ADYEN_DOC });
    await addSource(workDir, ledger, { url: 'https://a.com/2', title: '2', content: ADYEN_DOC });
    await addSource(workDir, ledger, { url: 'https://b.com/1', title: '3', content: ADYEN_DOC });
    const st = ledgerStats(ledger);
    expect(st.sources).toBe(3);
    expect(st.domains).toBe(2);
    expect(st.archivedChars).toBe(ADYEN_DOC.length * 3);
  });

  it('中文标题也能出一个可用的 slug', () => {
    expect(slugifyTopic('Adyen vs Stripe 选型')).toBe('adyen-vs-stripe-选型');
    expect(slugifyTopic('!!!')).toMatch(/^research-\d+$/);
  });
});

describe('同题目接着上次的, 不重开', () => {
  it('再开一次, 上一轮的证据一条不少', async () => {
    const first = await createLedger(workDir, 'Adyen webhook 重试');
    await addSource(workDir, first, {
      url: 'https://docs.adyen.com/w', title: '官方文档',
      content: 'Webhooks returning 4xx are not retried by design.',
    });
    await addClaim(workDir, first, {
      text: '4xx 不重试',
      support: [{ sid: 'S1', quote: 'Webhooks returning 4xx are not retried by design.' }],
    });

    const second = await createLedger(workDir, 'Adyen webhook 重试');
    expect(second.slug).toBe(first.slug);
    expect(second.sources).toHaveLength(1);
    expect(second.claims).toHaveLength(1);

    /* 盘上那份也没被覆盖 */
    const onDisk = await loadLedger(workDir, first.slug);
    expect(onDisk?.claims).toHaveLength(1);
  });

  it('换个题目就是全新一本, 不会串', async () => {
    const a = await createLedger(workDir, '题目甲');
    await addSource(workDir, a, { url: 'https://a.example/x', title: 'A', content: 'hello world from A' });
    const b = await createLedger(workDir, '题目乙');
    expect(b.slug).not.toBe(a.slug);
    expect(b.sources).toHaveLength(0);
  });
});
