import { describe, it, expect } from 'vitest';
import { shouldBypassProxy } from '../proxy/bypass.js';

const REAL_USER_EXCEPTIONS = [
  '127.0.0.1/8', '192.168.0.0/16', '10.0.0.0/8', '172.16.0.0/12',
  'localhost', '*.local', '*.crashlytics.com', '<local>', 'http://holymastercard.com',
];

const cfg = (exceptions: string[], excludeSimpleHostnames = false) => ({ exceptions, excludeSimpleHostnames });

describe('例外表 · 用户真机条目', () => {
  const c = cfg(REAL_USER_EXCEPTIONS);
  const bypass = (host: string, port = 443) => shouldBypassProxy(host, port, c);

  it('CIDR 网段 —— 旧实现完全失效的那一类', () => {
    expect(bypass('192.168.1.50')).toBe(true);
    expect(bypass('10.8.0.1')).toBe(true);
    expect(bypass('172.16.5.5')).toBe(true);
    expect(bypass('172.32.0.1')).toBe(false); /* 172.16/12 之外 */
    expect(bypass('11.0.0.1')).toBe(false);
  });

  it('*.local 通配 与 <local> 简单主机名', () => {
    expect(bypass('mac-mini.local')).toBe(true);
    expect(bypass('printer')).toBe(true);       /* <local>: 不含点 */
    expect(bypass('example.com')).toBe(false);
  });

  it('带 scheme 的条目要剥掉 scheme 再比', () => {
    expect(bypass('holymastercard.com')).toBe(true);
    expect(bypass('www.holymastercard.com')).toBe(true);
  });

  it('子域匹配 (Chrome 语义: example.com 也覆盖 www.example.com)', () => {
    expect(bypass('api.crashlytics.com')).toBe(true);
    expect(bypass('crashlytics.com')).toBe(true);
    expect(bypass('notcrashlytics.com')).toBe(false);
  });

  it('外部 host 不受影响 —— 该走代理的必须走代理', () => {
    expect(bypass('neox-dev.com')).toBe(false);
    expect(bypass('api.anthropic.com')).toBe(false);
  });
});

describe('回环 · 无条件直连 (我们自己的 IPC 通道, 不是用户路由)', () => {
  const c = cfg([]);
  it('用户例外表为空也要绕过', () => {
    expect(shouldBypassProxy('127.0.0.1', 4500, c)).toBe(true);
    expect(shouldBypassProxy('localhost', 5180, c)).toBe(true);
    expect(shouldBypassProxy('::1', 8088, c)).toBe(true);
    expect(shouldBypassProxy('[::1]', 8088, c)).toBe(true);
    expect(shouldBypassProxy('127.0.0.53', 53, c)).toBe(true);
  });
  it('外部 host 仍然走代理', () => {
    expect(shouldBypassProxy('neox-dev.com', 443, c)).toBe(false);
  });
});

describe('例外表 · 其它形态', () => {
  it('* 全部直连', () => {
    expect(shouldBypassProxy('anything.com', 443, cfg(['*']))).toBe(true);
  });
  it('host:port 只对该端口生效', () => {
    const c = cfg(['example.com:8080']);
    expect(shouldBypassProxy('example.com', 8080, c)).toBe(true);
    expect(shouldBypassProxy('example.com', 443, c)).toBe(false);
  });
  it('.suffix 写法', () => {
    const c = cfg(['.internal.corp']);
    expect(shouldBypassProxy('git.internal.corp', 443, c)).toBe(true);
    expect(shouldBypassProxy('internal.corp', 443, c)).toBe(true);
    expect(shouldBypassProxy('internal.corp.evil.com', 443, c)).toBe(false);
  });
  it('IPv6 CIDR', () => {
    const c = cfg(['fd00::/8']);
    expect(shouldBypassProxy('fd12:3456::1', 443, c)).toBe(true);
    expect(shouldBypassProxy('2001:db8::1', 443, c)).toBe(false);
  });
  it('Windows 风格 10.*.*.*', () => {
    const c = cfg(['10.*.*.*']);
    expect(shouldBypassProxy('10.1.2.3', 443, c)).toBe(true);
    expect(shouldBypassProxy('11.1.2.3', 443, c)).toBe(false);
  });
  it('excludeSimpleHostnames 独立开关', () => {
    expect(shouldBypassProxy('intranet', 443, cfg([], true))).toBe(true);
    expect(shouldBypassProxy('intranet', 443, cfg([], false))).toBe(false);
  });
});
