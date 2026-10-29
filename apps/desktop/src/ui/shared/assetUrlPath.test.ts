import { describe, it, expect } from 'vitest';
import { absoluteToAssetUrl, assetPathnameToAbsolute, isUnderAnyRoot } from './assetUrlPath';

/** POSIX 口径: 原样比较 (workspaceKey 在非 win32 下就是这么做的)。 */
const posixKey = (p: string) => p;
/** Windows 口径: 反斜杠归一 + 小写 (复刻 workspaceKey 的 canonicalWorkspacePath)。 */
const winKey = (p: string) => p.replace(/\\/g, '/').toLowerCase();

describe('assetPathnameToAbsolute', () => {
  it('Windows 盘符路径去掉前导 /', () => {
    expect(assetPathnameToAbsolute('/C:\\Users\\me\\pic.png')).toBe('C:\\Users\\me\\pic.png');
    expect(assetPathnameToAbsolute('/C:/Users/me/pic.png')).toBe('C:/Users/me/pic.png');
    expect(assetPathnameToAbsolute('/d:\\proj\\a.jpg')).toBe('d:\\proj\\a.jpg');
  });

  it('Windows UNC 路径去掉前导 /', () => {
    expect(assetPathnameToAbsolute('/\\\\server\\share\\a.png')).toBe('\\\\server\\share\\a.png');
  });

  it('POSIX 绝对路径保留前导 / —— 去掉会被当相对路径拼在 cwd 下', () => {
    expect(assetPathnameToAbsolute('/Users/me/pic.png')).toBe('/Users/me/pic.png');
    expect(assetPathnameToAbsolute('/home/me/a.png')).toBe('/home/me/a.png');
    expect(assetPathnameToAbsolute('/tmp/x.png')).toBe('/tmp/x.png');
  });

  it('看着像盘符但不是绝对路径的不动 (C: 后面没有分隔符)', () => {
    expect(assetPathnameToAbsolute('/C:relative')).toBe('/C:relative');
  });
});

describe('isUnderAnyRoot', () => {
  it('落在白名单根之下的目标放行 (含根本身)', () => {
    const roots = ['/Users/me/proj', '/tmp', '/private/tmp'];
    expect(isUnderAnyRoot('/tmp/neox-shots/v5-chat2.png', roots, posixKey)).toBe(true);
    expect(isUnderAnyRoot('/tmp', roots, posixKey)).toBe(true);
    expect(isUnderAnyRoot('/Users/me/proj/a.png', roots, posixKey)).toBe(true);
  });

  it('前缀相同但不同目录的不能放行 (/tmpfoo 不是 /tmp)', () => {
    expect(isUnderAnyRoot('/tmpfoo/x.png', ['/tmp'], posixKey)).toBe(false);
    expect(isUnderAnyRoot('/home/me/x.png', ['/tmp', '/Users/me/proj'], posixKey)).toBe(false);
  });

  it('Windows 口径 (keyOf 小写化) 大小写不敏感', () => {
    expect(isUnderAnyRoot('C:\\Users\\Me\\Pic.PNG', ['c:/users/me'], winKey)).toBe(true);
    expect(isUnderAnyRoot('C:\\Users\\Other\\x.png', ['c:/users/me'], winKey)).toBe(false);
  });

  it('空 key 不放行', () => {
    expect(isUnderAnyRoot('', ['/tmp'], posixKey)).toBe(false);
    expect(isUnderAnyRoot('/tmp/x.png', [''], posixKey)).toBe(false);
  });
});

describe('absoluteToAssetUrl', () => {
  it('Windows 盘符路径补前导 / , 盘符不被并进 host', () => {
    const url = absoluteToAssetUrl('C:\\Users\\me\\Neox\\Work\\2026-10-20 视频【30】\\shot1-1.png');
    const u = new URL(url);
    expect(u.host).toBe('local');
    expect(assetPathnameToAbsolute(decodeURIComponent(u.pathname))).toBe('C:/Users/me/Neox/Work/2026-10-20 视频【30】/shot1-1.png');
  });
  it('POSIX 路径原样; # ? 不被截断', () => {
    const u = new URL(absoluteToAssetUrl('/Users/me/a #1?.png'));
    expect(u.host).toBe('local');
    expect(decodeURIComponent(u.pathname)).toBe('/Users/me/a #1?.png');
  });
});
