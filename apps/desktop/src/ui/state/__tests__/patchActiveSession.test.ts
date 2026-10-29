import { describe, it, expect } from 'vitest';
import { sessionReducer, SessionActionType } from '../sessionStore';

const A = { id: 'A', name: '后台运行sleep', messages: [] } as any;
const B = { id: 'B', name: '新会话', messages: [] } as any;
const base = { activeSession: A, sessions: [A] } as any;

describe('PATCH_ACTIVE_SESSION', () => {
  it('期间切到 B: 对 A 的刷新不生效, 仍是 B', () => {
    let s = sessionReducer(base, { type: SessionActionType.SET_ACTIVE_SESSION, payload: B });
    s = sessionReducer(s, { type: SessionActionType.PATCH_ACTIVE_SESSION, payload: { id: 'A', patch: { name: '新标题' } } });
    expect(s.activeSession?.id).toBe('B');
    expect(s.activeSession?.name).toBe('新会话');
  });

  it('还是 A: 只改给的字段', () => {
    const s = sessionReducer(base, { type: SessionActionType.PATCH_ACTIVE_SESSION, payload: { id: 'A', patch: { name: '新标题' } } });
    expect(s.activeSession).toMatchObject({ id: 'A', name: '新标题' });
  });

  it('值没变: state 引用不变 (不打穿下游 memo)', () => {
    const s = sessionReducer(base, { type: SessionActionType.PATCH_ACTIVE_SESSION, payload: { id: 'A', patch: { name: A.name } } });
    expect(s).toBe(base);
  });
});
