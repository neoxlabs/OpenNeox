import { describe, it, expect } from 'vitest';
import { parseSeenImages } from '../seenImagesContent';

const MARK = '__NEOX_SEEN_IMAGES__' + JSON.stringify({ images: [{ path: '/h/.neox/run/seen/a.png', label: 'logo.png' }, { path: '/h/.neox/run/seen/b.jpg' }] });

describe('parseSeenImages', () => {
  it('整条', () => {
    expect(parseSeenImages(MARK)).toEqual([{ path: '/h/.neox/run/seen/a.png', label: 'logo.png' }, { path: '/h/.neox/run/seen/b.jpg' }]);
  });
  it('contextual 信封的 content 里 (browser_run 带截图)', () => {
    const env = JSON.stringify({ type: 'contextual', status: 'success', tool: 'browser_run', summary: '浏览器', content: MARK });
    expect(parseSeenImages(env)).toHaveLength(2);
  });
  it('前面挂着提示头', () => {
    expect(parseSeenImages(`⏱️ [tool took 8.5s]\n${MARK}`)).toHaveLength(2);
  });
  it('没有标记 / 截断了: 不认', () => {
    expect(parseSeenImages('普通输出')).toBeUndefined();
    expect(parseSeenImages(MARK.slice(0, 40))).toBeUndefined();
    expect(parseSeenImages(undefined)).toBeUndefined();
  });
});
