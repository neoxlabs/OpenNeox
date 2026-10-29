import { describe, it, expect } from 'vitest';
import { targetModeChip } from '../useSessionModeGlow';

const SID = 'sess-A';
const OTHER = 'sess-B';

describe('targetModeChip', () => {
  it('active / paused 才亮运行牌', () => {
    expect(targetModeChip({
      sessionId: SID, targetSessionId: SID, status: 'active', updatedAt: 1,
    })).toEqual({ kind: 'target', phase: 'running', glow: true, label: 'TARGET' });
    expect(targetModeChip({
      sessionId: SID, targetSessionId: SID, status: 'paused', updatedAt: 1,
    })?.phase).toBe('running');
  });

  it('satisfied / abandoned / expired 立刻撤牌 — 达成态交给 Dock 药丸', () => {
    for (const status of ['satisfied', 'abandoned', 'expired'] as const) {
      expect(
        targetModeChip({ sessionId: SID, targetSessionId: SID, status, updatedAt: 1 }),
        status,
      ).toBeNull();
    }
  });

  it('别的会话的 target 不串到当前输入框', () => {
    expect(targetModeChip({
      sessionId: SID, targetSessionId: OTHER, status: 'active', updatedAt: 1,
    })).toBeNull();
  });

  it('/target 刚发出、后端还是 off 时亮乐观牌', () => {
    expect(targetModeChip({
      sessionId: SID,
      targetSessionId: SID,
      status: 'off',
      intentSessionId: SID,
      intentAt: 20,
      updatedAt: 10,
    })?.phase).toBe('planning');
  });

  it('已经放弃过的旧意图不能把牌拉回来', () => {
    expect(targetModeChip({
      sessionId: SID,
      targetSessionId: SID,
      status: 'off',
      intentSessionId: SID,
      intentAt: 5,
      updatedAt: 10,
    })).toBeNull();
  });
});
