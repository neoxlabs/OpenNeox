
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { createContextualResult, createSummarizedResult } from '@neoxlabs/kernel/core/types/toolResult.js';
import { webFetch } from '../tools/webTools.js';
import {
  loadLedger, addSource, addClaim, ledgerStats,
  type ResearchLedger, type SourceKind, type ClaimEvidence,
} from './ledger.js';

/* ══════════════════════════════════════════════════════════════════════════
 * 写锁 —— 滑动窗口下必然有并发写
 * ══════════════════════════════════════════════════════════════════════════
 * 账本是 load → 改 → save 的读改写, K 个 worker 同时记就会丢写。
 * 子 agent 跑在同一个进程里, 所以按 slug 串一条 promise 链就够, 不用文件锁。 */
const writeChains = new Map<string, Promise<unknown>>();

function withLedgerLock<T>(slug: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeChains.get(slug) ?? Promise.resolve();
  /* 前一个失败也要放行后一个 —— 一条记失败不该卡住整个账本 */
  const next = prev.then(fn, fn);
  writeChains.set(slug, next.then(() => undefined, () => undefined));
  return next;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 抓取 + 归档
 * ══════════════════════════════════════════════════════════════════════════ */

interface FetchedPage {
  content: string;
  title: string;
  fetchedAt: string;
  publishedAt?: string;
}

/** 抓一个 URL, 拿正文和抓取时刻。抓不到返回 null (调用方按前置条件报出去)。 */
async function fetchForArchive(url: string): Promise<{ page: FetchedPage | null; reason?: string }> {
  const raw = await (webFetch.function as any)({ url, max_length: 120_000 }, {});
  let parsed: any;
  try { parsed = JSON.parse(String(raw)); } catch { return { page: null, reason: '抓取结果解析不了' }; }

  const meta = parsed?.metadata ?? {};
  const content = typeof parsed?.content === 'string' ? parsed.content : '';
  if (!content.trim() || parsed?.status === 'error') {
    return { page: null, reason: String(parsed?.error || meta?.status || '这个 URL 抓不到正文') };
  }
  return {
    page: {
      content,
      title: String(meta.page_title || url),
      fetchedAt: String(meta.fetched_at || new Date().toISOString()),
    },
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 工具
 * ══════════════════════════════════════════════════════════════════════════ */

export interface ResearchRecordDeps {
  workDir: string;
}

interface EvidenceInput { url?: string; quote?: string; loc?: string }
interface ClaimInput {
  text?: string;
  support?: EvidenceInput[];
  contradict?: EvidenceInput[];
  lean?: string;
}

export function createResearchRecordTool(deps: ResearchRecordDeps): Tool {
  return {
    name: 'research_record',
    description: `Record what you found into the research ledger. This is a research worker's ONLY output channel — anything not recorded here did not happen.

For each claim you give the claim text plus one or more VERBATIM quotes from the source, each with the URL it came from. The tool fetches and archives each URL itself, then checks every quote literally against that archive. A quote that cannot be found is REJECTED with the reason — that is not a failure, it means go back and copy the sentence exactly instead of paraphrasing.

When sources disagree, record BOTH sides: put the opposing evidence in \`contradict\`. Never pick a winner silently — the claim is then marked disputed and the report shows both.`,
    parameters: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Research ledger slug (given to you in the task)' },
        angle: {
          type: 'string',
          description: 'The research angle you were assigned — copy it VERBATIM from your task. The report is organised by angle, so a claim recorded without it ends up in an "unsorted" bin.',
        },
        claims: {
          type: 'array',
          description: 'Claims to record, each backed by verbatim quotes',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'The claim itself, one sentence' },
              support: {
                type: 'array',
                description: 'Evidence supporting the claim',
                items: {
                  type: 'object',
                  properties: {
                    url: { type: 'string', description: 'Where the quote came from' },
                    quote: { type: 'string', description: 'VERBATIM text copied from that page — not a paraphrase' },
                    loc: { type: 'string', description: 'Optional section / page locator' },
                  },
                  required: ['url', 'quote'],
                },
              },
              contradict: {
                type: 'array',
                description: 'Evidence contradicting the claim — record it, do not silently pick a side',
                items: {
                  type: 'object',
                  properties: {
                    url: { type: 'string' },
                    quote: { type: 'string' },
                    loc: { type: 'string' },
                  },
                  required: ['url', 'quote'],
                },
              },
              lean: { type: 'string', description: 'Which side you lean to and why (only when there is a contradiction). Both sides are kept regardless.' },
            },
            required: ['text', 'support'],
          },
        },
        source_kind: {
          type: 'string',
          enum: ['primary', 'secondary', 'vendor', 'unknown'],
          description: 'What kind of sources these are: primary (first-hand/测试/规范), vendor (厂商自述), secondary (转述/博客)',
        },
      },
      required: ['slug', 'claims'],
    },
    async function(args: any) {
      const slug = String(args?.slug || '').trim();
      const angle = String(args?.angle || '').trim().slice(0, 120);
      const claims: ClaimInput[] = Array.isArray(args?.claims) ? args.claims : [];
      const kind: SourceKind = (['primary', 'secondary', 'vendor', 'unknown'] as const).includes(args?.source_kind)
        ? args.source_kind
        : 'unknown';

      if (!slug) {
        return JSON.stringify(createSummarizedResult('research_record', 'error', '缺少 slug', {
          error: '没有给 slug —— 它在任务描述里, 照抄那一个。', precondition: true,
        }));
      }
      if (claims.length === 0) {
        return JSON.stringify(createSummarizedResult('research_record', 'error', '没有要记的结论', {
          error: 'claims 是空的。查到东西才调这个工具; 什么都没查到就在回传里说清楚。', precondition: true,
        }));
      }

      return withLedgerLock(slug, async () => {
        const ledger = await loadLedger(deps.workDir, slug);
        if (!ledger) {
          return JSON.stringify(createSummarizedResult('research_record', 'error', '账本不存在', {
            error: `找不到 slug 为 "${slug}" 的账本。核对任务里给的那个 slug。`, precondition: true,
          }));
        }

        /* 1. 先把所有涉及的 URL 抓下来归档 (已登记的直接复用, 不重抓) */
        const urls = new Set<string>();
        for (const c of claims) {
          for (const e of [...(c.support ?? []), ...(c.contradict ?? [])]) {
            if (e?.url) urls.add(String(e.url).trim());
          }
        }
        const sidByUrl = new Map<string, string>();
        const unreachable: Array<{ url: string; reason: string }> = [];
        for (const url of urls) {
          const known = ledger.sources.find((s) => s.url === url);
          if (known) { sidByUrl.set(url, known.sid); continue; }
          const { page, reason } = await fetchForArchive(url);
          if (!page) { unreachable.push({ url, reason: reason || '抓不到' }); continue; }
          const src = await addSource(deps.workDir, ledger, {
            url, title: page.title, content: page.content, kind, fetchedAt: page.fetchedAt,
          });
          sidByUrl.set(url, src.sid);
        }

        /* 2. 逐条入账 —— 引句校验在 addClaim 里 */
        const accepted: string[] = [];
        const rejected: Array<{ claim: string; quote: string; reason: string }> = [];

        for (const c of claims) {
          const text = String(c?.text || '').trim();
          if (!text) continue;

          const toEvidence = (list: EvidenceInput[] | undefined): { ok: ClaimEvidence[]; bad: Array<{ quote: string; reason: string }> } => {
            const ok: ClaimEvidence[] = [];
            const bad: Array<{ quote: string; reason: string }> = [];
            for (const e of list ?? []) {
              const url = String(e?.url || '').trim();
              const quote = String(e?.quote || '').trim();
              const sid = sidByUrl.get(url);
              if (!sid) {
                bad.push({ quote, reason: `${url} 没能抓下来, 这条证据用不了` });
                continue;
              }
              ok.push({ sid, quote, ...(e?.loc ? { loc: String(e.loc) } : {}) });
            }
            return { ok, bad };
          };

          const sup = toEvidence(c.support);
          const con = toEvidence(c.contradict);
          const preBad = [...sup.bad, ...con.bad];
          if (preBad.length > 0) {
            for (const b of preBad) rejected.push({ claim: text, quote: b.quote, reason: b.reason });
            continue;
          }

          const r = await addClaim(deps.workDir, ledger, {
            text, support: sup.ok, contradict: con.ok,
            ...(c.lean ? { lean: String(c.lean) } : {}),
            ...(angle ? { angle } : {}),
          });
          if (r.ok && r.claim) {
            accepted.push(`${r.claim.cid} [${r.claim.status}] ${text}`);
          } else {
            for (const b of r.rejected ?? []) rejected.push({ claim: text, quote: b.quote, reason: b.reason });
          }
        }

        const st = ledgerStats(ledger);
        const lines: string[] = [];
        if (accepted.length > 0) lines.push(`已入账 ${accepted.length} 条:`, ...accepted.map((a) => `  ✓ ${a}`));
        if (unreachable.length > 0) {
          lines.push('', '抓不到的来源:', ...unreachable.map((u) => `  ✗ ${u.url} — ${u.reason}`));
        }
        if (rejected.length > 0) {
          lines.push('', `被拒 ${rejected.length} 条引句 —— 原样复制原文里的那一段再记一次:`);
          for (const r of rejected) lines.push(`  ✗ 「${r.quote.slice(0, 60)}」 — ${r.reason}`);
        }
        lines.push('', `账本现状: ${st.sources} 个来源 / ${st.domains} 个站点 / ${st.claims} 条结论 (分歧 ${st.disputed} · 单源 ${st.singleSource})`);

        if (accepted.length === 0 && (rejected.length > 0 || unreachable.length > 0)) {
          return JSON.stringify(createSummarizedResult('research_record', 'error', '一条都没能入账', {
            error: lines.join('\n'), precondition: true,
          }));
        }

        return JSON.stringify(createContextualResult(
          'research_record', 'success',
          `记了 ${accepted.length} 条结论${rejected.length > 0 ? ` (${rejected.length} 条引句被拒)` : ''}`,
          lines.join('\n'),
          { metadata: { slug, accepted: accepted.length, rejected: rejected.length, unreachable: unreachable.length, ...st } },
        ));
      });
    },
  };
}

/** 给账本已经在手上的调用方复用的锁 (报告渲染前要等写完) */
export function waitForLedgerWrites(ledger: ResearchLedger): Promise<unknown> {
  return writeChains.get(ledger.slug) ?? Promise.resolve();
}
