import { describe, it, expect } from 'vitest';
import { workspaceKey, __resetWorkspaceKeyCache } from './pathUtils';

describe('workspaceKey', () => {
  it('Windows: 盘符大小写 / 反斜杠 / 结尾斜杠 归一到同一个 key', () => {
    const variants = [
      'C:\\Users\\me\\proj',
      'c:\\users\\me\\proj',
      'C:/Users/me/proj',
      'C:\\Users\\me\\proj\\',
      'c:/Users/me/proj/',
    ];
    const keys = new Set(variants.map(workspaceKey));
    expect(keys.size).toBe(1);
  });

  it('Windows: 不同项目仍是不同 key', () => {
    expect(workspaceKey('C:\\a\\proj')).not.toBe(workspaceKey('C:\\a\\proj2'));
  });

  it('POSIX: 保留大小写 (macOS/Linux 上 /A 与 /a 可以是两个目录)', () => {
    expect(workspaceKey('/Users/me/Proj')).not.toBe(workspaceKey('/users/me/proj'));
  });

  it('POSIX: 结尾斜杠与重复斜杠不影响判等', () => {
    expect(workspaceKey('/Users/me/proj/')).toBe(workspaceKey('/Users/me/proj'));
    expect(workspaceKey('/Users//me/proj')).toBe(workspaceKey('/Users/me/proj'));
  });

  it('空 / null / undefined 都落到空 key (cloud-only 会话那一桶)', () => {
    expect(workspaceKey('')).toBe('');
    expect(workspaceKey(null)).toBe('');
    expect(workspaceKey(undefined)).toBe('');
  });

  it('根路径不会被吃掉', () => {
    expect(workspaceKey('/')).toBe('/');
  });
});

describe('workspaceKey 缓存', () => {
  it('同一路径重复调用结果一致 (缓存不改变语义)', () => {
    __resetWorkspaceKeyCache();
    const a = workspaceKey('C:\\Users\\me\\proj');
    const b = workspaceKey('C:\\Users\\me\\proj');
    const c = workspaceKey('c:/users/me/proj/');
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it('不同路径不会互相污染', () => {
    __resetWorkspaceKeyCache();
    expect(workspaceKey('/Users/me/a')).toBe('/Users/me/a');
    expect(workspaceKey('/Users/me/b')).toBe('/Users/me/b');
    expect(workspaceKey('/Users/me/a')).toBe('/Users/me/a');
  });

  it('没有 document (挂载前 / 单测) 时不缓存 —— 兜底结论不许被焊死', () => {
    __resetWorkspaceKeyCache();
    /* node environment 无 document → 走兜底分支。此时反复调用仍要每次现算,
     * 结果得保持正确 (而不是把第一次的猜测粘住)。 */
    expect(workspaceKey('/Users/me/Proj')).toBe('/Users/me/Proj');
    expect(workspaceKey('C:\\X\\Y')).toBe('c:/x/y');
    expect(workspaceKey('/Users/me/Proj')).toBe('/Users/me/Proj');
  });
});
