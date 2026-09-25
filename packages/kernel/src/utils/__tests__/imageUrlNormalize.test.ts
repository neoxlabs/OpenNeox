/** 验证 image_url 在发送边界上始终使用协议可接受的 URL 形状。 */
import { describe, it, expect } from 'vitest';
import { normalizeImageUrl, normalizeImagePartsInContent } from '../imageUrlNormalize.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAAAuklEQVR4nO3QMQ0AIADAMJzg';
const JPG = '/9j/4AAQSkZJRgABAQAAAQABAAD' + 'A'.repeat(20);

describe('normalizeImageUrl', () => {
  it('裸 base64 PNG → 补 data:image/png 前缀 (这就是 400 的那一刀)', () => {
    expect(normalizeImageUrl(PNG)).toBe(`data:image/png;base64,${PNG}`);
  });

  it('按魔数认 mime, 不是一律 png', () => {
    expect(normalizeImageUrl(JPG)).toBe(`data:image/jpeg;base64,${JPG}`);
  });

  it('已经是 dataURL / http(s) 的原样不动 (绝不套两层)', () => {
    const d = `data:image/png;base64,${PNG}`;
    expect(normalizeImageUrl(d)).toBe(d);
    expect(normalizeImageUrl('https://x.test/a.png')).toBe('https://x.test/a.png');
  });

  it('不像 base64 的原样返回 —— 我们不猜, 让上游给准确错误', () => {
    expect(normalizeImageUrl('/Users/me/a.png')).toBe('/Users/me/a.png');
    expect(normalizeImageUrl('')).toBe('');
  });
});

describe('normalizeImagePartsInContent', () => {
  it('只改 image_url 块, 文本块原样', () => {
    const parts = [
      { type: 'text', text: '这张图是什么颜色?' },
      { type: 'image_url', image_url: { url: PNG, detail: 'auto' } },
    ];
    const out = normalizeImagePartsInContent(parts) as any[];
    expect(out[0]).toBe(parts[0]);
    expect(out[1].image_url.url).toBe(`data:image/png;base64,${PNG}`);
    expect(out[1].image_url.detail).toBe('auto');
    /* 绝不 mutate 入参 —— 这份 content 是会话历史里的原件 */
    expect((parts[1] as any).image_url.url).toBe(PNG);
  });

  it('没有可改的就原样返回同一个引用 (发线每轮都走, 不做无谓复制)', () => {
    const parts = [{ type: 'text', text: 'hi' }];
    expect(normalizeImagePartsInContent(parts)).toBe(parts);
  });

  it('字符串 content 直接放行', () => {
    expect(normalizeImagePartsInContent('hi' as any)).toBe('hi');
  });
});
