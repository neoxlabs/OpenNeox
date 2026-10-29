/**
 * 上游错误消息过滤 —— "测试连接"是新用户配 BYOK 的第一个反馈, 不能甩原始响应体.
 * 直接测真实导出的 sanitizeUpstreamMessage —— 测副本等于没测。
 */
import { describe, it, expect } from 'vitest';
import { sanitizeUpstreamMessage, isImageLikeModelName } from '../providerHealthCheck.js';

describe('sanitizeUpstreamMessage', () => {
  it('放行上游给的人话消息', () => {
    expect(sanitizeUpstreamMessage('Invalid API key provided')).toBe('Invalid API key provided');
    expect(sanitizeUpstreamMessage('模型不存在')).toBe('模型不存在');
  });

  it('丢掉 Cloudflare / nginx 的 HTML 报错页', () => {
    expect(sanitizeUpstreamMessage('<!DOCTYPE html><html><body>502 Bad Gateway</body></html>')).toBe('');
    expect(sanitizeUpstreamMessage('<div class="cf-error">Error 1020</div>')).toBe('');
  });

  it('丢掉一坨 JSON', () => {
    expect(sanitizeUpstreamMessage('{"error":{"code":"x","details":[1,2,3]}}')).toBe('');
    expect(sanitizeUpstreamMessage('[{"a":1}]')).toBe('');
  });

  it('丢掉超长内容 (基本是页面或堆栈)', () => {
    expect(sanitizeUpstreamMessage('x'.repeat(301))).toBe('');
  });

  it('非字符串 / 空值一律不给', () => {
    expect(sanitizeUpstreamMessage(undefined)).toBe('');
    expect(sanitizeUpstreamMessage({ a: 1 })).toBe('');
    expect(sanitizeUpstreamMessage('   ')).toBe('');
  });
});

describe('isImageLikeModelName', () => {
  it('识别常见图片模型', () => {
    expect(isImageLikeModelName('openai/gpt-image-2')).toBe(true);
    expect(isImageLikeModelName('dall-e-3')).toBe(true);
    expect(isImageLikeModelName('gpt-image-1')).toBe(true);
    expect(isImageLikeModelName('x-ai/grok-imagine-image-quality')).toBe(true);
  });

  it('聊天模型不算图片', () => {
    expect(isImageLikeModelName('grok-4.5')).toBe(false);
    expect(isImageLikeModelName('deepseek-v4-flash')).toBe(false);
    expect(isImageLikeModelName('gpt-5.6-sol')).toBe(false);
  });
});
