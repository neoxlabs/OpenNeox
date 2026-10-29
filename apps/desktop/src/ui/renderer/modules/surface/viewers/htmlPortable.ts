/**
 * 把网页引用的本地文件 (图片 / 样式 / 脚本 / 字体) 打进同一个 HTML —— 单文件就能带走。
 *
 * 两个用处:
 *   1. 预览: iframe 是不透明源, 读不到网页旁边的 classroom-bg.png 这类相对路径, 不打包就是破图。
 *   2. 带走: 老师存到 U 盘、拷到教室电脑双击打开 —— 只拷一个文件, 图片不能丢。
 *
 * 只动相对路径 (和本机绝对路径); http(s) / data: / # / 协议链接原样不动。读不到的保持原样, 不报错。
 */

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', ico: 'image/x-icon', avif: 'image/avif',
  css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', json: 'application/json',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm',
};

/** 单个文件超过这个就不内联 (视频这类), 免得一个 HTML 几百 MB 卡死预览 */
const MAX_INLINE_BYTES = 12 * 1024 * 1024;

export function isLocalRef(ref: string): boolean {
  const r = ref.trim();
  if (!r || r.startsWith('#') || r.startsWith('//')) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(r) && !/^[a-z]:[\\/]/i.test(r)) return false; // http: data: blob: mailto: …; C:\ 例外
  return true;
}

export function mimeOf(ref: string): string | null {
  const ext = ref.split(/[?#]/)[0].split('.').pop()?.toLowerCase() || '';
  return MIME[ext] ?? null;
}

export function resolveRef(baseDir: string, ref: string): string {
  const clean = decodeURI(ref.split(/[?#]/)[0]);
  if (clean.startsWith('/') || /^[a-z]:[\\/]/i.test(clean)) return clean;
  const sep = baseDir.includes('\\') && !baseDir.includes('/') ? '\\' : '/';
  const parts = baseDir.replace(/[\\/]+$/, '').split(/[\\/]/);
  for (const seg of clean.split(/[\\/]/)) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop(); else parts.push(seg);
  }
  return parts.join(sep);
}

/** 找出所有要内联的本地引用 (去重)。纯函数, 便于单测。 */
export function collectLocalRefs(html: string): string[] {
  const out = new Set<string>();
  const add = (r: string) => { if (isLocalRef(r) && mimeOf(r)) out.add(r); };
  for (const m of html.matchAll(/\b(?:src|href|poster)\s*=\s*(["'])(.*?)\1/gi)) add(m[2]);
  for (const m of html.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi)) add(m[2]);
  return [...out];
}

export function replaceRefs(html: string, map: Map<string, string>): string {
  if (!map.size) return html;
  return html
    .replace(/\b(src|href|poster)(\s*=\s*)(["'])(.*?)\3/gi, (all, a, eq, q, ref) => map.has(ref) ? `${a}${eq}${q}${map.get(ref)}${q}` : all)
    .replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (all, q, ref) => map.has(ref) ? `url(${q}${map.get(ref)}${q})` : all);
}

type ReadBase64 = (absPath: string) => Promise<string | null>;

/** 打包: 返回内联后的 HTML 和内联了几个文件。 */
export async function inlineLocalAssets(html: string, baseDir: string, readBase64: ReadBase64): Promise<{ html: string; inlined: number }> {
  const refs = collectLocalRefs(html);
  if (!refs.length || !baseDir) return { html, inlined: 0 };
  const map = new Map<string, string>();
  await Promise.all(refs.map(async (ref) => {
    try {
      const b64 = await readBase64(resolveRef(baseDir, ref));
      if (!b64 || b64.length * 0.75 > MAX_INLINE_BYTES) return;
      map.set(ref, `data:${mimeOf(ref)};base64,${b64}`);
    } catch { /* 读不到就保持原样 */ }
  }));
  return { html: replaceRefs(html, map), inlined: map.size };
}

export function dirOf(filePath: string): string {
  return filePath.replace(/[\\/][^\\/]*$/, '');
}
