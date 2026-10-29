import { describe, it, expect } from 'vitest';
import { isTurnFatalEntry, pickStatus } from '../mapTimeline';
import { activityFailureCount } from '../timelineRows';
import type { TimelineEntry } from '../../../utils/workspaceUtils';
import type { Row, RowStep } from '../timelineRows';
import type { TimelineStep } from '../types';

const entry = (over: Partial<TimelineEntry> = {}): TimelineEntry => ({
  id: 'e1',
  type: 'tool_error',
  title: '执行命令',
  toolName: 'run_shell_command',
  success: false,
  errorMessage: 'exit code 1',
  timestamp: 1,
  ...over,
} as unknown as TimelineEntry);

const step = (over: Partial<TimelineStep> = {}): RowStep => ({
  kind: 'legacy_step',
  step: {
    kind: 'tool',
    id: over.id ?? 's1',
    title: '执行命令',
    status: 'failed',
    iconKind: 'tool',
    ...over,
  } as TimelineStep,
} as unknown as RowStep);

const activity = (steps: RowStep[]): Extract<Row, { kind: 'activity' }> => ({
  kind: 'activity',
  id: 'a1',
  rows: steps.map((s) => ({ kind: 'single', step: s })),
} as unknown as Extract<Row, { kind: 'activity' }>);

describe('工具自己返回的错', () => {
  it('不是致命 —— agent 拿到错误文本换个做法就接着干', () => {
    expect(isTurnFatalEntry(entry())).toBe(false);
    /* 命令非零退出 / 补丁打不上 / 文件不存在, 都是同一类 */
    expect(isTurnFatalEntry(entry({ errorMessage: 'ENOENT: no such file' }))).toBe(false);
    expect(isTurnFatalEntry(entry({ errorCode: 'auth.expired' }))).toBe(false);
  });

  it('状态照旧是 failed —— 展开后那一步不许假装成功', () => {
    expect(pickStatus(entry())).toBe('failed');
  });

  it('tone=benign 的失败不计进红色药丸, 没标记的照算', () => {
    const benign = step({ id: 'b', tone: 'benign' });
    const real = step({ id: 'r' });
    expect(activityFailureCount(activity([benign]))).toBe(0);
    expect(activityFailureCount(activity([benign, real]))).toBe(1);
    /* 高负载那条早就不该拉警报, 一并守住 */
    expect(activityFailureCount(activity([step({ id: 'x', tone: 'busy' })]))).toBe(0);
  });

  it('成功的步骤本来就不算', () => {
    expect(activityFailureCount(activity([step({ id: 'ok', status: 'done' })]))).toBe(0);
  });
});

describe('真正的错误 —— agent 干不下去了', () => {
  it('这一轮跑挂了算致命', () => {
    expect(isTurnFatalEntry(entry({ type: 'runner_error' }))).toBe(true);
  });

  it('没有错误码的普通条目不算致命 —— 不认识就别拉警报', () => {
    expect(isTurnFatalEntry(entry({ type: 'tool_result', errorCode: undefined }))).toBe(false);
  });
});
