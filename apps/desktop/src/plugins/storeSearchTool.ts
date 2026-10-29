import type { Tool } from '@neoxlabs/kernel/types/index.js';
import type { InstalledPlugin } from '@neoxlabs/platform/shared/plugin-types.js';

export const PLUGIN_STORE_TOOL_NAME = 'plugin_store_search';

interface ListingRecord {
  name: string;
  version?: string;
  description?: string;
  descriptionZh?: string;
  i18n?: Record<string, { description?: string }>;
  kind?: string;
  category?: string;
  facets?: string[];
  keywords?: string[];
  official?: boolean;
}

/** 同一轮对话可能连搜几次; 目录几十条, 5 分钟内不重复打网络 */
const MEMO_MS = 5 * 60_000;
let memo: { base: string; at: number; list: ListingRecord[] } | null = null;

async function loadCatalog(base: string): Promise<ListingRecord[]> {
  if (memo && memo.base === base && Date.now() - memo.at < MEMO_MS) return memo.list;
  const res = await fetch(`${base.replace(/\/+$/, '')}/plugins?pageSize=200&sort=downloads`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = (await res.json()) as { plugins?: ListingRecord[] };
  const list = Array.isArray(j.plugins) ? j.plugins : [];
  memo = { base, at: Date.now(), list };
  return list;
}

/** 测试用 */
export function resetStoreCatalogMemo(): void {
  memo = null;
}

const STOP = new Set(['the', 'a', 'an', 'to', 'my', 'me', 'for', 'and', 'or', 'with', 'plugin', 'plugins', 'app', 'use',
  '帮我', '我的', '插件', '一下', '看看', '连接', '接入', '有没有', '上的', '给我', '我们', '怎么', '可以', '能不能', '什么',
  '是不', '不是', '是不是', '真的', '多大', '能跑', '一个', '这个', '那个', '现在']);

const CJK_RUN = /^[一-鿿]+$/;

export function queryTerms(q: string): string[] {
  const out = new Set<string>();
  for (const raw of q.toLowerCase().split(/[\s,，、。.!！?？;；:：/|()（）"'“”]+/)) {
    const t = raw.trim();
    if (t.length < 2 || STOP.has(t)) continue;
    out.add(t);
    /* 中文连写没有空格: 「帮我写周报」要能命中「周报」—— 连续汉字再切 2~4 字的片段 */
    if (CJK_RUN.test(t) && t.length > 2) {
      for (let n = 2; n <= 4; n++) {
        for (let i = 0; i + n <= t.length; i++) {
          const g = t.slice(i, i + n);
          if (!STOP.has(g)) out.add(g);
        }
      }
    }
  }
  return [...out];
}

/** 查询里的「专名」: 拉丁字母词 (jira / slack / figma) —— 用户点名要的就是它 */
const brandTerms = (terms: string[]) => terms.filter((t) => /^[a-z][a-z0-9.+-]*$/.test(t));

function haystack(p: { name: string; description?: string; descriptionZh?: string; keywords?: string[]; kind?: string; category?: string }): string {
  return [p.name, p.description, p.descriptionZh, p.kind, p.category, ...(p.keywords ?? [])]
    .filter(Boolean).join(' ').toLowerCase();
}

function score(text: string, name: string, terms: string[]): number {
  let s = 0;
  for (const t of terms) {
    if (name.toLowerCase() === t) s += 10;
    else if (name.toLowerCase().includes(t)) s += 5;
    else if (text.includes(t)) s += t.length >= 3 ? 3 : 2;
  }
  return s;
}

const isZhText = (s: string) => /[一-鿿]/.test(s);

export interface StoreSearchDeps {
  /** 本机已装插件 (worker 里是 pluginRegistry.getAll()) */
  listInstalled: () => InstalledPlugin[];
  /** 商店地址; 没有 = 这个发行版没有商店 */
  storeBase: () => string | undefined;
}

export async function searchPluginStore(query: string, deps: StoreSearchDeps): Promise<Record<string, unknown>> {
  const q = (query || '').trim();
  const zh = isZhText(q);
  const terms = queryTerms(q);
  const installed = deps.listInstalled();
  const installedByName = new Map(installed.map((p) => [p.name, p]));

  const describe = (r: { description?: string; descriptionZh?: string; i18n?: Record<string, { description?: string }> }) =>
    (zh ? (r.i18n?.zh?.description || r.descriptionZh) : undefined) || r.description || '';

  /* 已装的也要能被搜到: 本地导入的插件不在商店里 */
  const installedHits = installed
    .map((p) => {
      const m = p.manifest as { description?: string; keywords?: string[]; kind?: string; i18n?: Record<string, { description?: string }> } | undefined;
      const rec = { name: p.name, description: m?.description, keywords: m?.keywords, kind: m?.kind, i18n: m?.i18n };
      return { p, rec, s: terms.length ? score(haystack(rec), p.name, terms) : 1 };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map(({ p, rec }) => ({
      name: p.name,
      version: p.version,
      status: p.enabled ? 'installed' : 'installed_but_disabled',
      description: describe(rec),
    }));

  const base = deps.storeBase();
  const out: Record<string, unknown> = { query: q, installed: installedHits };

  if (!base) {
    out.store = 'none';
    out.guidance = 'This Neox build has no plugin store. Only the installed plugins above are available. '
      + 'If none fits, say so plainly and suggest adding an MCP server (Settings → MCP) — do not search this machine for credentials or CLIs.';
    return out;
  }

  let catalog: ListingRecord[];
  try {
    catalog = await loadCatalog(base);
  } catch (err: any) {
    out.store = 'unreachable';
    out.error = String(err?.message ?? err);
    out.guidance = 'The plugin store could not be reached right now. Tell the user, and that they can browse it on the Plugins page when online.';
    return out;
  }

  const scored = catalog
    .filter((r) => !installedByName.has(r.name))
    .map((r) => ({ r, s: terms.length ? score(haystack(r), r.name, terms) : 1 }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);
  /* 中文切片会带进「是不」「模型」这类蹭上的词 —— 只留跟最高分同一档的 (≥40%), 不把半个目录都端出来 */
  const top = scored[0]?.s ?? 0;
  const storeHits = scored
    .filter((x) => x.s >= Math.max(1, top * 0.4))
    /* 没给关键词 = 「商店里都有什么」, 多列一些 */
    .slice(0, terms.length ? 6 : 30)
    .map(({ r }) => ({
      name: r.name,
      version: r.version,
      status: 'not_installed',
      kind: r.kind,
      what: r.facets,
      official: r.official === true,
      description: describe(r),
      link: `neox://plugins/${r.name}`,
    }));

  out.store = 'available';
  out.storeSize = catalog.length;
  /* 用户点了名 (jira) 而点名的那个谁也没命中: 剩下靠中文片段命中的 (「工单」→ linear) 只是「相近」,
   * 不能说成「就是它」—— 否则「Jira 工单」会被答成「装 Linear 插件就行」。 */
  const brands = brandTerms(terms);
  const allHits = [...installedHits, ...storeHits] as Array<{ name: string; description?: string }>;
  const brandMissed = brands.length > 0 && !allHits.some((h) => brands.some((b) => haystack(h as any).includes(b)));
  if (brandMissed) {
    out.notInstalled = [];
    out.related = storeHits;
    out.guidance = `Nothing in the Neox plugin store is for "${brands.join(', ')}". Say so directly. `
      + (storeHits.length ? 'The "related" plugins only share words with the request — mention one only if it clearly serves the same need. ' : '')
      + 'Do not look for credentials, keychains or CLIs on this machine. You may suggest an MCP server (Settings → MCP) or the service\'s own web UI.';
    return out;
  }
  out.notInstalled = storeHits;
  if (storeHits.length) {
    out.guidance = 'Tell the user which plugin(s) would do it and link each one as a markdown link to its `link` '
      + '(e.g. [在插件页打开 linear](neox://plugins/linear)) — clicking opens its install page. '
      + 'Do not install plugins yourself. Connector plugins (kind "connector") need the user\'s own API key after installing.';
  } else if (!installedHits.length) {
    out.guidance = 'Nothing in the Neox plugin store matches. Say so directly in one or two sentences. '
      + 'Do not look for credentials, keychains or CLIs on this machine. You may suggest an MCP server (Settings → MCP) or the service\'s own web UI.';
  }
  return out;
}

export function createPluginStoreSearchTool(deps: StoreSearchDeps): Tool {
  return {
    name: PLUGIN_STORE_TOOL_NAME,
    description:
      'Find out whether Neox can connect to a service or do a job via plugins: searches the plugins installed here AND the Neox plugin store. '
      + 'Call this FIRST when the user mentions a service/app you have no tool for (Jira, Slack, Figma, Google Drive, a database…) '
      + 'or asks which plugins / integrations exist — before looking for credentials, CLIs or config files on the machine. '
      + 'Store results come with a neox://plugins/<name> link that opens the plugin\'s install page.',
    group: 'search',
    isReadOnly: true,
    parallelSafety: 'safe',
    resultType: 'contextual',
    timeoutMs: 15_000,
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Service or task in the user\'s words, e.g. "Jira", "Slack 消息", "周报", "local models". Empty = list everything.',
        },
      },
    },
    async function(args: { query?: string }): Promise<string> {
      return JSON.stringify(await searchPluginStore(args?.query ?? '', deps));
    },
  };
}
