
const CACHE_TTL_MS = 20_000;
const CACHE_MAX = 3;
const JPEG_QUALITY = 65;

interface ThumbEntry {
  dataUrl: string;
  ts: number;
}

/** key = `${surfaceId}|${url}` */
const cache = new Map<string, ThumbEntry>();
let inFlight: Promise<string | null> | null = null;

function keyOf(surfaceId: string, url: string): string {
  return `${surfaceId}|${url}`;
}

function readCache(key: string): string | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  /* LRU: 命中就挪到队尾 */
  cache.delete(key);
  cache.set(key, hit);
  return hit.dataUrl;
}

function writeCache(key: string, dataUrl: string): void {
  cache.set(key, { dataUrl, ts: Date.now() });
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** 浏览器在不在跑 —— 纯查询, 不会把 Chrome 拉起来 */
export async function isBrowserRunning(): Promise<boolean> {
  try {
    const st = await (window as any).neox?.externalChromeStatus?.();
    return !!st?.running;
  } catch {
    return false;
  }
}

/**
 * 抓一张缩略图。已在跑才抓; 没在跑 / 抓失败一律返回 null (调用方就当没有缩略图)。
 * 缓存命中直接同步拿到, 不进 IPC。
 */
/**
 * @param fresh 跳过缓存直接重抓 —— 悬停期间的"活"刷新用。
 *   平时仍走 20s 缓存: 鼠标扫过一列时不该每行都触发一次栅格化。
 */
export async function getBrowserThumb(surfaceId: string, url: string, fresh = false): Promise<string | null> {
  if (!surfaceId) return null;
  const key = keyOf(surfaceId, url || '');

  if (!fresh) {
    const cached = readCache(key);
    if (cached) return cached;
  }

  /* 单飞: 在途时不再发第二个, 直接等它 (它抓的可能是别的 tab, 所以之后仍走缓存查) */
  if (inFlight) {
    await inFlight.catch(() => null);
    const afterWait = readCache(key);
    if (afterWait) return afterWait;
  }

  const task = (async (): Promise<string | null> => {
    if (!(await isBrowserRunning())) return null;
    try {
      const r = await (window as any).neox?.browserToolScreenshot?.({
        surfaceId,
        fullPage: false,
        format: 'jpeg',
        quality: JPEG_QUALITY,
      });
      const b64 = r?.base64 ?? r?.data ?? r?.screenshot;
      if (!r?.ok || typeof b64 !== 'string' || !b64) return null;
      const dataUrl = `data:image/jpeg;base64,${b64}`;
      writeCache(key, dataUrl);
      return dataUrl;
    } catch {
      return null;
    }
  })();

  inFlight = task;
  try {
    return await task;
  } finally {
    if (inFlight === task) inFlight = null;
  }
}
