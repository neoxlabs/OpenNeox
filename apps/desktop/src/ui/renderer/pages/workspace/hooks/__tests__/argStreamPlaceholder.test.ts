import { describe, expect, it } from 'vitest';
import {
  isUnclaimedArgStreamPlaceholder, PLACEHOLDER_ID_PREFIX, runEndToolCallPatch,
  supersededOnRetry, unclaimedAtRunEndPatch,
} from '../argStreamPlaceholder';
import { pickStatus } from '../../../../modules/agent-timeline/mapTimeline';
import { createId } from '../../utils';

const placeholder = (over: Record<string, unknown> = {}) => ({
  id: createId(PLACEHOLDER_ID_PREFIX),
  type: 'tool_call',
  title: 'Execute shell',
  detail: '',
  timestamp: Date.now(),
  pending: true,
  streaming: true,
  toolName: 'execute_shell',
  toolCallId: 'toolu_1',
  ...over,
}) as any;

describe('isUnclaimedArgStreamPlaceholder', () => {
  it('没被认领的占位卡 (用户实拍「工具失败 · 未知错误」那一行) → true', () => {
    expect(isUnclaimedArgStreamPlaceholder(placeholder())).toBe(true);
  });

  it('被 tool_call 认领过 (streaming 清掉 + 有 toolArgs) → false, 这是真调用', () => {
    expect(isUnclaimedArgStreamPlaceholder(placeholder({ streaming: undefined, toolArgs: { command: 'ls' } }))).toBe(false);
  });

  it('write_file 认领后仍保持 streaming, 但有 toolArgs → false', () => {
    expect(isUnclaimedArgStreamPlaceholder(placeholder({ toolName: 'write_file', toolArgs: { file_path: '' } }))).toBe(false);
  });

  it('不是占位卡建出来的普通 tool_call → false', () => {
    expect(isUnclaimedArgStreamPlaceholder(placeholder({ id: createId('timeline-tool-call') }))).toBe(false);
  });

  it('已经落定成别的类型 → false', () => {
    expect(isUnclaimedArgStreamPlaceholder(placeholder({ type: 'tool_error' }))).toBe(false);
  });
});

describe('runEndToolCallPatch', () => {
  const claimed = () => placeholder({ streaming: undefined, toolArgs: { command: 'which claude' }, commandCode: 'which claude' });

  it('中断: 落成 pickStatus 认得的 interrupted, 不是红色「工具失败」', () => {
    const next = { ...claimed(), ...runEndToolCallPatch(claimed(), { interrupted: true }, true) };
    expect(pickStatus(next)).toBe('interrupted');
    expect(next.errorMessage).toBe('本轮已中断');
  });

  it('失败: 带原因, 不会落到「未知错误」', () => {
    const next = { ...claimed(), ...runEndToolCallPatch(claimed(), { failed: true }, true) };
    expect(pickStatus(next)).toBe('failed');
    expect(next.errorMessage).toBeTruthy();
  });

  it('已有错误信息不被覆盖', () => {
    const prev = claimed();
    (prev as any).errorMessage = 'ENOENT';
    expect(runEndToolCallPatch(prev, { failed: true }, true).errorMessage).toBe('ENOENT');
  });

  it('正常结束: 按成功收尾', () => {
    const next = { ...claimed(), ...runEndToolCallPatch(claimed(), {}, true) };
    expect(next.type).toBe('tool_result');
    expect(next.success).toBe(true);
  });
});

describe('流式重试 / 流断在参数中间', () => {
  it('重试时: 上一次没生成完的调用作废, 已认领的真调用和已落定的条目不动', () => {
    const aborted = placeholder({ toolCallId: 'call_00_attempt1' });
    const realCall = placeholder({ streaming: undefined, toolArgs: { command: 'which claude' } });
    const done = placeholder({ pending: false, streaming: undefined, type: 'tool_result', toolArgs: {} });
    expect(supersededOnRetry([done, realCall, aborted]).map((e) => e.id)).toEqual([aborted.id]);
  });

  it('本轮失败时还没生成完: 如实写"没生成完、没执行", 不是「未知错误」, 也不删', () => {
    const next = { ...placeholder(), ...unclaimedAtRunEndPatch({}, true) };
    expect(pickStatus(next)).toBe('failed');
    expect(next.errorMessage).toContain('没有执行');
    expect(next.pending).toBe(false);
  });

  it('运行出错时带上原因', () => {
    expect(unclaimedAtRunEndPatch({}, true, 'Stream timeout: no data for 120s').errorMessage)
      .toContain('Stream timeout');
  });

  it('用户停止: 已停止 (灰), 不染红', () => {
    const next = { ...placeholder(), ...unclaimedAtRunEndPatch({ interrupted: true }, true) };
    expect(pickStatus(next)).toBe('interrupted');
  });
});
