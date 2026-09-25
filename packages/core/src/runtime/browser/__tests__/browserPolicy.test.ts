/**
 * 站点名单 —— 这一层的每一条都是"看起来能用但有洞"的写法的反面, 所以逐条钉死。
 */
import { describe, it, expect } from 'vitest';
import { checkBrowserUsePolicy, parseBrowserUsePolicy, type BrowserUsePolicy } from '../browserPolicy.js';

const open = (deny: string[] = []): BrowserUsePolicy => ({ policy: 'open', allow: [], deny });
const only = (allow: string[]): BrowserUsePolicy => ({ policy: 'allowlist', allow, deny: [] });

describe('checkBrowserUsePolicy', () => {
  it('默认 open: 什么都能开', () => {
    expect(checkBrowserUsePolicy('https://anything.example/x', open())).toBeNull();
  });

  it('deny 命中就拒, 并说清这是用户设置不是 bug', () => {
    const d = checkBrowserUsePolicy('https://mail.google.com/inbox', open(['mail.google.com']));
    expect(d?.code).toBe('site_denied_by_policy');
    expect(d?.message).toContain('browserUse.deny');
  });

  it('**比的是 host, 不是整条 URL 做包含匹配** —— 这是这类名单最经典的绕过', () => {
    /* 拿 url.includes("github.com") 实现的话, 下面这条会被放行 */
    expect(checkBrowserUsePolicy('https://evil.example/?next=github.com', only(['github.com'])))
      .not.toBeNull();
    /* 反过来: 路径里带着别的域名也不该让本来允许的站被拒 */
    expect(checkBrowserUsePolicy('https://github.com/?ref=mail.google.com', open(['mail.google.com'])))
      .toBeNull();
  });

  it('子域必须显式写 *. —— 默认不吃子域', () => {
    expect(checkBrowserUsePolicy('https://gist.github.com/x', only(['github.com']))).not.toBeNull();
    expect(checkBrowserUsePolicy('https://gist.github.com/x', only(['*.github.com']))).toBeNull();
    /* *.github.com 也匹配 github.com 自己 —— 用户写它的意思是"这个站" */
    expect(checkBrowserUsePolicy('https://github.com/x', only(['*.github.com']))).toBeNull();
  });

  it('后缀不能靠字符串 endsWith —— notgithub.com 不是 github.com 的子域', () => {
    expect(checkBrowserUsePolicy('https://notgithub.com/x', only(['*.github.com']))).not.toBeNull();
  });

  it('端口只在名单写了端口时才比', () => {
    expect(checkBrowserUsePolicy('http://localhost:3000/', only(['localhost:3000']))).toBeNull();
    expect(checkBrowserUsePolicy('http://localhost:4000/', only(['localhost:3000']))).not.toBeNull();
    /* 没写端口的条目不该因为默认端口被拒 */
    expect(checkBrowserUsePolicy('https://github.com/', only(['github.com']))).toBeNull();
    expect(checkBrowserUsePolicy('http://github.com/', only(['github.com']))).toBeNull();
  });

  it('大小写不敏感, 名单里粘一整条 URL 也认', () => {
    expect(checkBrowserUsePolicy('https://GitHub.com/x', only(['https://github.com/some/path']))).toBeNull();
  });

  it('deny 优先于 allow —— 同时命中按拒算', () => {
    const p: BrowserUsePolicy = { policy: 'allowlist', allow: ['*.google.com'], deny: ['mail.google.com'] };
    expect(checkBrowserUsePolicy('https://mail.google.com/', p)?.code).toBe('site_denied_by_policy');
    expect(checkBrowserUsePolicy('https://docs.google.com/', p)).toBeNull();
  });

  it('allowlist 模式下不在名单里就拒, 并告诉模型去让用户加', () => {
    const d = checkBrowserUsePolicy('https://example.com/', only(['github.com']));
    expect(d?.code).toBe('site_not_in_allowlist');
    expect(d?.message).toContain('browserUse.allow');
  });

  it('**非 http(s) 一律不拦** —— about:blank 就是新标签页, 拦了浏览器起不来', () => {
    for (const u of ['about:blank', 'data:text/html,<p>x', 'devtools://devtools/x', 'chrome://version']) {
      expect(checkBrowserUsePolicy(u, only(['github.com']))).toBeNull();
    }
  });

  it('空 URL / 解不开的 URL 不在这层拦 —— 导航本身会给出真正的原因', () => {
    expect(checkBrowserUsePolicy('', only(['github.com']))).toBeNull();
    expect(checkBrowserUsePolicy('not a url', only(['github.com']))).toBeNull();
  });

  it('名单里的空串/垃圾条目被忽略, 不会变成"匹配一切"', () => {
    expect(checkBrowserUsePolicy('https://example.com/', only(['', '   ', '*.']))).not.toBeNull();
  });
});

describe('parseBrowserUsePolicy', () => {
  it('缺字段 / 类型不对都回默认的 open, 不抛', () => {
    expect(parseBrowserUsePolicy(undefined)).toEqual({ policy: 'open', allow: [], deny: [] });
    expect(parseBrowserUsePolicy({ browserUse: { policy: 'nonsense', allow: 'github.com' } }))
      .toEqual({ policy: 'open', allow: [], deny: [] });
  });

  it('读得出 allowlist + 两个名单, 并把两边空白去掉', () => {
    expect(parseBrowserUsePolicy({ browserUse: { policy: 'allowlist', allow: [' github.com '], deny: ['x.com', 7] } }))
      .toEqual({ policy: 'allowlist', allow: ['github.com'], deny: ['x.com'] });
  });
});
