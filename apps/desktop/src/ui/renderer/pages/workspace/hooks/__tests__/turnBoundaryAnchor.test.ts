import { describe, it, expect } from 'vitest';
import {
  isTurnBoundaryUserMessage,
  latestTurnBoundaryIdx,
} from '../useStreamHandler';

const e = (over: any) => ({ id: 'x', type: 'log', timestamp: 1, ...over }) as any;

describe('轮边界锚点', () => {
  it('真用户消息是轮边界', () => {
    expect(isTurnBoundaryUserMessage(e({ id: 'msg-abc', type: 'user_message' }))).toBe(true);
  });

  it('运行中插话 (msg-injected-*) 不是轮边界', () => {
    expect(isTurnBoundaryUserMessage(e({ id: 'msg-injected-123-hi', type: 'user_message' }))).toBe(false);
  });

  it('后台任务通知不是轮边界', () => {
    expect(isTurnBoundaryUserMessage(
      e({ id: 'msg-bg', type: 'user_message', messageSource: 'system-background-task' }),
    )).toBe(false);
  });

  it('非 user_message 一律不是', () => {
    expect(isTurnBoundaryUserMessage(e({ id: 'msg-abc', type: 'runner_error' }))).toBe(false);
  });

  it('插话之后, 锚点仍停在插话之前的那条真用户消息', () => {
    const tl = [
      e({ id: 'msg-u1', type: 'user_message' }),
      e({ id: 'timeline-error-msg-u1-RUNTIME_ERROR', type: 'runner_error' }),
      e({ id: 'msg-injected-1700-ip111', type: 'user_message' }),
    ];
    const idx = latestTurnBoundaryIdx(tl);
    expect(idx).toBe(0);
    /* 这就是修复的实质: 本轮 = 锚点之后的一切, **包含**插话上方那张错误卡,
     * 于是它会被后来的那张收走 —— 一轮最多一张。 */
    const inTurn = tl.slice(idx + 1);
    expect(inTurn.filter((x: any) => x.type === 'runner_error')).toHaveLength(1);
  });

  it('下一条真用户消息开启新一轮 (锚点前移)', () => {
    const tl = [
      e({ id: 'msg-u1', type: 'user_message' }),
      e({ id: 'msg-injected-1700-x', type: 'user_message' }),
      e({ id: 'msg-u2', type: 'user_message' }),
    ];
    expect(latestTurnBoundaryIdx(tl)).toBe(2);
  });

  it('没有任何用户消息时返回 -1 (调用方退回全量扫/随机 id)', () => {
    expect(latestTurnBoundaryIdx([e({}), e({ type: 'runner_error' })])).toBe(-1);
  });
});
