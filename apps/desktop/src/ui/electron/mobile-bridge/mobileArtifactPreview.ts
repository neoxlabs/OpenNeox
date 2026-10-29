import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';
import { lookupArtifact } from './artifactRegistry.js';
import { hasAlpha, lookupImageVariant, type ImageMeta } from './mobileImageVariant.js';
import { lookupStashedImage } from './mobileImageStash.js';

const THUMB_RE = /^thumb-(art-[0-9a-f-]{36})@(\d{3,4})$/;
const DIR = join(homedir(), NEOX_HOME_DIRNAME, 'mobile-images', 'variants');
const JPEG_QUALITY = 80;
/** 网页整页截图最高多少 (按 1280 宽算), 再长的截前面这段 */
const PAGE_MAX_HEIGHT = 12_000;
const PAGE_TIMEOUT_MS = 15_000;
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);

const inflight = new Map<string, Promise<ImageMeta | null>>();

/**
 * file.fetch 能取的全部 id:
 *   art-…              agent 报出的产物原件 (artifactRegistry)
 *   img-<sha>.<ext>    消息里按引用的图 (mobileImageStash); 加 @<长边> = 现压缩略图 (mobileImageVariant)
 *   thumb-art-…@<长边> 产物预览图 (本文件)
 */
export async function lookupFetchable(id: string): Promise<ImageMeta | null> {
  return lookupArtifact(id) ?? lookupStashedImage(id) ?? (await lookupImageVariant(id)) ?? (await lookupArtifactPreview(id));
}

/** `thumb-<产物 id>@<长边>` → 预览图 (首次现出); 不是这种 id 返回 null */
export function lookupArtifactPreview(id: string): Promise<ImageMeta | null> | null {
  const m = THUMB_RE.exec(id);
  if (!m) return null;
  const art = lookupArtifact(m[1]);
  if (!art) return Promise.resolve(null);
  const edge = Math.min(2048, Math.max(320, Number(m[2])));
  const key = `thumb-${art.fingerprint}@${edge}`;
  let p = inflight.get(key);
  if (!p) {
    p = makePreview(art.absPath, key, edge)
      .catch(() => null)
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

async function makePreview(absPath: string, key: string, edge: number): Promise<ImageMeta | null> {
  for (const ext of ['jpg', 'png']) {
    const p = join(DIR, `${key}.${ext}`);
    if (existsSync(p)) return meta(p, `${key}.${ext}`);
  }
  const { nativeImage } = await import('electron');
  const ext = extname(absPath).toLowerCase();
  let img: Electron.NativeImage;
  if (ext === '.html' || ext === '.htm') {
    img = await capturePage(absPath);
  } else if (IMAGE_EXTS.has(ext)) {
    img = nativeImage.createFromPath(absPath);
  } else {
    img = await nativeImage.createThumbnailFromPath(absPath, { width: edge, height: edge });
  }
  if (img.isEmpty()) return null;
  const { width, height } = img.getSize();
  /* 网页按宽缩 (长图), 其余按长边 */
  const isPage = ext === '.html' || ext === '.htm';
  const scaled = isPage
    ? width > edge ? img.resize({ width: edge, quality: 'good' }) : img
    : Math.max(width, height) > edge
      ? img.resize(width >= height ? { width: edge, quality: 'good' } : { height: edge, quality: 'good' })
      : img;
  /* 透明: 图片本身带透明的留 PNG; 系统缩略图 (Office 页边透明) 铺白底转 JPEG, 小好几倍 */
  const keepAlpha = IMAGE_EXTS.has(ext) && hasAlpha(scaled.toBitmap());
  const flat = keepAlpha || isPage ? scaled : onWhite(nativeImage, scaled);
  const outExt = keepAlpha ? 'png' : 'jpg';
  const bytes = keepAlpha ? flat.toPNG() : flat.toJPEG(JPEG_QUALITY);
  mkdirSync(DIR, { recursive: true });
  const name = `${key}.${outExt}`;
  const out = join(DIR, name);
  writeFileSync(`${out}.tmp`, bytes);
  renameSync(`${out}.tmp`, out);
  return meta(out, name);
}

/** 透明像素铺到白底上 (BGRA 预乘之前的直通 alpha 按普通混合算) */
function onWhite(ni: typeof Electron.nativeImage, img: Electron.NativeImage): Electron.NativeImage {
  const { width, height } = img.getSize();
  const px = Buffer.from(img.toBitmap());
  if (!hasAlpha(px)) return img;
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3] / 255;
    px[i] = Math.round(px[i] * a + 255 * (1 - a));
    px[i + 1] = Math.round(px[i + 1] * a + 255 * (1 - a));
    px[i + 2] = Math.round(px[i + 2] * a + 255 * (1 - a));
    px[i + 3] = 255;
  }
  return ni.createFromBitmap(px, { width, height });
}

/** 后台窗口打开网页, 等加载完撑到整页高度再截 */
async function capturePage(absPath: string): Promise<Electron.NativeImage> {
  const { BrowserWindow, nativeImage } = await import('electron');
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  /* 网页里的链接 / 弹窗一律不跟 */
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  try {
    await Promise.race([
      win.loadFile(absPath),
      new Promise((_, rej) => setTimeout(() => rej(new Error('page load timeout')), PAGE_TIMEOUT_MS)),
    ]);
    /* 等字体和首屏动画落定 */
    await win.webContents.executeJavaScript('document.fonts ? document.fonts.ready.then(() => 1) : 1', true);
    await new Promise((r) => setTimeout(r, 400));
    const h = Number(
      await win.webContents.executeJavaScript(
        'Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)',
        true,
      ),
    );
    const height = Math.min(PAGE_MAX_HEIGHT, Math.max(800, Number.isFinite(h) ? h : 800));
    win.setContentSize(1280, height);
    await new Promise((r) => setTimeout(r, 300));
    return await win.webContents.capturePage({ x: 0, y: 0, width: 1280, height });
  } catch {
    return nativeImage.createEmpty();
  } finally {
    win.destroy();
  }
}

function meta(absPath: string, name: string): ImageMeta {
  return {
    absPath,
    name,
    mime: name.endsWith('.png') ? 'image/png' : 'image/jpeg',
    sizeBytes: statSync(absPath).size,
  };
}
