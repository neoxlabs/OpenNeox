import { describe, expect, it } from 'vitest';
import { disambiguateTabTitles } from '../tabTitles';

const T = (title: string, path?: string) => ({ title, path });

describe('只有重名才加目录', () => {
  it('不重名的一个字都不改 —— 标签栏保持最短', () => {
    expect(disambiguateTabTitles([
      T('a.ts', 'src/a.ts'), T('b.ts', 'src/b.ts'),
    ])).toEqual(['a.ts', 'b.ts']);
  });

  it('重名时加上刚好能分开的那一层目录', () => {
    expect(disambiguateTabTitles([
      T('index.ts', 'src/foo/index.ts'),
      T('index.ts', 'src/bar/index.ts'),
    ])).toEqual(['index.ts — foo', 'index.ts — bar']);
  });

  it('一层还撞就再往上一层', () => {
    expect(disambiguateTabTitles([
      T('index.ts', 'x/a/index.ts'),
      T('index.ts', 'y/a/index.ts'),
    ])).toEqual(['index.ts — x/a', 'index.ts — y/a']);
  });

  it('三个一起撞也分得开', () => {
    const out = disambiguateTabTitles([
      T('types.ts', 'core/types.ts'),
      T('types.ts', 'ui/types.ts'),
      T('types.ts', 'cli/types.ts'),
    ]);
    expect(new Set(out).size).toBe(3);
  });

  it('没有路径的 (about:blank 这种) 不参与, 也不拖累别人', () => {
    expect(disambiguateTabTitles([
      T('新标签页'), T('新标签页'),
      T('index.ts', 'a/index.ts'), T('index.ts', 'b/index.ts'),
    ])).toEqual(['新标签页', '新标签页', 'index.ts — a', 'index.ts — b']);
  });

  it('根目录下的同名文件没有目录可加, 不该产出空后缀', () => {
    const out = disambiguateTabTitles([T('README.md', 'README.md'), T('README.md', 'docs/README.md')]);
    expect(out[0]).toBe('README.md');
    expect(out[1]).toBe('README.md — docs');
  });
});
