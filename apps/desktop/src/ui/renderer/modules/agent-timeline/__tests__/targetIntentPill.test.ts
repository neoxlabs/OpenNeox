import { describe, it, expect, beforeEach } from 'vitest';
import {
  markTargetIntent, clearTargetIntent, resetTargetIndicator,
  __applySnapshotForTest, getTargetIndicatorState,
} from '../targetIndicatorStore';

const SID = 'sess-A';
const OTHER = 'sess-B';

const snap = (over: Record<string, any>) => ({
  sessionId: null, status: 'off', target: null, rationale: null, subMissions: [],
  createdAt: null, updatedAt: Date.now(), maxRunTimeMs: null, lastDoneCheck: null,
  abandonReason: null, elapsedMs: 0, subMissionCount: 0, completedSubMissions: 0,
  phase: 'execute' as const, ...over,
});

beforeEach(() => { resetTargetIndicator(); });

describe('target 乐观药丸', () => {
  it('① 标记后只有那个会话亮', () => {
    markTargetIntent(SID);
    const s = getTargetIndicatorState();
    expect(s.intentSessionId).toBe(SID);
    expect(s.intentAt).toBeGreaterThan(0);
    expect(s.intentSessionId).not.toBe(OTHER);
  });

  it('② 真态落地 (active) 后乐观态退场', () => {
    markTargetIntent(SID);
    __applySnapshotForTest(snap({ sessionId: SID, status: 'active' }) as any);
    expect(getTargetIndicatorState().intentSessionId, '真态接手了就不该再有假态').toBeNull();
  });

  it('② 别的会话进了 active 不该撤掉本会话的乐观态', () => {
    markTargetIntent(SID);
    __applySnapshotForTest(snap({ sessionId: OTHER, status: 'active' }) as any);
    expect(getTargetIndicatorState().intentSessionId).toBe(SID);
  });

  it('② 还是 off 的快照不撤乐观态 (那正是要盖住的空档)', () => {
    markTargetIntent(SID);
    __applySnapshotForTest(snap({ sessionId: SID, status: 'off' }) as any);
    expect(getTargetIndicatorState().intentSessionId).toBe(SID);
  });

  it('③ 宽限窗过了 clear 掉', () => {
    markTargetIntent(SID);
    clearTargetIntent(SID);
    expect(getTargetIndicatorState().intentSessionId).toBeNull();
  });

  it('③ clear 传别的会话 id 时不许误伤', () => {
    markTargetIntent(SID);
    clearTargetIntent(OTHER);
    expect(getTargetIndicatorState().intentSessionId).toBe(SID);
  });
});
