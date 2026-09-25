import { describe, it, expect } from 'vitest';
import { shouldIncludeLastRun } from '../runnerContextUtils.js';

describe('shouldIncludeLastRun', () => {
  it('detects 接着/接着做/接着干 continuation (bug #1)', () => {
    expect(shouldIncludeLastRun('接着做')).toBe(true);
    expect(shouldIncludeLastRun('接着干')).toBe(true);
    expect(shouldIncludeLastRun('接着完善手机商城')).toBe(true);
    expect(shouldIncludeLastRun('接下来呢')).toBe(true);
  });

  it('still detects the original continuation words', () => {
    expect(shouldIncludeLastRun('继续')).toBe(true);
    expect(shouldIncludeLastRun('上次说到哪了')).toBe(true);
    expect(shouldIncludeLastRun('continue')).toBe(true);
    expect(shouldIncludeLastRun('keep going')).toBe(true);
  });

  it('returns false for fresh, non-continuation tasks', () => {
    expect(shouldIncludeLastRun('写一个登录页')).toBe(false);
    expect(shouldIncludeLastRun('fix the bug in auth.ts')).toBe(false);
    expect(shouldIncludeLastRun('')).toBe(false);
    expect(shouldIncludeLastRun('   ')).toBe(false);
  });
});
