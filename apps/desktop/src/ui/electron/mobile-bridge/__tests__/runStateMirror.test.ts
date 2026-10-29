import { beforeEach, describe, expect, it } from 'vitest';
import {
  _clearAllRunStateMirrorForTest,
  getMirroredRunState,
  mergeRunStateForSubscribe,
  onRunStatusChange,
  recordIdleFromTurnDone,
  recordRunState,
} from '../runStateMirror.js';

describe('runStateMirror', () => {
  beforeEach(() => {
    _clearAllRunStateMirrorForTest();
  });

  it('notifies only when status flips (heartbeat replays of the same status stay quiet)', () => {
    const seen: string[] = [];
    const off = onRunStatusChange((id, status) => seen.push(`${id}:${status}`));
    recordRunState('s9', { status: 'running', updatedAt: 1 });
    recordRunState('s9', { status: 'running', updatedAt: 2 });
    recordRunState('s9', { status: 'awaiting_approval', updatedAt: 3 });
    recordIdleFromTurnDone('s9', null, 4);
    off();
    recordRunState('s9', { status: 'running', updatedAt: 5 });
    expect(seen).toEqual(['s9:running', 's9:awaiting_approval', 's9:idle']);
  });

  it('records run_state even when later push would SKIP no-sub', () => {
    recordRunState('s1', {
      status: 'running',
      turnId: 't1',
      pendingToolCalls: [{ toolCallId: 'c1' }],
      updatedAt: 100,
    });
    expect(getMirroredRunState('s1')).toEqual(
      expect.objectContaining({
        status: 'running',
        turn_id: 't1',
        updated_at: 100,
      }),
    );
  });

  it('ignores stale updates with older updated_at', () => {
    recordRunState('s1', { status: 'idle', updated_at: 200 });
    recordRunState('s1', { status: 'running', updated_at: 100 });
    expect(getMirroredRunState('s1')?.status).toBe('idle');
  });

  it('recordIdleFromTurnDone writes idle for attach snapshot', () => {
    recordRunState('s1', { status: 'running', turn_id: 't1', updated_at: 50 });
    recordIdleFromTurnDone('s1', 't1', 80);
    expect(getMirroredRunState('s1')).toEqual(
      expect.objectContaining({ status: 'idle', turn_id: 't1', updated_at: 80 }),
    );
  });

  it('mergeRunStateForSubscribe prefers newer updated_at', () => {
    const mirror = recordRunState('s1', { status: 'idle', updated_at: 300 })!;
    const store = {
      status: 'running',
      turn_id: 'old',
      last_committed_seq: null,
      pending_tool_calls: [],
      initiated_by: null,
      paused_at: null,
      updated_at: 100,
    };
    expect(mergeRunStateForSubscribe(mirror, store)?.status).toBe('idle');
    expect(mergeRunStateForSubscribe(mirror, { ...store, updated_at: 400 })?.status).toBe(
      'running',
    );
  });

  it('merge falls back when one side missing', () => {
    expect(mergeRunStateForSubscribe(null, null)).toBeNull();
    const onlyStore = {
      status: 'idle',
      turn_id: null,
      last_committed_seq: null,
      pending_tool_calls: [],
      initiated_by: null,
      paused_at: null,
      updated_at: 1,
    };
    expect(mergeRunStateForSubscribe(null, onlyStore)?.status).toBe('idle');
  });
});
