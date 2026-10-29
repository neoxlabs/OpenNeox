/**
 * 旧 turnFsWindow 测试依赖 FS membership。WriteLedger 定型后 FS 时间窗不再决定
 * 「本轮改动」—— 本文件改为断言: 无声明时聚合为空, 且不再调用 getFsEventsBetween.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

/* 显式声明入参 —— 下面 getFsEventsBetween 会带 (a,b) 调它, 0 参 mock 会报 TS2554 */
const between = vi.fn((_a: number, _b: number) => [] as any[]);
vi.mock('../../../state/workspaceFsEventLog', () => ({
  getFsEventsBetween: (a: number, b: number) => between(a, b),
}));

const { aggregateTurnChanges } = await import('../aggregateTurnChanges');

const userMsg = (ts: number) => ({
  id: 'u1', type: 'user_message', timestamp: ts, content: 'hi',
}) as any;
const toolEntry = (ts: number) => ({
  id: 't1', type: 'tool_call', timestamp: ts, toolName: 'read_file', status: 'success',
}) as any;

describe('本轮改动不再用 FS 时间窗做 membership', () => {
  beforeEach(() => between.mockClear());

  test('无写声明时返回 null, 且不查询 FS log', () => {
    const end = Date.now() - 10 * 60_000;
    const summary = aggregateTurnChanges([userMsg(end - 5_000), toolEntry(end)], '/ws');
    expect(summary).toBeNull();
    expect(between).not.toHaveBeenCalled();
  });

  test('有 edit 声明时仍聚合, 仍不查 FS', () => {
    const start = Date.now() - 60_000;
    const summary = aggregateTurnChanges([
      userMsg(start),
      {
        id: 'e1',
        type: 'edit_file',
        timestamp: start + 1000,
        editFilePath: '/ws/a.ts',
        editStartLine: 1,
        editOldString: 'a',
        editNewString: 'b',
        success: true,
      } as any,
    ], '/ws');
    expect(summary).not.toBeNull();
    expect(summary!.totalFiles).toBe(1);
    expect(between).not.toHaveBeenCalled();
  });
});
