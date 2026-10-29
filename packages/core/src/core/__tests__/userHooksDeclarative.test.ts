/**
 * P2-6 声明式 hooks — matcher 匹配与 decision 协议纯函数测试。
 */
import { describe, expect, it } from 'vitest';
import { matchesTool, parseHookDecision } from '../userHooks.js';

describe('matchesTool', () => {
  it('empty/undefined matcher matches everything', () => {
    expect(matchesTool(undefined, 'execute_shell')).toBe(true);
    expect(matchesTool('', 'write_file')).toBe(true);
    expect(matchesTool('  ', 'edit')).toBe(true);
  });

  it('regex alternation matches listed tools only', () => {
    expect(matchesTool('execute_shell|write_file', 'execute_shell')).toBe(true);
    expect(matchesTool('execute_shell|write_file', 'write_file')).toBe(true);
    expect(matchesTool('execute_shell|write_file', 'readfile')).toBe(false);
  });

  it('is anchored — partial names do not match', () => {
    expect(matchesTool('edit', 'edit_file')).toBe(false);
    expect(matchesTool('edit.*', 'edit_file')).toBe(true);
  });

  it('invalid regex falls back to exact match', () => {
    expect(matchesTool('([bad', '([bad')).toBe(true);
    expect(matchesTool('([bad', 'other')).toBe(false);
  });
});

describe('parseHookDecision', () => {
  it('exit 2 blocks with stderr as reason', () => {
    const d = parseHookDecision(2, '', 'dangerous command detected');
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('dangerous command detected');
  });

  it('stdout JSON decision:block blocks with reason', () => {
    const d = parseHookDecision(0, '{"decision":"block","reason":"policy violation"}', '');
    expect(d).toEqual({ allow: false, reason: 'policy violation' });
  });

  it('stdout JSON decision:approve allows', () => {
    expect(parseHookDecision(0, '{"decision":"approve"}', '').allow).toBe(true);
  });

  it('non-JSON stdout allows', () => {
    expect(parseHookDecision(0, 'just some logging output', '').allow).toBe(true);
  });

  it('exit 0 with empty output allows', () => {
    expect(parseHookDecision(0, '', '').allow).toBe(true);
  });

  it('exit 1 (script error) does not block declarative hooks', () => {
    expect(parseHookDecision(1, '', 'oops').allow).toBe(true);
  });
});
