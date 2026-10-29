import { describe, it, expect } from 'vitest';
import { splitPathAnchor } from '../utils/pathUtils';
import { isPreviewablePath } from '../state/openSurfaceFromPath';

describe('splitPathAnchor', () => {
  it('#L 形态', () => {
    expect(splitPathAnchor('src/foo.ts#L10')).toEqual({ path: 'src/foo.ts', line: 10 });
    expect(splitPathAnchor('src/foo.ts#L10-L20')).toEqual({ path: 'src/foo.ts', line: 10 });
    expect(splitPathAnchor('src/foo.ts#L10-20')).toEqual({ path: 'src/foo.ts', line: 10 });
  });

  it('冒号形态 (grep / 编译器输出里最常见)', () => {
    expect(splitPathAnchor('src/foo.ts:42')).toEqual({ path: 'src/foo.ts', line: 42 });
    expect(splitPathAnchor('src/foo.ts:42:7')).toEqual({ path: 'src/foo.ts', line: 42 });
  });

  /* 这条是重点: 收得不够紧就会把好路径切坏, 比原来的 bug 更糟 */
  it('不许误伤盘符 / 端口 / 无扩展名的东西', () => {
    expect(splitPathAnchor('C:/Users/foo').path).toBe('C:/Users/foo');
    expect(splitPathAnchor('http://host:8080').path).toBe('http://host:8080');
    expect(splitPathAnchor('Makefile:12').path).toBe('Makefile:12');
    expect(splitPathAnchor('src/foo.ts').line).toBeUndefined();
  });

  it('空输入不炸', () => {
    expect(splitPathAnchor('')).toEqual({ path: '' });
    expect(splitPathAnchor(undefined as any)).toEqual({ path: '' });
  });
});

describe('带锚点的路径仍然可点', () => {
  it('#L / 冒号两种形态都判可点', () => {
    expect(isPreviewablePath('src/foo.ts#L10')).toBe(true);
    expect(isPreviewablePath('src/foo.ts:42')).toBe(true);
    /* 回归基线: 不带锚点的行为一点不变 */
    expect(isPreviewablePath('src/foo.ts')).toBe(true);
    expect(isPreviewablePath('https://example.com/a.ts')).toBe(false);
    expect(isPreviewablePath('backend/.../Foo.java')).toBe(false);
  });
});
