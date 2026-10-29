/**
 * web_fetch 的多 URL 并行抓取 (work H-14)。
 *
 * 背景: 调研一个题目常要看好几个来源, 模型只能一个一个调 web_fetch —— 5 个来源就是
 * 5 倍墙钟。这里给 web_fetch 的 `urls: [...]` 分支提供 worker-pool 并行执行:
 *
 *   · 并发 WEB_FETCH_BATCH_CONCURRENCY (5), 一批 5 个 URL 基本一轮跑完;
 *   · 每个 URL 单独 25s 超时 —— 一个站点卡住不拖垮整批, 也不会撞上工具 60s 上限;
 *   · 结果按传入顺序拼成一份, 总字符预算 WEB_FETCH_BATCH_TOTAL_CHARS, 超了按预算截断
 *     (并提示"要全文请单独抓这个 URL")。
 *
 * 单 URL 的抓取/重定向/SSRF 闸/重试全部复用 web_fetch 自己的路径 —— 本模块只负责
 * "并发调度 + 拼输出", 不改抓取语义。
 */

/** 一次最多抓几个 URL (再多请分批)。 */
export const WEB_FETCH_BATCH_MAX_URLS = 8;
/** 并发数: 5 个 URL 一轮跑完, 又不至于把目标站点打出限流。 */
export const WEB_FETCH_BATCH_CONCURRENCY = 5;
/** 单个 URL 的墙钟上限 (整批最坏 ≈ ceil(8/5) × 25s)。 */
export const WEB_FETCH_BATCH_PER_URL_TIMEOUT_MS = 25_000;
/** 整批正文总预算, 防止 8 个长文把上下文撑爆。 */
export const WEB_FETCH_BATCH_TOTAL_CHARS = 32_000;

export interface WebFetchBatchItem {
  url: string;
  ok: boolean;
  summary: string;
  content: string;
  /** 单次抓取耗时; 用于在回执里给"串行约 N 秒"的对照 */
  elapsedMs: number;
  timedOut?: boolean;
}

export interface WebFetchBatchResult {
  items: WebFetchBatchItem[];
  elapsedMs: number;
}

/**
 * 把 {url, urls} 归一成一个去重后的 URL 列表 (保持顺序)。
 * 超过上限的尾部丢弃 —— 调用方在输出里会看到说明。
 */
export function normalizeFetchUrls(args: { url?: unknown; urls?: unknown }): string[] {
  const list: string[] = [];
  if (typeof args?.url === 'string' && args.url.trim()) list.push(args.url.trim());
  if (Array.isArray(args?.urls)) {
    for (const u of args.urls) {
      if (typeof u === 'string' && u.trim()) list.push(u.trim());
    }
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of list) {
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out.slice(0, WEB_FETCH_BATCH_MAX_URLS);
}

/** 单次抓取结果 (web_fetch 的 JSON 字符串) → 批量条目。 */
export function toBatchItem(url: string, raw: string, elapsedMs: number): WebFetchBatchItem {
  try {
    const parsed = JSON.parse(String(raw));
    const content = typeof parsed?.content === 'string' ? parsed.content : '';
    const summary = typeof parsed?.summary === 'string' ? parsed.summary : '';
    return {
      url,
      ok: parsed?.status !== 'error',
      summary: summary || (content ? '已抓到内容' : '没有拿到内容'),
      content,
      elapsedMs,
    };
  } catch {
    /* 解析不了就当失败: 宁可让模型重抓一次, 也不要把半截 JSON 塞进上下文 */
    return {
      url,
      ok: false,
      summary: '抓取返回了无法解析的结果',
      content: '',
      elapsedMs,
    };
  }
}

/**
 * 并行执行: worker-pool, 结果按传入顺序回填。
 * `runOne` 由调用方注入 (生产里是 web_fetch 自己的单 URL 路径), 测试里可以给假实现。
 */
export async function fetchUrlsInParallel(
  urls: string[],
  runOne: (url: string) => Promise<WebFetchBatchItem>,
  opts?: { concurrency?: number; perUrlTimeoutMs?: number },
): Promise<WebFetchBatchResult> {
  const concurrency = Math.max(1, opts?.concurrency ?? WEB_FETCH_BATCH_CONCURRENCY);
  const perUrlTimeoutMs = Math.max(1, opts?.perUrlTimeoutMs ?? WEB_FETCH_BATCH_PER_URL_TIMEOUT_MS);
  const started = Date.now();
  const results: WebFetchBatchItem[] = new Array(urls.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= urls.length) return;
      const url = urls[index]!;
      results[index] = await withTimeout(url, runOne(url), perUrlTimeoutMs);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, urls.length) }, () => worker()),
  );

  return { items: results, elapsedMs: Date.now() - started };
}

async function withTimeout(
  url: string,
  promise: Promise<WebFetchBatchItem>,
  timeoutMs: number,
): Promise<WebFetchBatchItem> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<WebFetchBatchItem>((resolve) => {
    timer = setTimeout(() => {
      resolve({
        url,
        ok: false,
        summary: `抓取超时 (${timeoutMs}ms), 已跳过`,
        content: '',
        elapsedMs: timeoutMs,
        timedOut: true,
      });
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface ComposedBatchOutput {
  summary: string;
  content: string;
  okCount: number;
  failedCount: number;
  /** 因为总预算被截断的 URL 数 */
  trimmedCount: number;
}

/**
 * 把各 URL 的结果拼成一份给模型看的输出。
 * 头部一行回执 (成功/失败/并发/墙钟/串行对照), 之后按 URL 分段。
 */
export function composeBatchOutput(
  items: WebFetchBatchItem[],
  opts?: { elapsedMs?: number; concurrency?: number; totalChars?: number },
): ComposedBatchOutput {
  const budget = Math.max(1, opts?.totalChars ?? WEB_FETCH_BATCH_TOTAL_CHARS);
  const elapsedMs = opts?.elapsedMs ?? 0;
  const concurrency = Math.max(1, opts?.concurrency ?? WEB_FETCH_BATCH_CONCURRENCY);
  const okCount = items.filter((i) => i.ok).length;
  const failedCount = items.length - okCount;
  const serialMs = items.reduce((sum, i) => sum + (i.elapsedMs || 0), 0);

  const header = [
    `▸ 并行抓取 ${items.length} 个 URL · 成功 ${okCount}/${items.length} · 并发 ${concurrency}`
      + ` · 墙钟 ${(elapsedMs / 1000).toFixed(1)}s${serialMs > 0 ? ` (逐个抓约 ${(serialMs / 1000).toFixed(1)}s)` : ''}`,
  ];

  let used = 0;
  let trimmedCount = 0;
  const blocks: string[] = [];
  items.forEach((item, index) => {
    const mark = item.ok ? '✓' : '✗';
    const head = `──── [${index + 1}/${items.length}] ${mark} ${item.url}\n▸ ${item.summary}`;
    let body = item.content.trim();
    if (body) {
      const remaining = budget - used;
      if (remaining <= 0) {
        trimmedCount++;
        body = '… (整批正文已到预算上限, 这个 URL 的正文未展开; 需要时单独抓它)';
      } else if (body.length > remaining) {
        trimmedCount++;
        body = body.slice(0, remaining) + '\n… (整批正文已到预算上限, 已截断; 需要全文请单独抓这个 URL)';
      }
      used += Math.min(body.length, Math.max(0, remaining));
    }
    blocks.push(body ? `${head}\n\n${body}` : head);
  });

  const content = [...header, '', ...blocks].join('\n\n');
  const summary = `并行抓取 ${items.length} 个 URL: 成功 ${okCount}, 失败 ${failedCount}`
    + `, 墙钟 ${(elapsedMs / 1000).toFixed(1)}s${serialMs > 0 ? ` (逐个约 ${(serialMs / 1000).toFixed(1)}s)` : ''}`;

  return { summary, content, okCount, failedCount, trimmedCount };
}
