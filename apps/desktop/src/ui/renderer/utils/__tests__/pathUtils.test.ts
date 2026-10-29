
import { describe, it, expect, beforeEach } from 'vitest';
import {
  workspaceKey, filePathKey, sameWorkspace, normalizePathSlashes,
  isAbsPath, normalizePath, relativeToWorkspace, __resetWorkspaceKeyCache,
} from '../pathUtils';

beforeEach(() => { __resetWorkspaceKeyCache(); });

describe('normalizePathSlashes · UNC 必须保住前导双斜杠', () => {
  it('Windows UNC 写法不能被压成单斜杠 (真实事故)', () => {
    expect(normalizePathSlashes('\\\\nas\\team\\a.md')).toBe('//nas/team/a.md');
  });

  it('UNC 内部的重复斜杠要压掉, 但开头那两根保留', () => {
    expect(normalizePathSlashes('//nas//team///a.md')).toBe('//nas/team/a.md');
  });

  it('POSIX 重复斜杠压成一根', () => {
    expect(normalizePathSlashes('/Users//me///a.md')).toBe('/Users/me/a.md');
  });

  it('盘符后多打的斜杠收干净', () => {
    expect(normalizePathSlashes('C:\\\\foo\\bar')).toBe('C:/foo/bar');
    expect(normalizePathSlashes('C://foo')).toBe('C:/foo');
  });

  it('空值不抛', () => {
    expect(normalizePathSlashes('')).toBe('');
  });
});

describe('filePathKey · 判等口径', () => {
  it('. 和 .. 段必须被吃掉 —— 否则同一个文件会开出两个 tab', () => {
    expect(filePathKey('/w/docs/../docs/a.md')).toBe(filePathKey('/w/docs/a.md'));
    expect(filePathKey('/w/./docs/a.md')).toBe(filePathKey('/w/docs/a.md'));
  });

  it('重复斜杠不影响判等', () => {
    expect(filePathKey('/w//docs/a.md')).toBe(filePathKey('/w/docs/a.md'));
  });

  it('POSIX 下大小写敏感 —— /A 与 /a 是两个文件', () => {
    expect(filePathKey('/w/A.md')).not.toBe(filePathKey('/w/a.md'));
  });

  it('空值返回空串, 不抛', () => {
    expect(filePathKey(null)).toBe('');
    expect(filePathKey(undefined)).toBe('');
    expect(filePathKey('')).toBe('');
  });

  it('同一个路径重复调用结果稳定 (缓存不能改变结论)', () => {
    const a = filePathKey('/w/docs/a.md');
    const b = filePathKey('/w/docs/a.md');
    expect(a).toBe(b);
  });
});

describe('workspaceKey / sameWorkspace', () => {
  it('尾斜杠不影响判等', () => {
    expect(sameWorkspace('/Users/me/proj', '/Users/me/proj/')).toBe(true);
  });

  it('重复斜杠不影响判等', () => {
    expect(sameWorkspace('/Users/me//proj', '/Users/me/proj')).toBe(true);
  });

  it('不同工程判不等', () => {
    expect(sameWorkspace('/Users/me/a', '/Users/me/b')).toBe(false);
  });

  it('空值之间相等, 空与非空不等', () => {
    expect(sameWorkspace(null, undefined)).toBe(true);
    expect(sameWorkspace(null, '/Users/me/a')).toBe(false);
  });

  it('Windows 盘符大小写不影响判等', () => {
    expect(sameWorkspace('C:\\proj', 'c:\\proj')).toBe(true);
  });
});

describe('isAbsPath', () => {
  it.each([
    ['POSIX 绝对', '/Users/me', true],
    ['Windows 盘符', 'C:\\proj', true],
    ['UNC', '\\\\nas\\share', true],
    ['相对', 'src/index.ts', false],
    ['当前目录', './a.md', false],
    ['上级目录', '../a.md', false],
    ['空串', '', false],
  ])('%s: %s → %s', (_n, p, want) => {
    expect(isAbsPath(p)).toBe(want);
  });
});

describe('normalizePath · . / .. 段', () => {
  it('吃掉 .. 段', () => {
    expect(normalizePath('/w/a/../b')).toBe('/w/b');
  });

  it('吃掉 . 段', () => {
    expect(normalizePath('/w/./a')).toBe('/w/a');
  });

  it('不能吃过头到根之上', () => {
    /* 具体形态由实现决定, 但**绝不能**产出带 .. 的结果 —— 那会被当成真实目录名 */
    expect(normalizePath('/../../a')).not.toContain('..');
  });
});

describe('relativeToWorkspace', () => {
  it('工作区内的文件返回相对路径', () => {
    expect(relativeToWorkspace('/w/src/a.ts', '/w')).toBe('src/a.ts');
  });

  it('工作区外的文件不能被裁成看起来像内部的路径', () => {
    const out = relativeToWorkspace('/other/a.ts', '/w');
    expect(out === '/other/a.ts' || out.startsWith('..')).toBe(true);
  });

  it('没有工作区时原样返回', () => {
    expect(relativeToWorkspace('/w/a.ts', undefined)).toBe('/w/a.ts');
  });
});
