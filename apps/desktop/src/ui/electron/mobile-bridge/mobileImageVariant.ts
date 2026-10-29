import { existsSync, mkdirSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { lookupStashedImage } from './mobileImageStash.js';

const VARIANT_RE = /^(img-[a-f0-9]{64}\.(?:png|jpg|webp|gif|bmp|svg))@(\d{3,4})$/;
/** 允许的长边: 太小糊, 太大没意义 */
const MIN_EDGE = 320;
const MAX_EDGE = 2048;
/** 原图本来就小于这个且尺寸不超, 直接给原图, 不重压 */
const SMALL_ENOUGH_BYTES = 160 * 1024;
const JPEG_QUALITY = 80;

export interface ImageMeta {
  absPath: string;
  name: string;
  mime: string;
  sizeBytes: number;
}

const inflight = new Map<string, Promise<ImageMeta | null>>();

/** `img-<name>@<edge>` → 压好的图 (首次现压); 不是这种 id 返回 null */
export function lookupImageVariant(id: string): Promise<ImageMeta | null> | null {
  const m = VARIANT_RE.exec(id);
  if (!m) return null;
  const orig = lookupStashedImage(m[1]);
  if (!orig) return Promise.resolve(null);
  const edge = Math.min(MAX_EDGE, Math.max(MIN_EDGE, Number(m[2])));
  const key = `${orig.name}@${edge}`;
  let p = inflight.get(key);
  if (!p) {
    p = makeVariant(orig, edge).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

async function makeVariant(orig: ImageMeta, edge: number): Promise<ImageMeta | null> {
  /* svg / gif 不压: svg 本来就小, gif 压了会丢动画 */
  if (/\.(svg|gif)$/.test(orig.name)) return orig;
  const base = orig.name.replace(/\.[a-z]+$/, '');
  const dir = join(dirname(orig.absPath), 'variants');
  for (const ext of ['jpg', 'png']) {
    const p = join(dir, `${base}@${edge}.${ext}`);
    if (existsSync(p)) return { absPath: p, name: `${base}@${edge}.${ext}`, mime: mimeOf(ext), sizeBytes: statSync(p).size };
  }
  const { nativeImage } = await import('electron');
  const img = nativeImage.createFromPath(orig.absPath);
  if (img.isEmpty()) return orig;
  const { width, height } = img.getSize();
  const longEdge = Math.max(width, height);
  if (longEdge <= edge && orig.sizeBytes <= SMALL_ENOUGH_BYTES) return orig;
  const scaled =
    longEdge > edge
      ? img.resize(width >= height ? { width: edge, quality: 'good' } : { height: edge, quality: 'good' })
      : img;
  /* 带透明的图转 JPEG 会变黑底, 这种留 PNG (缩过尺寸也小很多) */
  const alpha = hasAlpha(scaled.toBitmap());
  const ext = alpha ? 'png' : 'jpg';
  const bytes = alpha ? scaled.toPNG() : scaled.toJPEG(JPEG_QUALITY);
  /* 压完反而更大 (已经是高压缩小图) 就给原图 */
  if (bytes.length >= orig.sizeBytes) return orig;
  mkdirSync(dir, { recursive: true });
  const name = `${base}@${edge}.${ext}`;
  const out = join(dir, name);
  writeFileSync(`${out}.tmp`, bytes);
  renameSync(`${out}.tmp`, out);
  return { absPath: out, name, mime: mimeOf(ext), sizeBytes: bytes.length };
}

/** BGRA 位图里有没有不透明度 < 255 的像素 (每 4 字节第 4 个是 alpha) */
export function hasAlpha(bgra: Buffer): boolean {
  for (let i = 3; i < bgra.length; i += 4) if (bgra[i] !== 255) return true;
  return false;
}

function mimeOf(ext: string): string {
  return ext === 'png' ? 'image/png' : 'image/jpeg';
}
