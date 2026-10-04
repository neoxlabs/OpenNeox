/** 验证插话中的图片使用内核要求的 image_url 和 data URL 内容块格式。 */
import { describe, it, expect } from 'vitest';
import { buildInjectedUserMessage } from '../agentRuntimeHost.js';

const B64 = 'iVBORw0KGgoAAAANSUhEUg==';

describe('buildInjectedUserMessage', () => {
  it('图片必须是 image_url + data URL, 绝不能是 Anthropic 的 { type:"image", source }', () => {
    const msg = buildInjectedUserMessage('看这张图', [{ mediaType: 'image/png', data: B64 }]);
    const parts = msg.content as any[];
    expect(Array.isArray(parts)).toBe(true);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: 'text', text: '看这张图' });
    expect(parts[1].type).toBe('image_url');
    expect(parts[1].image_url.url).toBe(`data:image/png;base64,${B64}`);
    // 反向断言: 任何一块都不许出现内核 MessageContentPart 之外的 'image'
    expect(parts.some((p) => p?.type === 'image')).toBe(false);
    expect(parts.some((p) => 'source' in p)).toBe(false);
  });

  it('data 已经是 dataURL 时不重复包一层', () => {
    const url = `data:image/jpeg;base64,${B64}`;
    const parts = buildInjectedUserMessage('x', [{ mediaType: 'image/png', data: url }]).content as any[];
    expect(parts[1].image_url.url).toBe(url);
  });

  it('缺 mediaType 时兜 image/png, 空 data 直接跳过 (不发半个块出去)', () => {
    const parts = buildInjectedUserMessage('x', [
      { mediaType: '', data: B64 },
      { mediaType: 'image/png', data: '' },
    ]).content as any[];
    expect(parts).toHaveLength(2);
    expect(parts[1].image_url.url).toBe(`data:image/png;base64,${B64}`);
  });

  it('纯文本插话仍然是字符串 content (不因为改动变成数组)', () => {
    expect(buildInjectedUserMessage('只有文字').content).toBe('只有文字');
    expect(buildInjectedUserMessage('只有文字', []).content).toBe('只有文字');
  });
});
