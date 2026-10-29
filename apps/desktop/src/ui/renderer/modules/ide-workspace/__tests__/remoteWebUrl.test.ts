import { describe, it, expect } from 'vitest';
import { remoteWebUrl, remoteHostLabel } from '../GitCard';

/* remoteWebUrl 决定"在浏览器里打开"那颗按钮把人送到哪。
 * 认不出时必须返回 null 而不是猜 —— 猜错的后果是打开一个不存在的页面,
 * 比不给这个入口更糟 (自建 gitolite / 内网 host 长得像但路由完全不同)。 */
describe('remoteWebUrl', () => {
  it('scp 式 SSH → https', () => {
    expect(remoteWebUrl('git@github.com:example/private-repo.git'))
      .toBe('https://github.com/example/private-repo');
  });

  it('ssh:// 式 (含端口) → https, 端口丢掉', () => {
    expect(remoteWebUrl('ssh://git@gitlab.example.com:2222/team/app.git'))
      .toBe('https://gitlab.example.com/team/app');
  });

  it('https 原样 (去掉 .git)', () => {
    expect(remoteWebUrl('https://github.com/a/b.git')).toBe('https://github.com/a/b');
    expect(remoteWebUrl('https://gitlab.com/g/s/p')).toBe('https://gitlab.com/g/s/p');
  });

  it('子组的 GitLab 路径完整保留', () => {
    expect(remoteWebUrl('git@gitlab.com:top/mid/leaf.git'))
      .toBe('https://gitlab.com/top/mid/leaf');
  });

  it('认不出的一律 null, 不猜', () => {
    expect(remoteWebUrl('')).toBeNull();
    expect(remoteWebUrl('   ')).toBeNull();
    /* 本地路径 remote —— 常见于 submodule / 测试仓库, 绝不能变成一个网址 */
    expect(remoteWebUrl('/Users/me/repos/thing.git')).toBeNull();
    expect(remoteWebUrl('../sibling-repo')).toBeNull();
    expect(remoteWebUrl('file:///srv/git/x.git')).toBeNull();
  });

  it('主机标签: 认得出的报名字, 认不出的给空串 (调用方退回"浏览器")', () => {
    expect(remoteHostLabel('git@github.com:a/b.git')).toBe('GitHub');
    expect(remoteHostLabel('https://gitlab.example.com/a/b')).toBe('GitLab');
    expect(remoteHostLabel('https://gitee.com/a/b')).toBe('Gitee');
    expect(remoteHostLabel('https://git.mycorp.internal/a/b')).toBe('');
  });
});
