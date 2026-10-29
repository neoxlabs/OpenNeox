import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

export const MOBILE_IMAGE_SCHEME = 'neox-image://';
const DIR = join(homedir(), NEOX_HOME_DIRNAME, 'mobile-images');
/** 太小的不值得落盘 (图标类 data URL 直接丢占位也无所谓), 太大的不给手机 */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
};
const MIME_BY_EXT: Record<string, string> = Object.fromEntries(
  Object.entries(EXT_BY_MIME).map(([m, e]) => [e, m]),
);

const NAME_RE = /^([a-f0-9]{64})\.(png|jpg|webp|gif|bmp|svg)$/;

let dirReady = false;
function ensureDir(): void {
  if (dirReady) return;
  mkdirSync(DIR, { recursive: true });
  dirReady = true;
}

/**
 * base64 图片 → 落盘 → 返回 markdown 图片文本。失败 (格式不认 / 太大 / 写盘失败) 返回 null,
 * 调用方退回 `[图片]` 占位。同步写 —— 调用方 (瘦身) 是同步的, 内容寻址所以同图只写一次。
 */
export function stashImage(mime: string, base64: string): string | null {
  try {
    const ext = EXT_BY_MIME[mime.toLowerCase()];
    if (!ext || !base64) return null;
    const buf = Buffer.from(base64, 'base64');
    if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) return null;
    const sha = createHash('sha256').update(buf).digest('hex');
    const name = `${sha}.${ext}`;
    const p = join(DIR, name);
    if (!existsSync(p)) {
      ensureDir();
      writeFileSync(p, buf);
    }
    return `![](${MOBILE_IMAGE_SCHEME}${name})`;
  } catch {
    return null;
  }
}

/** `data:image/png;base64,....` → markdown 图片; 不是 data URL 返回 null */
export function stashDataUrl(url: string): string | null {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/is.exec(url);
  if (!m) return null;
  return stashImage(m[1], m[2]);
}

export function stashImageFile(absPath: string): string | null {
  try {
    const ext = absPath.slice(absPath.lastIndexOf('.') + 1).toLowerCase();
    const mime = MIME_BY_EXT[ext === 'jpeg' ? 'jpg' : ext];
    const absolute = absPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(absPath);
    if (!mime || !absolute) return null;
    const st = statSync(absPath);
    if (!st.isFile() || st.size === 0 || st.size > MAX_IMAGE_BYTES) return null;
    const md = stashImage(mime, readFileSync(absPath).toString('base64'));
    return md ? md.slice(4, -1) : null;
  } catch {
    return null;
  }
}

/* 相对路径的图 (`![图](charts/sales.png)`, agent 最常这么写) 要知道会话的项目目录才找得到文件。
 * 瘦身是同步的、拿不到会话, 所以由拿得到的地方 (拉历史 / 手机发消息) 先记下 sessionId → 目录,
 * 瘦身前按 sessionId 设好当前目录。 */
const sessionImageBase = new Map<string, string>();
let currentImageBase: string | null = null;

export function rememberSessionImageBase(sessionId: string, dir: string | undefined | null): void {
  if (sessionId && dir) sessionImageBase.set(sessionId, dir);
}

export function withSessionImageBase<T>(sessionId: string, fn: () => T): T {
  const prev = currentImageBase;
  currentImageBase = sessionImageBase.get(sessionId) ?? null;
  try { return fn(); } finally { currentImageBase = prev; }
}

/** 相对路径按当前会话目录解析; 解析出来跑出了项目目录 (`../`) 的不收 */
export function resolveSessionImagePath(p: string): string | null {
  if (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)) return p;
  if (!currentImageBase) return null;
  const abs = resolve(currentImageBase, p);
  return abs.startsWith(resolve(currentImageBase) + sep) ? abs : null;
}

/** file.fetch 用: `img-<sha>.<ext>` → 真实路径与元数据; 不合规 / 不存在返回 null */
export function lookupStashedImage(id: string): { absPath: string; name: string; mime: string; sizeBytes: number } | null {
  if (!id.startsWith('img-')) return null;
  const name = id.slice(4);
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const absPath = join(DIR, name);
  try {
    const st = statSync(absPath);
    if (!st.isFile()) return null;
    return { absPath, name, mime: MIME_BY_EXT[m[2]] ?? 'application/octet-stream', sizeBytes: st.size };
  } catch {
    return null;
  }
}
