/**
 * 插件平台声明的判定契约：指定平台必须匹配当前宿主系统，未声明平台表示全平台，
 * 无法识别宿主系统时不阻止插件加载。
 *
 *   规则覆盖三种情况:
 *     1. 清单里那句 `"platform": ["darwin"]` 在 Windows 上**必须**判成不支持
 *        不匹配的平台不会加载。
 *     2. 没声明 = 全平台。绝大多数插件没写这个字段, 判错方向会让它们装不上。
 *     3. 无法识别宿主系统时不阻止插件加载。
 */
import { describe, expect, it } from 'vitest';
import {
  declaredPlatforms,
  isPlatformSupported,
  platformLabel,
  platformsLabel,
} from '../plugin-platform.js';

describe('declaredPlatforms', () => {
  it('认清单本身的 platform (安装记录 / 本地清单的形状)', () => {
    expect(declaredPlatforms({ name: 'computer-use', platform: ['darwin'] })).toEqual(['darwin']);
  });

  it('也认市场记录里嵌在 manifest 下的形状', () => {
    /* MarketplacePlugin 把整份清单塞在 manifest 字段里, platform 在那一层 */
    expect(declaredPlatforms({ name: 'computer-use', manifest: { platform: ['darwin'] } }))
      .toEqual(['darwin']);
  });

  it('没声明 → null (全平台)', () => {
    expect(declaredPlatforms({ name: 'x' })).toBeNull();
    expect(declaredPlatforms({ name: 'x', manifest: {} })).toBeNull();
    expect(declaredPlatforms(null)).toBeNull();
    expect(declaredPlatforms('nope')).toBeNull();
  });

  it('空数组 / 全是垃圾值 → null, 不当成「哪个平台都不支持」', () => {
    expect(declaredPlatforms({ platform: [] })).toBeNull();
    expect(declaredPlatforms({ platform: [1, null, {}] })).toBeNull();
    expect(declaredPlatforms({ platform: ['darwin', '', 7] })).toEqual(['darwin']);
  });
});

describe('isPlatformSupported', () => {
  it('声明了 darwin 的插件在 Windows 上不支持 —— 这就是那条 bug', () => {
    expect(isPlatformSupported(['darwin'], 'win32')).toBe(false);
    expect(isPlatformSupported(['darwin'], 'darwin')).toBe(true);
  });

  it('多平台声明按包含判', () => {
    expect(isPlatformSupported(['darwin', 'win32'], 'win32')).toBe(true);
    expect(isPlatformSupported(['darwin', 'win32'], 'linux')).toBe(false);
  });

  it('未声明 = 全平台', () => {
    expect(isPlatformSupported(null, 'win32')).toBe(true);
    expect(isPlatformSupported([], 'linux')).toBe(true);
  });

  it('认不出当前系统时不拦 (renderer 上 navigator 认不出来) ', () => {
    expect(isPlatformSupported(['darwin'], '')).toBe(true);
  });
});

describe('展示文案', () => {
  it('单平台 / 多平台', () => {
    expect(platformsLabel(['darwin'], true)).toBe('macOS');
    expect(platformsLabel(['darwin', 'win32'], true)).toBe('macOS · Windows');
    expect(platformsLabel(['win32'], false)).toBe('Windows');
  });

  it('没声明时是空串 —— 卡片据此不显示这一栏', () => {
    expect(platformsLabel(null, true)).toBe('');
    expect(platformsLabel([], false)).toBe('');
  });

  it('不认识的平台名原样显示, 不留空', () => {
    expect(platformLabel('aix', true)).toBe('aix');
  });
});
