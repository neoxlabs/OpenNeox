/**
 * computer-use 叠加层状态机 —— 只有两态, 没有第三态.
 *
 *   idle     没罩子, 鼠标归用户
 *   driving  有罩子且整层穿透; 注入期间的鼠标锁在桥里, 不在这层窗
 *
 * 进出:
 *   session_start / 动作  → driving (罩子立刻亮)
 *   session_end           → idle    (罩子立刻关)
 *   user_stop             → idle    (立刻关; 吞掉随后那条 session_end)
 *
 * 曾经有过 dismissible: 脚本已经停、罩子还盖着、不再穿透.
 * 那就是「已经能点桌面但蓝罩还在」和「热区把 WPS 顶栏吃掉」的源头, 删掉.
 */

export type OverlayPhase = 'idle' | 'driving';

export interface OverlaySessionState {
  phase: OverlayPhase;
  /** user_stop 之后, computer_run finally 还会再推 session_end / 又一条 user_stop */
  swallowEnd: boolean;
}

export type OverlayEventName = 'session_start' | 'session_end' | 'user_stop' | 'action';

export type OverlayCommand = 'show' | 'hide' | 'stay';

export function createOverlaySession(): OverlaySessionState {
  return { phase: 'idle', swallowEnd: false };
}

export function reduceOverlaySession(
  state: OverlaySessionState,
  event: OverlayEventName,
): { state: OverlaySessionState; command: OverlayCommand } {
  switch (event) {
    case 'session_start':
    case 'action': {
      const next: OverlaySessionState = { phase: 'driving', swallowEnd: false };
      return { state: next, command: state.phase === 'driving' ? 'stay' : 'show' };
    }
    case 'session_end': {
      if (state.swallowEnd) {
        return { state: { phase: 'idle', swallowEnd: false }, command: 'stay' };
      }
      if (state.phase === 'idle') {
        return { state, command: 'stay' };
      }
      return { state: { phase: 'idle', swallowEnd: false }, command: 'hide' };
    }
    case 'user_stop': {
      const next: OverlaySessionState = { phase: 'idle', swallowEnd: true };
      return { state: next, command: state.phase === 'driving' ? 'hide' : 'stay' };
    }
  }
}

export function classifyPointerAction(action: string): OverlayEventName | 'ignore' {
  if (action === '__capture_hide' || action === '__capture_show') return 'ignore';
  if (action === 'session_start') return 'session_start';
  if (action === 'session_end') return 'session_end';
  if (action === 'user_stop') return 'user_stop';
  return 'action';
}

/** 看一眼之后模型通常几秒内开跑; 超时还没有动作就把罩子收掉. 注入中才用挂死兜底. */
export const SNAPSHOT_HOLD_MS = 20_000;
export const HUNG_HOLD_MS = 120_000;

export function overlayHoldMs(event: OverlayEventName, label?: string): number | null {
  if (event === 'session_end' || event === 'user_stop') return null;
  if (event === 'session_start' && (label ?? '').trim() === 'snapshot') return SNAPSHOT_HOLD_MS;
  return HUNG_HOLD_MS;
}
