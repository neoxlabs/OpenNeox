import { describe, it, expect, afterEach } from 'vitest';
import { friendlyOpError } from '../notifyEvents';
import { setGlobalLanguage } from '../../hooks/useI18n';

describe('friendlyOpError', () => {
  it('git 的高频英文 stderr 翻成人话 —— 审计里点名的那几条', () => {
    expect(friendlyOpError(new Error('nothing to commit, working tree clean')))
      .toBe('没有需要提交的改动');
    expect(friendlyOpError(new Error('*** Please tell me who you are.\n\nRun\n\n  git config --global user.email')))
      .toContain('用户名和邮箱');
    expect(friendlyOpError(new Error('failed to push some refs to origin')))
      .toContain('先 pull 再推');
    expect(friendlyOpError(new Error('CONFLICT (content): Merge conflict in a.ts')))
      .toBe('有合并冲突需要先解决');
  });

  it('网络错误码翻成能照着做的话', () => {
    expect(friendlyOpError(new Error('connect ECONNREFUSED 127.0.0.1:8080'))).toContain('连接被拒绝');
    expect(friendlyOpError(new Error('getaddrinfo ENOTFOUND api.example.com'))).toContain('域名解析失败');
    expect(friendlyOpError(new Error('EACCES: permission denied'))).toContain('没有权限');
  });

  it('翻译在截断之前发生 —— 否则关键词会被切掉', () => {
    const long = 'x'.repeat(200) + ' nothing to commit';
    expect(friendlyOpError(long)).toBe('没有需要提交的改动');
  });

  it('认不出的消息保持原文, 不瞎猜 —— 但只留第一行且截断', () => {
    const withStack = 'Something very specific broke\n    at foo (bar.ts:1:1)\n    at baz';
    expect(friendlyOpError(withStack)).toBe('Something very specific broke');

    const long = 'y'.repeat(150);
    const out = friendlyOpError(long);
    expect(out.length).toBeLessThanOrEqual(101);
    expect(out.endsWith('…')).toBe(true);
  });

  it('空值走 fallback', () => {
    expect(friendlyOpError(null)).toBe('操作失败');
    expect(friendlyOpError(undefined, '删除失败')).toBe('删除失败');
  });
});

describe('英文界面', () => {
  const setLang = (v: 'zh' | 'en') => {
    try { window.localStorage.setItem('neox-ui-language', v); } catch { /* noop */ }
    setGlobalLanguage(v);
  };
  afterEach(() => setLang('zh'));

  it.each([
    ['ECONNREFUSED 127.0.0.1:7890', /Connection refused/],
    ['fatal: Authentication failed for https://x', /authentication failed/i],
    ['getaddrinfo ENOTFOUND api.example.com', /Could not resolve/],
    ['connect ETIMEDOUT 1.2.3.4:443', /timed out/],
    ['EACCES: permission denied', /Permission denied/],
    ['CONFLICT (content): Merge conflict in a.ts', /merge conflicts/],
  ])('%s → 英文', (raw, want) => {
    setLang('en');
    const out = friendlyOpError(new Error(raw));
    expect(out).toMatch(want);
    expect(out, `不该有中文: ${out}`).not.toMatch(/[一-龥]/);
  });

  it('中文界面照旧给中文', () => {
    setLang('zh');
    expect(friendlyOpError(new Error('ECONNREFUSED'))).toMatch(/连接被拒绝/);
  });

  it('没有 err 时的兜底也跟着语言走', () => {
    setLang('en');
    expect(friendlyOpError(undefined)).toBe('Operation failed');
    setLang('zh');
    expect(friendlyOpError(undefined)).toBe('操作失败');
  });
});
