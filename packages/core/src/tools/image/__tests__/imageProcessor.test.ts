import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import {
  isImageFile,
  isPdfFile,
  detectImageFormatFromBuffer,
  getMediaTypeFromExtension,
  readImageFile,
  buildImageToolResult,
  IMAGE_RESULT_PREFIX,
  compressImageDataUrlIfNeeded,
} from '../imageProcessor.js';

describe('isImageFile', () => {
  it('detects common image extensions', () => {
    expect(isImageFile('photo.png')).toBe(true);
    expect(isImageFile('photo.jpg')).toBe(true);
    expect(isImageFile('photo.jpeg')).toBe(true);
    expect(isImageFile('photo.gif')).toBe(true);
    expect(isImageFile('photo.webp')).toBe(true);
    expect(isImageFile('icon.svg')).toBe(true);
    expect(isImageFile('icon.bmp')).toBe(true);
  });

  it('rejects non-image files', () => {
    expect(isImageFile('main.ts')).toBe(false);
    expect(isImageFile('readme.md')).toBe(false);
    expect(isImageFile('data.json')).toBe(false);
    expect(isImageFile('script.py')).toBe(false);
  });

  it('is case-insensitive on extension', () => {
    expect(isImageFile('Photo.PNG')).toBe(true);
    expect(isImageFile('Photo.JPG')).toBe(true);
  });
});

describe('isPdfFile', () => {
  it('detects PDF files', () => {
    expect(isPdfFile('doc.pdf')).toBe(true);
    expect(isPdfFile('Doc.PDF')).toBe(true);
  });

  it('rejects non-PDF files', () => {
    expect(isPdfFile('doc.txt')).toBe(false);
    expect(isPdfFile('image.png')).toBe(false);
  });
});

describe('detectImageFormatFromBuffer', () => {
  it('detects PNG', () => {
    const buffer = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    expect(detectImageFormatFromBuffer(buffer)).toBe('image/png');
  });

  it('detects JPEG', () => {
    const buffer = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);
    expect(detectImageFormatFromBuffer(buffer)).toBe('image/jpeg');
  });

  it('detects GIF', () => {
    const buffer = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    expect(detectImageFormatFromBuffer(buffer)).toBe('image/gif');
  });

  it('detects WebP', () => {
    const buffer = Buffer.from([
      0x52, 0x49, 0x46, 0x46, // RIFF
      0x00, 0x00, 0x00, 0x00, // size (placeholder)
      0x57, 0x45, 0x42, 0x50, // WEBP
    ]);
    expect(detectImageFormatFromBuffer(buffer)).toBe('image/webp');
  });

  it('returns null for unknown format', () => {
    const buffer = Buffer.from([0x00, 0x00, 0x00, 0x00]);
    expect(detectImageFormatFromBuffer(buffer)).toBeNull();
  });

  it('returns null for too-small buffer', () => {
    expect(detectImageFormatFromBuffer(Buffer.from([0x89]))).toBeNull();
  });
});

describe('getMediaTypeFromExtension', () => {
  it('maps extensions correctly', () => {
    expect(getMediaTypeFromExtension('file.png')).toBe('image/png');
    expect(getMediaTypeFromExtension('file.jpg')).toBe('image/jpeg');
    expect(getMediaTypeFromExtension('file.jpeg')).toBe('image/jpeg');
    expect(getMediaTypeFromExtension('file.gif')).toBe('image/gif');
    expect(getMediaTypeFromExtension('file.webp')).toBe('image/webp');
    expect(getMediaTypeFromExtension('file.svg')).toBe('image/svg+xml');
  });

  it('defaults to image/png for unknown', () => {
    expect(getMediaTypeFromExtension('file.bmp')).toBe('image/png');
  });
});

describe('readImageFile', () => {
  it('reads a real PNG file', async () => {
    // Create a minimal 1x1 PNG
    const pngBytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    const tmpDir = path.join(os.tmpdir(), `neox-test-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, 'test.png');
    await fs.writeFile(tmpFile, pngBytes);

    try {
      const result = await readImageFile(tmpFile);
      expect(result.mediaType).toBe('image/png');
      expect(result.base64).toBeTruthy();
      expect(result.rawSize).toBe(pngBytes.length);
      expect(result.dataUrl).toMatch(/^data:image\/png;base64,/);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('compressImageDataUrlIfNeeded', () => {
  it('leaves non-data-url input untouched', async () => {
    const r = await compressImageDataUrlIfNeeded('https://example.com/a.png');
    expect(r.compressed).toBe(false);
    expect(r.url).toBe('https://example.com/a.png');
  });

  it('leaves small in-budget images untouched and reports dimensions', async () => {
    const sharp = (await import('sharp')).default;
    const buf = await sharp({
      create: { width: 100, height: 80, channels: 3, background: { r: 10, g: 20, b: 30 } },
    }).png().toBuffer();
    const dataUrl = `data:image/png;base64,${buf.toString('base64')}`;
    const r = await compressImageDataUrlIfNeeded(dataUrl);
    expect(r.compressed).toBe(false);
    expect(r.url).toBe(dataUrl);
    expect(r.width).toBe(100);
    expect(r.height).toBe(80);
  });

  it('compresses large-dimension but small-byte images (pixel trigger)', async () => {
    const sharp = (await import('sharp')).default;
    // 3200×2400 纯色 JPEG: 高压缩率 → base64 远小于 1.2MB 字节预算, 但像素巨大
    const buf = await sharp({
      create: { width: 3200, height: 2400, channels: 3, background: { r: 200, g: 200, b: 200 } },
    }).jpeg({ quality: 80 }).toBuffer();
    const dataUrl = `data:image/jpeg;base64,${buf.toString('base64')}`;
    expect(buf.toString('base64').length).toBeLessThan(1.2 * 1024 * 1024); // 前提: 字节确实没超
    const r = await compressImageDataUrlIfNeeded(dataUrl);
    expect(r.compressed).toBe(true);
    expect(r.width).toBeLessThanOrEqual(1568);
    expect(r.height).toBeLessThanOrEqual(1568);
    expect(Math.max(r.width!, r.height!)).toBe(1568);
    expect(r.url.startsWith('data:image/jpeg;base64,')).toBe(true);
  });

  it('compresses over-budget byte-heavy images (byte trigger)', async () => {
    const sharp = (await import('sharp')).default;
    // 噪声图很难压 → 字节超预算
    const noise = Buffer.alloc(2000 * 1500 * 3);
    for (let i = 0; i < noise.length; i++) noise[i] = Math.floor(Math.random() * 256);
    const buf = await sharp(noise, { raw: { width: 2000, height: 1500, channels: 3 } })
      .png({ compressionLevel: 0 }).toBuffer();
    const b64 = buf.toString('base64');
    expect(b64.length).toBeGreaterThan(1.2 * 1024 * 1024);
    const r = await compressImageDataUrlIfNeeded(`data:image/png;base64,${b64}`);
    expect(r.compressed).toBe(true);
    expect(r.compressedBytes).toBeLessThan(r.originalBytes);
  });

  it('skips dimension check for gif (bytes-only trigger)', async () => {
    const sharp = (await import('sharp')).default;
    let gifBuf: Buffer;
    try {
      gifBuf = await sharp({
        create: { width: 2000, height: 1800, channels: 3, background: { r: 5, g: 5, b: 5 } },
      }).gif().toBuffer();
    } catch {
      return; // 本机 libvips 不支持 gif 输出 → 跳过
    }
    const dataUrl = `data:image/gif;base64,${gifBuf.toString('base64')}`;
    if (gifBuf.toString('base64').length > 1.2 * 1024 * 1024) return; // 字节超了就不构成本用例
    const r = await compressImageDataUrlIfNeeded(dataUrl);
    expect(r.compressed).toBe(false); // 大尺寸但字节在预算内 → gif 不压
    expect(r.url).toBe(dataUrl);
  });
});

describe('buildImageToolResult', () => {
  it('builds result with prefix', () => {
    const result = buildImageToolResult([{
      base64: 'abc123',
      mediaType: 'image/png',
      label: 'test.png',
    }]);

    expect(result.startsWith(IMAGE_RESULT_PREFIX)).toBe(true);
    const payload = JSON.parse(result.slice(IMAGE_RESULT_PREFIX.length));
    expect(payload.type).toBe('image');
    expect(payload.images).toHaveLength(1);
    expect(payload.images[0].data).toBe('abc123');
    expect(payload.images[0].media_type).toBe('image/png');
    expect(payload.images[0].label).toBe('test.png');
  });

  it('supports multiple images', () => {
    const result = buildImageToolResult([
      { base64: 'page1', mediaType: 'image/jpeg', label: 'Page 1' },
      { base64: 'page2', mediaType: 'image/jpeg', label: 'Page 2' },
    ]);

    const payload = JSON.parse(result.slice(IMAGE_RESULT_PREFIX.length));
    expect(payload.images).toHaveLength(2);
  });
});
