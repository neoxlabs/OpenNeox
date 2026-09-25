/**
 * imageUrlNormalize — 发线之前把 image_url.url 归一成协议认得的形状。
 *
 * ## 发送边界
 *
 * data、http(s) 和 blob URL 原样保留；裸 base64 统一补成 data URL。
 *
 * 归一逻辑在发线前统一执行，避免不同图片入口产生不同协议形状。
 */

/** 认得的图片魔数 → mime。base64 前几个字符就能判, 不用解码。 */
const B64_MAGIC: Array<[RegExp, string]> = [
  [/^iVBORw0KGgo/, 'image/png'],
  [/^\/9j\//, 'image/jpeg'],
  [/^R0lGOD/, 'image/gif'],
  [/^UklGR/, 'image/webp'],
  [/^Qk/, 'image/bmp'],
];

/** 看起来像 base64 图片数据 (够长 + 只有 base64 字符)。 */
function looksLikeBareBase64(s: string): boolean {
  if (s.length < 32) return false;
  return /^[A-Za-z0-9+/\r\n]+={0,2}$/.test(s);
}

/**
 * 归一 image_url.url:
 *   · `data:` / `http(s):` / `blob:` → 原样返回 (已经是协议认得的形状);
 *   · 裸 base64 → 按魔数补 `data:<mime>;base64,` 前缀 (认不出魔数时用 fallback);
 *   · 其余 (空串 / 本地路径 / 乱码) → 原样返回, 让上游给出准确的错误。
 *     我们不猜, 也不静默丢弃 —— 上游的 400 是准确信息, 我们的猜测不是。
 */
export function normalizeImageUrl(url: string, fallbackMime = 'image/png'): string {
  if (typeof url !== 'string' || url.length === 0) return url;
  if (/^(data:|https?:|blob:)/i.test(url)) return url;
  if (!looksLikeBareBase64(url)) return url;
  const mime = B64_MAGIC.find(([re]) => re.test(url))?.[1] ?? fallbackMime;
  return `data:${mime};base64,${url}`;
}

/**
 * 就地归一一条消息里所有 image_url 块 —— 只在需要改时返回新对象, 否则原样引用
 * (发线路径每轮都会走, 不该无谓地复制整个历史)。绝不 mutate 入参。
 */
export function normalizeImagePartsInContent<T>(content: T): T {
  if (!Array.isArray(content)) return content;
  let changed = false;
  const out = (content as unknown as any[]).map((part) => {
    if (!part || part.type !== 'image_url' || typeof part.image_url?.url !== 'string') return part;
    const next = normalizeImageUrl(part.image_url.url);
    if (next === part.image_url.url) return part;
    changed = true;
    return { ...part, image_url: { ...part.image_url, url: next } };
  });
  return (changed ? out : content) as unknown as T;
}
