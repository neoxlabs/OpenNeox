import { describe, it, expect } from 'vitest';
import { readListing, readConfigFields, remoteIconUrl } from '../pluginListing.js';

const manifest = {
  listing: {
    icon: 'https://cdn.example.com/icon.png',
    screenshots: [
      { src: 'https://cdn.example.com/1-en.webp', srcZh: 'https://cdn.example.com/1-zh.webp' },
      { src: 'http://insecure.example.com/2.webp' },
      { src: 'javascript:alert(1)' },
      { src: 'https://cdn.example.com/3-en.webp' },
    ],
    examples: [{ en: 'Weather in Tokyo?', zh: '东京天气？' }, { en: 'Only English' }, 'plain string', { zh: '' }],
    features: [{ title: 'Forecast', titleZh: '预报', detail: 'd', detailZh: '细节' }, { detail: 'no title' }],
  },
  userConfig: {
    city: { type: 'string', description: 'Default city', descriptionZh: '默认城市' },
    units: { type: 'select', options: ['metric', 'imperial'], default: 'metric', description: 'Units' },
    token: { type: 'string', description: 'Token', sensitive: true },
    weird: { type: 'object', description: 'x' },
  },
};

describe('readListing', () => {
  it('只收 https 截图, 中文界面用 srcZh', () => {
    const zh = readListing(manifest, true);
    expect(zh.screenshots.map((s) => s.src)).toEqual(['https://cdn.example.com/1-zh.webp', 'https://cdn.example.com/3-en.webp']);
    const en = readListing(manifest, false);
    expect(en.screenshots[0].src).toBe('https://cdn.example.com/1-en.webp');
  });

  it('示例按语言取, 缺中文退回英文, 空的丢掉', () => {
    expect(readListing(manifest, true).examples).toEqual(['东京天气？', 'Only English', 'plain string']);
    expect(readListing(manifest, false).examples).toEqual(['Weather in Tokyo?', 'Only English', 'plain string']);
  });

  it('没标题的功能不渲染', () => {
    expect(readListing(manifest, true).features).toEqual([{ title: '预报', detail: '细节' }]);
  });

  it('没有 listing 时全空, 不抛', () => {
    expect(readListing(undefined, true)).toEqual({ icon: undefined, screenshots: [], examples: [], features: [] });
  });
});

describe('remoteIconUrl', () => {
  it('顶层 icon 优先, 其次 listing.icon, 非 https 不认', () => {
    expect(remoteIconUrl({ icon: 'https://a.example/x.png', manifest })).toBe('https://a.example/x.png');
    expect(remoteIconUrl({ icon: '🌤️', manifest })).toBe('https://cdn.example.com/icon.png');
    expect(remoteIconUrl({ icon: 'file:///etc/passwd' })).toBeUndefined();
  });
});

describe('readConfigFields', () => {
  it('中文界面优先 descriptionZh, 未知类型当字符串', () => {
    const f = readConfigFields(manifest, true);
    expect(f.find((x) => x.key === 'city')?.description).toBe('默认城市');
    expect(f.find((x) => x.key === 'units')).toMatchObject({ type: 'select', options: ['metric', 'imperial'], default: 'metric' });
    expect(f.find((x) => x.key === 'token')?.sensitive).toBe(true);
    expect(f.find((x) => x.key === 'weird')?.type).toBe('string');
    expect(readConfigFields(manifest, false).find((x) => x.key === 'city')?.description).toBe('Default city');
  });
});
