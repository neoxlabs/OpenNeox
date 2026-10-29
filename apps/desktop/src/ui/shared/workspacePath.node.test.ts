/**
 * Node 侧判等绑定 + 落盘重复的折叠。
 *
 *   dedupeByWorkspacePath 是唯一负责"治好用户机器上已经存在的重复项目"的那段 ——
 *   写入端修好之后, 已经写进 SQLite 的两条同名项目不会自己消失, 全靠它在读取时折叠。
 *   没有测试的话, 这段只在 Windows 上才跑得到真实数据, 本地永远验不了。
 *
 *   vitest 跑在 node environment, process.platform 就是真实平台。macOS 上无法直接
 *   构造"盘符大小写不同"的场景 (POSIX 判等本来就大小写敏感), 所以大小写那条用
 *   canonicalWorkspacePath 直接以 isWindows=true 验, 折叠逻辑本身用平台无关的写法差异
 *   (尾斜杠 / 重复斜杠 / 相对路径) 来验 —— 两者合起来覆盖真实路径。
 */
import { describe, it, expect } from 'vitest';
import {
  workspaceKey,
  sameWorkspace,
  dedupeByWorkspacePath,
  dedupeWorkspacePaths,
  rekeyByWorkspacePath,
} from './workspacePath.node.js';
import { canonicalWorkspacePath } from './workspacePath.js';

describe('workspaceKey (node)', () => {
  it('相对路径先落地成绝对路径再比', () => {
    expect(sameWorkspace(process.cwd(), '.')).toBe(true);
  });

  it('尾斜杠 / 重复斜杠不影响判等', () => {
    expect(sameWorkspace('/tmp/proj', '/tmp/proj/')).toBe(true);
    expect(sameWorkspace('/tmp//proj', '/tmp/proj')).toBe(true);
  });

  it('不同项目不会被判成同一个', () => {
    expect(sameWorkspace('/tmp/proj', '/tmp/proj2')).toBe(false);
  });

  it('空值安全', () => {
    expect(workspaceKey(null)).toBe('');
    expect(sameWorkspace(null, undefined)).toBe(true);
    expect(sameWorkspace(null, '/tmp/proj')).toBe(false);
  });
});

describe('canonicalWorkspacePath — Windows 语义', () => {
  it('盘符大小写 / 反斜杠 / 尾斜杠 归一到同一个 key', () => {
    const variants = [
      'C:\\Users\\me\\proj',
      'c:\\users\\me\\proj',
      'C:/Users/me/proj',
      'C:\\Users\\me\\proj\\',
    ];
    expect(new Set(variants.map((v) => canonicalWorkspacePath(v, true))).size).toBe(1);
  });

  it('POSIX 下大小写敏感, 不能一律小写', () => {
    expect(canonicalWorkspacePath('/Users/me/Proj', false))
      .not.toBe(canonicalWorkspacePath('/users/me/proj', false));
  });

  it('根路径不被吃掉', () => {
    expect(canonicalWorkspacePath('/', false)).toBe('/');
    expect(canonicalWorkspacePath('C:\\', true)).toBe('c:/');
  });

  it('UNC 路径保住开头两个斜杠', () => {
    expect(canonicalWorkspacePath('\\\\server\\share\\proj', true)).toBe('//server/share/proj');
  });
});

describe('dedupeByWorkspacePath — 折叠已落盘的重复', () => {
  const pickNewest = <T extends { lastOpened?: number }>(a: T, b: T) =>
    ((b.lastOpened ?? 0) > (a.lastOpened ?? 0) ? b : a);

  it('同一项目的两种写法折成一条, 留 lastOpened 最新的那条', () => {
    const out = dedupeByWorkspacePath(
      [
        { path: '/tmp/proj/', lastOpened: 100, name: '旧' },
        { path: '/tmp/proj', lastOpened: 200, name: '新' },
        { path: '/tmp/other', lastOpened: 50, name: '别的' },
      ],
      (w) => w.path,
      pickNewest,
    );
    expect(out).toHaveLength(2);
    expect(out.find((w) => w.name === '新')).toBeTruthy();
    expect(out.find((w) => w.name === '旧')).toBeFalsy();
    expect(out.find((w) => w.name === '别的')).toBeTruthy();
  });

  it('没有重复时原样返回, 顺序不变', () => {
    const list = [
      { path: '/tmp/a', lastOpened: 1 },
      { path: '/tmp/b', lastOpened: 2 },
    ];
    expect(dedupeByWorkspacePath(list, (w) => w.path, pickNewest).map((w) => w.path))
      .toEqual(['/tmp/a', '/tmp/b']);
  });

  it('丢掉没有 path 的脏条目, 不抛', () => {
    const out = dedupeByWorkspacePath(
      [{ path: '', lastOpened: 1 }, { path: '/tmp/a', lastOpened: 2 }],
      (w) => w.path,
      pickNewest,
    );
    expect(out.map((w) => w.path)).toEqual(['/tmp/a']);
  });

  it('空 / null / undefined 输入都返回空数组', () => {
    expect(dedupeByWorkspacePath<{ path: string; lastOpened?: number }>([], (w) => w.path, pickNewest)).toEqual([]);
    expect(dedupeByWorkspacePath<{ path: string; lastOpened?: number }>(null, (w) => w.path, pickNewest)).toEqual([]);
    expect(dedupeByWorkspacePath<{ path: string; lastOpened?: number }>(undefined, (w) => w.path, pickNewest)).toEqual([]);
  });
});

describe('dedupeWorkspacePaths — 根目录列表去重', () => {
  it('同一个根的两种写法只留一个, 保住第一次出现的原始写法', () => {
    expect(dedupeWorkspacePaths(['/tmp/a', '/tmp/a/', '/tmp//a', '/tmp/b']))
      .toEqual(['/tmp/a', '/tmp/b']);
  });

  it('primary 放在首位时不会被后面的重复挤掉', () => {
    expect(dedupeWorkspacePaths(['/tmp/primary', '/tmp/x', '/tmp/primary/'])[0])
      .toBe('/tmp/primary');
  });

  it('空值被丢掉, 不抛', () => {
    expect(dedupeWorkspacePaths([null, '', '/tmp/a', undefined])).toEqual(['/tmp/a']);
  });
});

describe('rekeyByWorkspacePath — 治路径键表的旧数据', () => {
  it('同一项目的多个键合并成一个规范键', () => {
    const out = rekeyByWorkspacePath(
      { '/tmp/proj': { name: '' }, '/tmp/proj/': { name: '我的项目' } },
      (a, b) => (b?.name?.trim() ? b : a),
    );
    expect(Object.keys(out)).toHaveLength(1);
    expect(Object.values(out)[0]).toEqual({ name: '我的项目' });
  });

  it('merge 的方向正确: 先来的有值、后来的为空时保住先来的', () => {
    const out = rekeyByWorkspacePath(
      { '/tmp/proj': { name: '我的项目' }, '/tmp/proj/': { name: '' } },
      (a, b) => (b?.name?.trim() ? b : a),
    );
    expect(Object.values(out)[0]).toEqual({ name: '我的项目' });
  });

  it('roots 表撞键时保留根更多的那条', () => {
    const out = rekeyByWorkspacePath(
      { '/tmp/w': ['/tmp/w'], '/tmp/w/': ['/tmp/w', '/tmp/w2', '/tmp/w3'] },
      (a, b) => ((b?.length ?? 0) > (a?.length ?? 0) ? b : a),
    );
    expect(Object.values(out)[0]).toHaveLength(3);
  });

  it('没有撞键时内容原样保留', () => {
    const out = rekeyByWorkspacePath({ '/tmp/a': 1, '/tmp/b': 2 }, (a) => a);
    expect(Object.keys(out)).toHaveLength(2);
    expect(out[workspaceKey('/tmp/a')]).toBe(1);
  });

  it('键换成了 workspaceKey —— 用原始写法取不到, 用 key 取得到', () => {
    const out = rekeyByWorkspacePath({ '/tmp/proj/': { name: 'x' } }, (a) => a);
    expect(out['/tmp/proj/']).toBeUndefined();
    expect(out[workspaceKey('/tmp/proj/')]).toEqual({ name: 'x' });
  });

  it('null / undefined / 非对象 输入返回空对象', () => {
    expect(rekeyByWorkspacePath(null, (a) => a)).toEqual({});
    expect(rekeyByWorkspacePath(undefined, (a) => a)).toEqual({});
  });
});
