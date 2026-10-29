/**
 * App badge — macOS Dock number + Windows taskbar overlay (bottom-right corner).
 *
 * Windows has no dock.setBadge; the equivalent is BrowserWindow.setOverlayIcon.
 */
import { app, BrowserWindow, nativeImage, type NativeImage } from 'electron';
import { deflateSync } from 'zlib';

let lastCount = -1;

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** Minimal RGBA → PNG encoder (no deps — safe inside packaged Electron). */
function encodePngRGBA(width: number, height: number, rgba: Buffer): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/* 3×5 digit bitmaps (1 = ink). Compact so 16×16 overlay stays readable. */
const DIGITS: Record<string, number[]> = {
  '0': [0b111, 0b101, 0b101, 0b101, 0b111],
  '1': [0b010, 0b110, 0b010, 0b010, 0b111],
  '2': [0b111, 0b001, 0b111, 0b100, 0b111],
  '3': [0b111, 0b001, 0b111, 0b001, 0b111],
  '4': [0b101, 0b101, 0b111, 0b001, 0b001],
  '5': [0b111, 0b100, 0b111, 0b001, 0b111],
  '6': [0b111, 0b100, 0b111, 0b101, 0b111],
  '7': [0b111, 0b001, 0b010, 0b010, 0b010],
  '8': [0b111, 0b101, 0b111, 0b101, 0b111],
  '9': [0b111, 0b101, 0b111, 0b001, 0b111],
  '+': [0b000, 0b010, 0b111, 0b010, 0b000],
};

function drawDigit(rgba: Buffer, size: number, ch: string, ox: number, oy: number): void {
  const rows = DIGITS[ch];
  if (!rows) return;
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      if (((rows[y] >> (2 - x)) & 1) === 0) continue;
      const px = ox + x;
      const py = oy + y;
      if (px < 0 || py < 0 || px >= size || py >= size) continue;
      const i = (py * size + px) * 4;
      rgba[i] = 255;
      rgba[i + 1] = 255;
      rgba[i + 2] = 255;
      rgba[i + 3] = 255;
    }
  }
}

function createOverlayBadge(count: number): NativeImage {
  const size = 32;
  const rgba = Buffer.alloc(size * size * 4, 0);
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const r = size / 2 - 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > r) continue;
      const i = (y * size + x) * 4;
      /* NeoX accent-adjacent red for unread attention */
      rgba[i] = 220;
      rgba[i + 1] = 50;
      rgba[i + 2] = 47;
      rgba[i + 3] = d > r - 1 ? Math.round(255 * (r - d)) : 255;
    }
  }

  const label = count > 99 ? '99+' : String(Math.max(1, Math.floor(count)));
  const glyphW = label.length * 4 - 1; /* 3px glyph + 1px gap */
  let ox = Math.floor((size - glyphW) / 2);
  const oy = Math.floor((size - 5) / 2);
  for (const ch of label) {
    drawDigit(rgba, size, ch, ox, oy);
    ox += 4;
  }

  return nativeImage.createFromBuffer(encodePngRGBA(size, size, rgba));
}

/** Sync Dock / taskbar badge. count <= 0 clears. */
export function setAppBadgeCount(count: number, opts?: { force?: boolean }): void {
  const n = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  if (!opts?.force && n === lastCount) return;
  lastCount = n;

  if (process.platform === 'darwin' && app.dock) {
    app.dock.setBadge(n > 0 ? (n > 99 ? '99+' : String(n)) : '');
  }

  /* Linux Unity / some DEs */
  try {
    if (process.platform === 'linux') app.setBadgeCount(n);
  } catch {
    /* ignore */
  }

  if (process.platform === 'win32') {
    const overlay = n > 0 ? createOverlayBadge(n) : null;
    const description = n > 0 ? `${n} unread` : '';
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      try {
        win.setOverlayIcon(overlay, description);
      } catch (err) {
        console.warn('[Badge] setOverlayIcon failed:', err);
      }
    }
  }
}

/** Re-apply last badge to all windows (e.g. after a new BrowserWindow is created). */
export function reapplyAppBadge(): void {
  const n = lastCount < 0 ? 0 : lastCount;
  lastCount = -1;
  setAppBadgeCount(n, { force: true });
}
