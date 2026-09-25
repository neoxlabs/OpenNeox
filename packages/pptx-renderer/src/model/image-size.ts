/**
 * model/image-size — 从图片字节读真实尺寸 (PNG/JPEG/GIF/WebP header 解析 · 零依赖).
 *
 * 为什么: 旧 measure 对 image 拍 4:3 默认纵横比 → 实际图片比例不同时被 cover 裁切
 * 或产生意外留白. 真实尺寸在字节里就有, 读出来 aspect 就是事实不是猜测.
 *
 * 只解析 header (不解码像素), dataUrl 也只 decode 前 64KB 内的 base64.
 *
 * 【 从 compose 移过来】原来住在 compose/layout 里, 于是 exporter 用不上它 ——
 * 而 exporter 才是唯一"所有来源 (本地路径 / http / blob) 都已经内联成 data URL"的时刻。
 * compose 侧只认 data URL, 传本地路径就探不到尺寸, cover 裁剪静默失效, 图被拉伸变形。
 * compose 依赖 renderer (单向), 所以放这里两边都能用, **不是两份实现**。
 */

export interface ImageDims {
  width: number;
  height: number;
}

/** ImageNode.source 的各形态 → 尺寸. 拿不到 (uri/不支持格式) 返回 null. */
export function probeImageSize(source: unknown): ImageDims | null {
  const bytes = extractBytes(source);
  if (!bytes || bytes.length < 32) return null;
  return probePng(bytes) ?? probeJpeg(bytes) ?? probeGif(bytes) ?? probeWebp(bytes);
}

function extractBytes(source: unknown): Uint8Array | null {
  if (!source) return null;
  if (typeof source === 'string') {
    return source.startsWith('data:') ? dataUrlBytes(source) : null;
  }
  const s = source as Record<string, unknown>;
  if (typeof s.dataUrl === 'string') return dataUrlBytes(s.dataUrl);
  if (s.blob instanceof Uint8Array) return s.blob;
  if (s.blob instanceof ArrayBuffer) return new Uint8Array(s.blob);
  return null;
}

function dataUrlBytes(dataUrl: string): Uint8Array | null {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return null;
  const meta = dataUrl.slice(0, comma);
  if (!/;base64$/i.test(meta)) return null;
  /* header 解析只需前 ~64KB (JPEG EXIF 段可能很长, 64KB 覆盖绝大多数) */
  const b64 = dataUrl.slice(comma + 1, comma + 1 + 87400); /* 87400 b64 chars ≈ 64KB */
  try {
    if (typeof Buffer !== 'undefined') {
      const buf = Buffer.from(b64, 'base64');
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    }
    const bin = atob(b64.replace(/[^A-Za-z0-9+/=]/g, ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function probePng(b: Uint8Array): ImageDims | null {
  if (b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) return null;
  /* 8 字节签名 + 4 len + "IHDR" → width/height 各 4 字节 BE @ offset 16 */
  const width = (b[16]! << 24) | (b[17]! << 16) | (b[18]! << 8) | b[19]!;
  const height = (b[20]! << 24) | (b[21]! << 16) | (b[22]! << 8) | b[23]!;
  return width > 0 && height > 0 ? { width, height } : null;
}

function probeJpeg(b: Uint8Array): ImageDims | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1]!;
    /* SOF0/1/2 (baseline/extended/progressive) 含尺寸 */
    if (marker >= 0xc0 && marker <= 0xc2) {
      const height = (b[i + 5]! << 8) | b[i + 6]!;
      const width = (b[i + 7]! << 8) | b[i + 8]!;
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; }
    const len = (b[i + 2]! << 8) | b[i + 3]!;
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

function probeGif(b: Uint8Array): ImageDims | null {
  if (b[0] !== 0x47 || b[1] !== 0x49 || b[2] !== 0x46) return null;
  const width = b[6]! | (b[7]! << 8);
  const height = b[8]! | (b[9]! << 8);
  return width > 0 && height > 0 ? { width, height } : null;
}

function probeWebp(b: Uint8Array): ImageDims | null {
  /* RIFF....WEBP */
  if (b[0] !== 0x52 || b[1] !== 0x49 || b[2] !== 0x46 || b[3] !== 0x46) return null;
  if (b[8] !== 0x57 || b[9] !== 0x45 || b[10] !== 0x42 || b[11] !== 0x50) return null;
  const fourcc = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!);
  if (fourcc === 'VP8X') {
    const width = 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16));
    const height = 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16));
    return { width, height };
  }
  if (fourcc === 'VP8 ') {
    const width = (b[26]! | (b[27]! << 8)) & 0x3fff;
    const height = (b[28]! | (b[29]! << 8)) & 0x3fff;
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (fourcc === 'VP8L') {
    const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return { width, height };
  }
  return null;
}
