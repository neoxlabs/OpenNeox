/**
 * browserMocks — 每个 surface 的网络 mock 注册表.
 *
 *   场景: agent 改前端代码 → 想验证后端 API 返不同 status / body 时前端的处理.
 *   不必真起后端, 用 Playwright page.route() 截住请求 → fulfill 假响应.
 *
 *   状态结构:
 *     Map<surfaceId, Map<key, Entry>>
 *       key = `${method}|${urlPattern}`  (method='*' 表示任意)
 *       Entry 持 handler 引用, 用于 unroute 精确移除.
 *
 *   生命周期: page closed → 该 surface 的全部 mock 自动清空 (Playwright 重新创建 Page
 *   时如果用户重 attach, 应重新注册. agent 一般在 navigate 后立刻 mock 即可).
 */

import type { Page, Route } from 'playwright-core';

export interface MockEntry {
  /** Playwright 接受的 url pattern: glob 字符串 or RegExp */
  pattern: string;
  method: string;             /* 'GET' / 'POST' / '*' */
  status: number;
  body?: string;
  contentType?: string;
  headers?: Record<string, string>;
  /** Playwright handler, page.unroute(pattern, handler) 时用 */
  handler: (route: Route) => Promise<void>;
}

const mocksBySurface = new Map<string, Map<string, MockEntry>>();

function keyOf(method: string, pattern: string): string {
  return `${method.toUpperCase()}|${pattern}`;
}

/** 注册一条 mock. 同 (method+pattern) 已存在则替换. */
export async function registerMock(
  surfaceId: string,
  page: Page,
  cfg: { pattern: string; method?: string; status?: number; body?: string; contentType?: string; headers?: Record<string, string> },
): Promise<MockEntry> {
  const method = (cfg.method || '*').toUpperCase();
  const status = cfg.status ?? 200;
  let map = mocksBySurface.get(surfaceId);
  if (!map) {
    map = new Map();
    mocksBySurface.set(surfaceId, map);
    /* page close 时清空 */
    page.once('close', () => mocksBySurface.delete(surfaceId));
  }
  const k = keyOf(method, cfg.pattern);
  /* 如已存在 → 先 unroute 旧的 */
  const prev = map.get(k);
  if (prev) {
    try { await page.unroute(prev.pattern, prev.handler); } catch { /* ignore */ }
    map.delete(k);
  }
  const handler = async (route: Route) => {
    /* method 不匹配时放行原请求 (continue), 不要 fulfill */
    const reqMethod = route.request().method().toUpperCase();
    if (method !== '*' && reqMethod !== method) {
      await route.continue().catch(() => undefined);
      return;
    }
    try {
      await route.fulfill({
        status,
        body: cfg.body,
        contentType: cfg.contentType,
        headers: cfg.headers,
      });
    } catch { /* 路由可能已 close, 容忍 */ }
  };
  await page.route(cfg.pattern, handler);
  const entry: MockEntry = { pattern: cfg.pattern, method, status, body: cfg.body, contentType: cfg.contentType, headers: cfg.headers, handler };
  map.set(k, entry);
  return entry;
}

/** 清除 mock(s). pattern 不传 = 清该 surface 全部. */
export async function clearMocks(
  surfaceId: string,
  page: Page,
  opts?: { pattern?: string; method?: string },
): Promise<number> {
  const map = mocksBySurface.get(surfaceId);
  if (!map) return 0;
  let cleared = 0;
  if (!opts?.pattern) {
    /* 清全部 */
    for (const entry of map.values()) {
      try { await page.unroute(entry.pattern, entry.handler); cleared++; } catch { /* ignore */ }
    }
    map.clear();
    mocksBySurface.delete(surfaceId);
    return cleared;
  }
  /* 指定 pattern + 可选 method */
  const targetMethod = (opts.method || '*').toUpperCase();
  if (opts.method) {
    /* 精确 (method+pattern) */
    const k = keyOf(targetMethod, opts.pattern);
    const entry = map.get(k);
    if (entry) {
      try { await page.unroute(entry.pattern, entry.handler); cleared = 1; } catch { /* ignore */ }
      map.delete(k);
    }
  } else {
    /* 同 pattern 下所有 method (* / GET / POST 全清) */
    for (const [k, entry] of [...map.entries()]) {
      if (entry.pattern === opts.pattern) {
        try { await page.unroute(entry.pattern, entry.handler); cleared++; } catch { /* ignore */ }
        map.delete(k);
      }
    }
  }
  return cleared;
}

/** 列出当前 surface 已注册的 mock — handler 引用不返 (不 JSON-safe). */
export function listMocks(surfaceId: string): Array<Omit<MockEntry, 'handler'>> {
  const map = mocksBySurface.get(surfaceId);
  if (!map) return [];
  return [...map.values()].map(({ handler: _h, ...rest }) => rest);
}
