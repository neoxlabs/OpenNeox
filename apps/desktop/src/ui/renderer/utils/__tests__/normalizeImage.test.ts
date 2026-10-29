import { describe, expect, it } from 'vitest';
import {
  UPSTREAM_SAFE_IMAGE_TYPES,
  mediaTypeOf,
  shortFormatName,
  unsupportedImageMessage,
} from '../normalizeImage';

describe('白名单 = 上游真正接受的那四种', () => {
  it('就是 png / jpeg / webp / gif, 不多不少', () => {
    expect([...UPSTREAM_SAFE_IMAGE_TYPES].sort()).toEqual([
      'image/gif', 'image/jpeg', 'image/png', 'image/webp',
    ]);
  });

  it('BMP 不在白名单 —— 这正是线上 400 的那一个', () => {
    expect(UPSTREAM_SAFE_IMAGE_TYPES.has('image/bmp')).toBe(false);
  });

  it('其它常见但上游不收的也不在', () => {
    for (const t of ['image/tiff', 'image/heic', 'image/heif', 'image/svg+xml', 'image/x-icon', 'image/avif']) {
      expect(UPSTREAM_SAFE_IMAGE_TYPES.has(t), `${t} 不该在白名单里`).toBe(false);
    }
  });
});

describe('mediaTypeOf', () => {
  it.each([
    ['data:image/bmp;base64,AAA', 'image/bmp'],
    ['data:image/png;base64,AAA', 'image/png'],
    ['data:image/svg+xml;charset=utf-8,%3Csvg', 'image/svg+xml'],
    ['data:IMAGE/PNG;base64,AAA', 'image/png'],
  ])('%s → %s', (input, want) => {
    expect(mediaTypeOf(input)).toBe(want);
  });

  it('不是 dataURL 时返回空串, 不猜', () => {
    expect(mediaTypeOf('https://example.com/a.png')).toBe('');
    expect(mediaTypeOf('')).toBe('');
  });
});

describe('给用户的那句话要能照做', () => {
  it('带上格式名 —— 用户得知道是哪张图的问题', () => {
    expect(unsupportedImageMessage('image/heic', true)).toContain('HEIC');
    expect(unsupportedImageMessage('image/tiff', false)).toContain('TIFF');
  });

  it('给出下一步, 且**不是**"刷新/重启" —— 那对图片格式毫无用处', () => {
    const zh = unsupportedImageMessage('image/heic', true);
    expect(zh).toMatch(/PNG|JPEG/);
    expect(zh).not.toMatch(/重启|刷新/);
    const en = unsupportedImageMessage('image/heic', false);
    expect(en).toMatch(/PNG|JPEG/);
    expect(en.toLowerCase()).not.toMatch(/restart|refresh/);
  });

  it('shortFormatName 去掉噪声前缀/后缀', () => {
    expect(shortFormatName('image/svg+xml')).toBe('SVG');
    expect(shortFormatName('image/x-icon')).toBe('ICON');
    expect(shortFormatName('image/jpeg')).toBe('JPEG');
  });
});
