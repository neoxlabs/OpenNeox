import { describe, it, expect } from 'vitest';
import { classifyToolFailure, FAILURE_GROUP, detectCommandFailure } from '../toolFailureClassifier.js';

describe('classifyToolFailure — 失败归因', () => {
  const c = (kind?: string, out?: string) => classifyToolFailure('x', kind, out);

  it('参数问题 (模型的锅)', () => {
    expect(c('string_not_found')).toBe('bad_args');
    expect(c('ambiguous_match')).toBe('bad_args');
    expect(c('Invalid regex: (')).toBe('bad_args');
    expect(c('Missing required parameter: file_path')).toBe('bad_args');
    expect(c('Content is empty')).toBe('bad_args');
    expect(c('Path is outside workspace')).toBe('bad_args');
    expect(c(undefined, '{"error":"old_string not found in file"}')).toBe('bad_args');
  });

  it('状态漂移', () => {
    expect(c('stale_snapshot')).toBe('stale');
    expect(c('file has been modified')).toBe('stale');
  });

  it('被拦 (沙盒/权限)', () => {
    expect(c(undefined, 'zsh: operation not permitted')).toBe('blocked');
    expect(c('EACCES: permission denied')).toBe('blocked');
  });

  it('超时/中断', () => {
    expect(c('Operation timed out')).toBe('timeout');
    expect(c('ETIMEDOUT')).toBe('timeout');
    expect(c('aborted')).toBe('timeout');
  });

  it('模型/网关侧', () => {
    expect(c('rate limit exceeded')).toBe('provider');
    expect(c('429 Too Many Requests')).toBe('provider');
    expect(c('maximum context length exceeded')).toBe('provider');
  });

  it('目标不存在', () => {
    expect(c('ENOENT: no such file')).toBe('not_found');
    expect(c('search: no matches')).toBe('not_found');
  });

  it('有报错但归不进 → harness; 无报错 → unknown', () => {
    expect(c('some weird internal crash xyz')).toBe('harness');
    expect(c(undefined, undefined)).toBe('unknown');
    expect(c('', '')).toBe('unknown');
  });

  it('分组映射 (参数/命令/运行时/模型服务/环境/状态)', () => {
    expect(FAILURE_GROUP.bad_args).toBe('参数');
    expect(FAILURE_GROUP.blocked).toBe('运行时');
    expect(FAILURE_GROUP.timeout).toBe('运行时');
    expect(FAILURE_GROUP.not_found).toBe('环境');
    expect(FAILURE_GROUP.provider).toBe('模型服务');
    expect(FAILURE_GROUP.command_failed).toBe('命令');
  });
});

describe('detectCommandFailure — shell 命令级失败探测', () => {
  it('显式 FAILURE 标 → 真失败', () => {
    expect(detectCommandFailure('npm test\n...\n[exit 1 / test_fail / FAILURE]')).toBe(true);
  });
  it('裸 [exit N] 非0 → 失败', () => {
    expect(detectCommandFailure('boom\n[exit 2]')).toBe(true);
  });
  it('grep exit1 no_match 标 SUCCESS → 不算失败', () => {
    expect(detectCommandFailure('(no output)\n[exit 1 / no_match / SUCCESS]')).toBe(false);
  });
  it('exit 0 → 不算失败', () => {
    expect(detectCommandFailure('done\n[exit 0 / empty_output / SUCCESS]')).toBe(false);
    expect(detectCommandFailure('普通输出没有标签')).toBe(false);
    expect(detectCommandFailure(undefined)).toBe(false);
  });
});
