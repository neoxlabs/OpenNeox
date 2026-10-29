import { describe, it, expect } from 'vitest';
import { pickStatus } from '../mapTimeline';
import { pickCurrentTurnAnomalies } from '../turnAnomaly';
import type { TimelineEntry } from '../../../utils/workspaceUtils';

const blocked = (over: Partial<TimelineEntry> = {}): TimelineEntry => ({
  id: 'e1',
  type: 'tool_result',
  title: '读取文件',
  toolName: 'readfile',
  success: false,
  blockedBy: 'loop',
  blockedNotice: '同一个目标重复了 4 次 · mainWindowFactory.ts',
  timestamp: 1,
  ...over,
} as unknown as TimelineEntry);

describe('被守卫拦下的一步', () => {
  it('不染红 —— 状态是 done 不是 failed', () => {
    expect(pickStatus(blocked())).toBe('done');
    /* 对照: 同样 success:false 但没有 blockedBy = 真失败 */
    expect(pickStatus(blocked({ blockedBy: undefined, blockedNotice: undefined }))).toBe('failed');
  });

  it('不进输入框上方的异常区 —— 那里是给真故障的', () => {
    const entries = [
      { id: 'u1', type: 'user_message', title: 'hi', timestamp: 0 } as unknown as TimelineEntry,
      blocked({ id: 'b1', type: 'tool_error' }),
    ];
    expect(pickCurrentTurnAnomalies(entries)).toHaveLength(0);
    /* 对照: 去掉 blockedBy 就该被异常区收走 */
    const asFailure = [
      entries[0]!,
      blocked({ id: 'b2', type: 'tool_error', blockedBy: undefined, blockedNotice: undefined, errorMessage: 'boom' }),
    ];
    expect(pickCurrentTurnAnomalies(asFailure)).toHaveLength(1);
  });
});
