import type { Tool } from '@neoxlabs/kernel/types/index.js';

/** 单次搜索注入的 token 预算 (chat:C3-07)。 */
export const CHAT_SEARCH_TOKEN_BUDGET = 1500;

/** 聊天档等一次搜索的上限 (chat:C3-06)。 */
export const CHAT_SEARCH_TIMEOUT_MS = 3000;

/** 同一个域名最多留几条 (chat:C3-04)。 */
export const CHAT_SEARCH_PER_DOMAIN_LIMIT = 2;

/** 单条摘要的硬上限 —— 一条超长摘要不能把整个预算吃掉。 */
const MAX_SNIPPET_CHARS = 240;
const MAX_TITLE_CHARS = 120;

export interface ChatSearchHit {
  title: string;
  url: string;
  description: string;
  published_at?: string;
}

/** 估算 token 数: 中文 (CJK / 全角) 1 字 ≈ 1 token, 其余 3.5 字符 ≈ 1 token。 */
export function estimateSearchTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const isCjk = (code >= 0x2e80 && code <= 0x9fff)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xff00 && code <= 0xffef)
      || (code >= 0x3000 && code <= 0x303f);
    if (isCjk) cjk++;
    else other++;
  }
  return cjk + Math.ceil(other / 3.5);
}

/**
 * 去重键: 主机名, 去掉 `www.` / `m.` 前缀。
 *
 * `news.163.com` 与 `163.com` 算**不同**来源 —— 子域往往承载不同内容,
 * 一律合并会把真正的多样性也砍掉。拿不到主机名时退回完整 URL。
 */
export function domainKeyOf(url: string): string {
  const trimmed = (url ?? '').trim();
  if (!trimmed) return '';
  try {
    let host = new URL(trimmed).hostname.toLowerCase();
    if (!host) return trimmed.toLowerCase();
    if (host.startsWith('www.')) host = host.slice(4);
    if (host.startsWith('m.')) host = host.slice(2);
    return host;
  } catch {
    return trimmed.toLowerCase();
  }
}

/** 按域名去重, 同域最多 perDomain 条, 保持原来的相关性顺序 (只跳过, 不重排)。 */
export function diversifyByDomain<T extends { url: string }>(
  hits: T[],
  perDomain = CHAT_SEARCH_PER_DOMAIN_LIMIT,
): T[] {
  if (hits.length === 0) return [];
  const limit = perDomain < 1 ? 1 : perDomain;
  const seen = new Map<string, number>();
  const out: T[] = [];
  for (const hit of hits) {
    const key = domainKeyOf(hit.url);
    const used = seen.get(key) ?? 0;
    if (used >= limit) continue;
    seen.set(key, used + 1);
    out.push(hit);
  }
  return out;
}

export interface ShapedSearchResults {
  /** 给模型读的文本 (已去重 / 已按预算截断)。 */
  text: string;
  /** 实际写进去的条数。 */
  shown: number;
  /** 去重后、截断前的条数。 */
  total: number;
  /** 估算的 token 数 (≤ 预算)。 */
  tokens: number;
  truncated: boolean;
}

/** 把结果渲染成给模型读的纯文本, 并在 tokenBudget 内截断。 */
export function shapeSearchResults(
  hits: ChatSearchHit[],
  tokenBudget = CHAT_SEARCH_TOKEN_BUDGET,
): ShapedSearchResults {
  if (hits.length === 0) {
    return { text: '', shown: 0, total: 0, tokens: 0, truncated: false };
  }
  let text = '';
  let used = 0;
  let shown = 0;
  for (let i = 0; i < hits.length; i++) {
    const block = renderHit(i + 1, hits[i]!);
    const blockTokens = estimateSearchTokens(block);
    const remaining = hits.length - (i + 1);
    // 预算要留给末尾的省略提示 —— 否则模型会以为这就是全部。
    const reserve = remaining > 0 ? estimateSearchTokens(omittedHint(remaining)) : 0;
    if (used + blockTokens + reserve > tokenBudget) break;
    text += block;
    used += blockTokens;
    shown++;
  }
  if (shown === 0) {
    // 第一条就超预算 (超长摘要): 截断到能放下, 不让一次搜索返回空文本。
    const hintReserve = hits.length > 1 ? estimateSearchTokens(omittedHint(hits.length - 1)) : 0;
    const first = renderHit(1, hits[0]!, tokenBudget - hintReserve);
    text = first;
    used = estimateSearchTokens(first);
    shown = 1;
  }
  const omitted = hits.length - shown;
  if (omitted > 0) {
    const hint = omittedHint(omitted);
    text += hint;
    used += estimateSearchTokens(hint);
  }
  return {
    text: text.trimEnd(),
    shown,
    total: hits.length,
    tokens: used,
    truncated: shown < hits.length,
  };
}

function renderHit(index: number, hit: ChatSearchHit, tokenBudget?: number): string {
  let block = `${index}. ${clip(hit.title, MAX_TITLE_CHARS)}\n`;
  if (hit.url) block += `   ${hit.url}\n`;
  const published = (hit.published_at ?? '').trim();
  if (published) block += `   ${published}\n`;
  if (hit.description) block += `   ${clip(hit.description, MAX_SNIPPET_CHARS)}\n`;
  if (tokenBudget !== undefined && estimateSearchTokens(block) > tokenBudget) {
    return clipToTokens(block, tokenBudget);
  }
  return block;
}

function clipToTokens(text: string, tokenBudget: number): string {
  if (tokenBudget <= 0) return '';
  let used = 0;
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const isCjk = (code >= 0x2e80 && code <= 0x9fff)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xff00 && code <= 0xffef)
      || (code >= 0x3000 && code <= 0x303f);
    const cost = isCjk ? 1 : 1 / 3.5;
    if (used + cost > tokenBudget - 1) break; // 留 1 token 给省略号
    used += cost;
    out += ch;
  }
  return `${out.trimEnd()}…`;
}

function omittedHint(count: number): string {
  return `（还有 ${count} 条结果未显示, 需要更多就换更具体的搜索词）\n`;
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

/** web_search 回执里 metadata.results 的形状 (webTools.buildWebSearchResult 写入)。 */
interface RawSearchMetadataResult {
  title?: unknown;
  url?: unknown;
  description?: unknown;
  published_at?: unknown;
}

function toChatHit(raw: RawSearchMetadataResult): ChatSearchHit {
  return {
    title: typeof raw.title === 'string' ? raw.title : '',
    url: typeof raw.url === 'string' ? raw.url : '',
    description: typeof raw.description === 'string' ? raw.description : '',
    ...(typeof raw.published_at === 'string' && raw.published_at
      ? { published_at: raw.published_at }
      : {}),
  };
}

/**
 * 把 web_search 的 JSON 回执整形一遍 (去重 + 预算)。
 *
 * 只处理成功回执且带结构化 results 的情况; 错误 / 不支持 / 老格式一律原样返回 ——
 * 整形不该把「为什么搜不到」这句话吞掉。
 *
 * 图片区 (metadata.images) 放在最前面并计入同一份预算 —— Chat 里「找几张图」靠的就是
 * 这些直链, 整形时丢掉它们等于把这类问题弄残。
 */
export function shapeWebSearchPayload(
  raw: string,
  tokenBudget = CHAT_SEARCH_TOKEN_BUDGET,
): string {
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return raw;
    parsed = value as Record<string, unknown>;
  } catch {
    return raw;
  }
  if (parsed.status !== 'success') return raw;

  const metadata = parsed.metadata;
  if (!metadata || typeof metadata !== 'object') return raw;
  const meta = metadata as Record<string, unknown>;
  const rawResults = meta.results;
  if (!Array.isArray(rawResults) || rawResults.length === 0) return raw;

  const hits = diversifyByDomain(
    rawResults.filter((r): r is RawSearchMetadataResult => !!r && typeof r === 'object').map(toChatHit),
  );
  if (hits.length === 0) return raw;

  const imagesBlock = renderImages(meta.images, Math.max(0, Math.min(tokenBudget, MAX_IMAGE_TOKENS)));
  const imageTokens = estimateSearchTokens(imagesBlock);
  const shaped = shapeSearchResults(hits, Math.max(0, tokenBudget - imageTokens));
  const content = [imagesBlock.trimEnd(), shaped.text].filter(Boolean).join('\n');
  return JSON.stringify({
    ...parsed,
    content,
    metadata: {
      ...meta,
      /* 界面来源卡跟模型看到的是同一批 —— 不然 UI 上还有一堆同域重复页 */
      results: hits.map((h) => ({
        title: h.title,
        url: h.url,
        description: h.description,
        published_at: h.published_at,
      })),
      shaping: {
        shown: shaped.shown,
        total: shaped.total,
        tokens: estimateSearchTokens(content),
        truncated: shaped.truncated,
        token_budget: tokenBudget,
        per_domain_limit: CHAT_SEARCH_PER_DOMAIN_LIMIT,
      },
    },
  });
}

/** 图片区最多占多少 token —— 不能因为一组图把文字结果全挤掉。 */
const MAX_IMAGE_TOKENS = 400;
/** 最多展示几张图。 */
const MAX_IMAGES = 6;

function renderImages(rawImages: unknown, tokenCap: number): string {
  if (!Array.isArray(rawImages) || rawImages.length === 0 || tokenCap <= 0) return '';
  const lines: string[] = [];
  for (const raw of rawImages.slice(0, MAX_IMAGES)) {
    if (!raw || typeof raw !== 'object') continue;
    const im = raw as { url?: unknown; title?: unknown; width?: unknown; height?: unknown };
    if (typeof im.url !== 'string' || !im.url) continue;
    const dim = typeof im.width === 'number' && typeof im.height === 'number'
      ? ` (${im.width}×${im.height})`
      : '';
    const title = typeof im.title === 'string' && im.title ? ` — ${clip(im.title, 60)}` : '';
    lines.push(`[img ${lines.length + 1}] ${im.url}${dim}${title}`);
  }
  if (lines.length === 0) return '';
  const block = `图片:\n${lines.join('\n')}\n`;
  return estimateSearchTokens(block) > tokenCap ? clipToTokens(block, tokenCap) : block;
}

export function shapeChatWebSearch(tool: Tool, timeoutMs = CHAT_SEARCH_TIMEOUT_MS): Tool {
  return {
    ...tool,
    function: async (args, context) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<string>((resolve) => {
        timer = setTimeout(() => {
          resolve(JSON.stringify({
            type: 'contextual',
            status: 'success',
            tool: tool.name,
            summary: `搜索超时 (${Math.round(timeoutMs / 1000)} 秒), 没有拿到结果`,
            content: '搜索超时 —— 这次没拿到结果。不要用同样的词重试; '
              + '要么换个更具体的搜索词, 要么直接用已有信息回答, 并跟用户说清哪部分没查到。',
            metadata: { timeout_ms: timeoutMs },
          }));
        }, timeoutMs);
        /* 不 unref: 测试里靠它精确推进时钟; 3s 的短定时器对进程退出没有影响 */
        if (typeof (timer as { unref?: () => void }).unref === 'function') {
          (timer as { unref: () => void }).unref();
        }
      });

      try {
        const result = await Promise.race([
          Promise.resolve().then(() => tool.function(args, context)).then(String),
          timeout,
        ]);
        return shapeWebSearchPayload(result);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}
