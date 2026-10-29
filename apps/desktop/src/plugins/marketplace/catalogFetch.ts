
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

export interface CatalogFetchResult<T> {
  /** 拿到的数据 (网络新拿的, 或回退的缓存); 都没有时为 null */
  data: T | null;
  /** 数据来自本地缓存 (304 或网络失败回退) */
  fromCache: boolean;
  /** 网络失败、用的是旧缓存 */
  stale: boolean;
  /** 网络失败原因 (stale 或 data 为 null 时有值) */
  error?: string;
  /** 这份数据最后一次和服务端确认的时间 */
  fetchedAt?: number;
}

interface Entry {
  key: string;
  etag?: string;
  at: number;
  data: unknown;
}

let cacheDirOverride: string | null = null;

/** 测试用: 把缓存目录指到临时目录 */
export function setCatalogCacheDir(dir: string | null): void {
  cacheDirOverride = dir;
}

function cacheDir(): string {
  return cacheDirOverride ?? path.join(os.homedir(), NEOX_HOME_DIRNAME, 'plugins', 'cache', 'catalog');
}

function fileFor(key: string): string {
  return path.join(cacheDir(), `${createHash('sha1').update(key).digest('hex').slice(0, 20)}.json`);
}

const memo = new Map<string, Entry>();

async function readEntry(key: string): Promise<Entry | null> {
  const hit = memo.get(key);
  if (hit) return hit;
  try {
    const e = JSON.parse(await fs.readFile(fileFor(key), 'utf8')) as Entry;
    /* 哈希撞了或文件被别的版本写过 —— 按 key 校验, 不认错的数据 */
    if (!e || e.key !== key) return null;
    memo.set(key, e);
    return e;
  } catch {
    return null;
  }
}

/** 测试用: 清掉进程内那份, 模拟"刚启动" */
export function resetCatalogMemoForTests(): void {
  memo.clear();
}

async function writeEntry(e: Entry): Promise<void> {
  memo.set(e.key, e);
  try {
    await fs.mkdir(cacheDir(), { recursive: true });
    const f = fileFor(e.key);
    const tmp = `${f}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(e), 'utf8');
    await fs.rename(tmp, f);
  } catch {
    /* 缓存写不进去不影响本次结果 */
  }
}

/** 只读缓存, 不碰网络 —— 打开页面时先用它立刻出图 */
export async function readCatalogCache<T>(key: string): Promise<{ data: T; at: number } | null> {
  const e = await readEntry(key);
  return e ? { data: e.data as T, at: e.at } : null;
}

export async function fetchCatalogJson<T>(
  url: string,
  opts: { cacheKey?: string; timeoutMs?: number; retries?: number } = {},
): Promise<CatalogFetchResult<T>> {
  const key = opts.cacheKey ?? url;
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const retries = Math.max(0, opts.retries ?? 1);
  const cached = await readEntry(key);

  let lastErr = '';
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (cached?.etag) headers['If-None-Match'] = cached.etag;
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 304 && cached) {
        const e: Entry = { ...cached, at: Date.now() };
        await writeEntry(e);
        return { data: cached.data as T, fromCache: true, stale: false, fetchedAt: e.at };
      }
      if (!res.ok) {
        lastErr = `HTTP ${res.status}`;
        /* 5xx 多半是瞬时的 (网关/上游抖动), 重试一次; 4xx 重试也是同样结果 */
        if (res.status >= 500 && attempt < retries) continue;
        break;
      }
      const data = (await res.json()) as T;
      const e: Entry = { key, etag: res.headers.get('etag') ?? undefined, at: Date.now(), data };
      await writeEntry(e);
      return { data, fromCache: false, stale: false, fetchedAt: e.at };
    } catch (err: any) {
      lastErr = err?.name === 'TimeoutError' || err?.name === 'AbortError'
        ? `timeout ${timeoutMs}ms`
        : (err?.cause?.code || err?.message || 'network_error');
    }
  }

  if (cached) {
    return { data: cached.data as T, fromCache: true, stale: true, error: lastErr, fetchedAt: cached.at };
  }
  return { data: null, fromCache: false, stale: false, error: lastErr || 'network_error' };
}
