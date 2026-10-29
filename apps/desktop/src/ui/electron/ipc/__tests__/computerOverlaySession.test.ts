import { describe, expect, it } from 'vitest';
import {
  classifyPointerAction,
  createOverlaySession,
  HUNG_HOLD_MS,
  overlayHoldMs,
  reduceOverlaySession,
  SNAPSHOT_HOLD_MS,
} from '../computerOverlaySession.js';

function apply(events: Array<Parameters<typeof reduceOverlaySession>[1]>) {
  let state = createOverlaySession();
  const commands: string[] = [];
  for (const event of events) {
    const next = reduceOverlaySession(state, event);
    state = next.state;
    commands.push(`${event}:${next.command}`);
  }
  return { state, commands };
}

describe('computer-use 叠加层两态', () => {
  it('snapshot → run → 结束: 亮一次, 立刻关, 没有可点收场', () => {
    const { state, commands } = apply(['session_start', 'action', 'session_end']);
    expect(commands).toEqual(['session_start:show', 'action:stay', 'session_end:hide']);
    expect(state.phase).toBe('idle');
    expect(state.swallowEnd).toBe(false);
  });

  it('点退出之后, finally 的 session_end 不能把罩子再抬起来', () => {
    const { state, commands } = apply(['session_start', 'user_stop', 'session_end']);
    expect(commands).toEqual(['session_start:show', 'user_stop:hide', 'session_end:stay']);
    expect(state.phase).toBe('idle');
  });

  it('退出后下一轮 snapshot 立刻再亮, 没有 20 秒禁亮', () => {
    const { state, commands } = apply([
      'session_start',
      'user_stop',
      'session_end',
      'session_start',
    ]);
    expect(commands).toEqual([
      'session_start:show',
      'user_stop:hide',
      'session_end:stay',
      'session_start:show',
    ]);
    expect(state.phase).toBe('driving');
  });

  it('重复 user_stop 不会反复 hide', () => {
    const { commands } = apply(['session_start', 'user_stop', 'user_stop']);
    expect(commands).toEqual(['session_start:show', 'user_stop:hide', 'user_stop:stay']);
  });

  it('空闲时的 session_end 是空操作', () => {
    const { state, commands } = apply(['session_end']);
    expect(commands).toEqual(['session_end:stay']);
    expect(state.phase).toBe('idle');
  });

  it('截图闪一下的 capture 事件不进状态机', () => {
    expect(classifyPointerAction('__capture_hide')).toBe('ignore');
    expect(classifyPointerAction('__capture_show')).toBe('ignore');
    expect(classifyPointerAction('click_at')).toBe('action');
  });

  it('只看一眼时罩子最多挂 20 秒, 开始注入后改用挂死兜底', () => {
    expect(overlayHoldMs('session_start', 'snapshot')).toBe(SNAPSHOT_HOLD_MS);
    expect(overlayHoldMs('session_start', '3 步')).toBe(HUNG_HOLD_MS);
    expect(overlayHoldMs('action')).toBe(HUNG_HOLD_MS);
    expect(overlayHoldMs('session_end')).toBeNull();
    expect(overlayHoldMs('user_stop')).toBeNull();
  });
});
