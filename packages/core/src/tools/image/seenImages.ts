
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { neoxHome } from '@neoxlabs/kernel/platform/neoxHome.js';
import { IMAGE_RESULT_PREFIX } from './imageProcessor.js';

export const SEEN_IMAGES_PREFIX = '__NEOX_SEEN_IMAGES__';

const RETAIN_MS = 30 * 24 * 60 * 60 * 1000;

export interface SeenImageRef {
  path: string;
  label?: string;
}

export function seenImagesDir(): string {
  return neoxHome('run', 'seen');
}

const EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
};

let prunedThisProcess = false;

function pruneOld(dir: string): void {
  if (prunedThisProcess) return;
  prunedThisProcess = true;
  const cutoff = Date.now() - RETAIN_MS;
  try {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      try { if (statSync(p).mtimeMs < cutoff) unlinkSync(p); } catch { /* 别人正在读 / 已经没了 */ }
    }
  } catch { /* 清理失败绝不该影响落图 */ }
}

/** 一张 base64 落盘, 返回路径; 格式不认识 (svg 之类) 或写不进去就返回 undefined。 */
function persist(base64: string, mediaType: string): string | undefined {
  const ext = EXT[mediaType.toLowerCase()];
  if (!ext) return undefined;
  try {
    const buf = Buffer.from(base64, 'base64');
    if (buf.length === 0) return undefined;
    const dir = seenImagesDir();
    mkdirSync(dir, { recursive: true });
    pruneOld(dir);
    const file = join(dir, `${createHash('sha1').update(buf).digest('hex').slice(0, 20)}.${ext}`);
    if (!existsSync(file)) writeFileSync(file, buf);
    return file;
  } catch {
    return undefined;
  }
}

interface Payload { images?: Array<{ data?: unknown; media_type?: unknown; label?: unknown }>; text?: unknown }

/** `__NEOX_IMAGE_RESULT__{…}` → 标记串; 解不开或一张都没落成就返回 null (调用方原样放过) */
function convertPayload(raw: string): string | null {
  let parsed: Payload;
  try { parsed = JSON.parse(raw.slice(IMAGE_RESULT_PREFIX.length)) as Payload; } catch { return null; }
  if (!Array.isArray(parsed?.images)) return null;
  const images: SeenImageRef[] = [];
  for (const img of parsed.images) {
    if (typeof img?.data !== 'string' || !img.data) continue;
    const path = persist(img.data, typeof img.media_type === 'string' && img.media_type ? img.media_type : 'image/jpeg');
    if (!path) continue;
    images.push({ path, ...(typeof img.label === 'string' && img.label ? { label: img.label } : {}) });
  }
  if (images.length === 0) return null;
  return SEEN_IMAGES_PREFIX + JSON.stringify({
    images,
    ...(typeof parsed.text === 'string' && parsed.text.trim() ? { text: parsed.text } : {}),
  });
}

export function externalizeToolImages(output: string): string {
  if (typeof output !== 'string' || !output.includes(IMAGE_RESULT_PREFIX)) return output;
  if (output.startsWith(IMAGE_RESULT_PREFIX)) return convertPayload(output) ?? output;
  if (output.trimStart().startsWith('{')) {
    try {
      const env = JSON.parse(output) as { content?: unknown };
      if (env && typeof env.content === 'string' && env.content.startsWith(IMAGE_RESULT_PREFIX)) {
        const converted = convertPayload(env.content);
        return converted ? JSON.stringify({ ...env, content: converted }) : output;
      }
    } catch { /* 不是完整 JSON, 走下面按位置找 */ }
  }
  const idx = output.indexOf(IMAGE_RESULT_PREFIX);
  const converted = convertPayload(output.slice(idx));
  return converted ? output.slice(0, idx) + converted : output;
}
