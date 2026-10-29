/* base64 流里探测一段 ASCII 是否出现 —— 不把整份文件解码回二进制。
 *
 * 为什么要有它: SheetSurfaceViewer 曾经为了判断 xlsx 里有没有图表, 对整份
 * base64 做 `atob(base64)` 再 includes —— 5MB 的文件就是一次 5MB 字符串分配 +
 * 全量解码, 首屏白等几十毫秒, 而且只在探测一个字符串。
 *
 * 直接 `base64.includes(needle)` 也不行: base64 每 4 个字符对应 3 个字节,
 * needle 在文件里的起始字节偏移 mod 3 有 3 种情况, 每种编码出来的字符都不同。
 * 所以对 3 种对齐各生成一个「只包含完整 4 字符组」的 token, 再 includes。
 * token 放弃开头不完整组里的 1~2 个字节 (仍保留 needle 的绝大部分),
 * 足够判定, 也不会误判: token 里的每个字符都由 needle 的真实字节决定。
 */

function toBase64(binary: string): string {
  if (typeof globalThis.btoa === 'function') return globalThis.btoa(binary);
  /* Node 环境兜底 (单测跑在 node/jsdom) */
  return Buffer.from(binary, 'binary').toString('base64');
}

/** 为 3 种字节对齐各生成一个 token; 同一 needle 结果可以缓存。 */
const tokenCache = new Map<string, string[]>();

export function base64NeedleTokens(needle: string): string[] {
  const cached = tokenCache.get(needle);
  if (cached) return cached;
  const tokens: string[] = [];
  for (let shift = 0; shift < 3; shift++) {
    /* needle 第 0 个字节落在 3 字节组的第 shift 位; 第一个「整组起点」是 i0 */
    const i0 = (3 - shift) % 3;
    if (i0 >= needle.length) continue;
    const slice = needle.slice(i0);
    const wholeBytes = Math.floor(slice.length / 3) * 3;
    if (wholeBytes <= 0) continue;
    tokens.push(toBase64(slice.slice(0, wholeBytes)));
  }
  const deduped = Array.from(new Set(tokens));
  tokenCache.set(needle, deduped);
  return deduped;
}

/** base64 文本里是否包含这段 ASCII。空 needle / 空 base64 一律 false。 */
export function base64Mentions(base64: string, needle: string): boolean {
  if (!base64 || !needle || needle.length < 3) return false;
  for (const token of base64NeedleTokens(needle)) {
    if (token && base64.includes(token)) return true;
  }
  return false;
}
