/**
 * 审计 F08: 宽松模式下 CDP 连不上 → 全部 skip → 退出码 0, 发布门禁把"没验收"当"能放行"。
 */
import { describe, expect, it } from 'vitest';
import { strictGateViolations } from '../catalogRunner.js';

describe('strictGateViolations', () => {
  it('零执行不放行', () => {
    expect(strictGateViolations({ pass: 0, fail: 0, skip: 1, manual: 0 })).toEqual(
      expect.arrayContaining(['no scenario was executed', '1 skipped']),
    );
  });

  it('有 manual 不放行', () => {
    expect(strictGateViolations({ pass: 3, fail: 0, skip: 0, manual: 2 })).toHaveLength(1);
  });

  it('全部执行且没有 skip / manual 才放行', () => {
    expect(strictGateViolations({ pass: 3, fail: 0, skip: 0, manual: 0 })).toEqual([]);
  });
});
