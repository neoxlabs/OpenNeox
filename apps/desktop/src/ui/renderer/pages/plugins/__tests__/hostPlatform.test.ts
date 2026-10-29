/**
 * 市场判「这插件支持我吗」靠的是 renderer 自己认出来的平台。
 * 这里钉的是: 三种平台的真实 navigator 值要认对, 认不出来要给空串 (空串 = 不拦),
 * 别把 Windows 判成 mac —— 判反了会让 mac-only 的插件在 Windows 上显示成可装。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { hostPlatform } from '../hostPlatform.js';

function on(platform: string, userAgent: string): void {
  vi.stubGlobal('navigator', { platform, userAgent });
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('hostPlatform', () => {
  it('mac 的真实取值', () => {
    on('MacIntel', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
    expect(hostPlatform()).toBe('darwin');
  });

  it('Windows 的 navigator.platform 是 Win32', () => {
    on('Win32', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    expect(hostPlatform()).toBe('win32');
  });

  it('Linux', () => {
    on('Linux x86_64', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36');
    expect(hostPlatform()).toBe('linux');
  });

  it('认不出来给空串 —— 空串在 isPlatformSupported 里算「支持」, 不拦', () => {
    on('', 'Mozilla/5.0 (Unknown)');
    expect(hostPlatform()).toBe('');
  });
});
