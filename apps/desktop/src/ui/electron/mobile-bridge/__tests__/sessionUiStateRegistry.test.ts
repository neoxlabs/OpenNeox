import { beforeEach, describe, expect, it } from 'vitest';
import {
  _clearAllSessionUiStateForTest,
  clearActiveSubagents,
  clearSessionUiState,
  getActiveSubagents,
  getPlan,
  recordPlanUpdate,
  recordSubagentDone,
  recordSubagentStart,
} from '../sessionUiStateRegistry.js';

describe('sessionUiStateRegistry', () => {
  beforeEach(() => {
    _clearAllSessionUiStateForTest();
  });

  it('plan_update 全量覆盖并可快照恢复', () => {
    recordPlanUpdate('s1', {
      explanation: 'v1',
      plan: [{ step: 'a', status: 'pending' }],
    });
    recordPlanUpdate('s1', {
      explanation: 'v2',
      plan: [
        { step: 'a', status: 'completed' },
        { step: 'b', status: 'in_progress' },
      ],
    });

    const snap = getPlan('s1');
    expect(snap?.explanation).toBe('v2');
    expect(snap?.plan).toHaveLength(2);
    expect(snap?.plan[1]).toEqual({ step: 'b', status: 'in_progress' });
    expect(getPlan('s2')).toBeNull();
  });

  it('快照是深拷贝 — 改快照不影响 registry', () => {
    recordPlanUpdate('s1', { plan: [{ step: 'a', status: 'pending' }] });
    const snap = getPlan('s1')!;
    snap.plan[0]!.status = 'completed';
    expect(getPlan('s1')!.plan[0]!.status).toBe('pending');
  });

  it('subagent start/done 生命周期', () => {
    recordSubagentStart('s1', {
      agent_id: 'w1',
      task: 'explore repo',
      model: 'm',
      role_name: 'explore',
      is_background: false,
      is_agent_tool: true,
      model_inherited: false,
    });
    recordSubagentStart('s1', {
      agent_id: 'w2',
      task: 'run tests',
      model: null,
      role_name: null,
      is_background: true,
      is_agent_tool: true,
      model_inherited: false,
    });
    expect(getActiveSubagents('s1')).toHaveLength(2);

    recordSubagentDone('s1', 'w1');
    const remaining = getActiveSubagents('s1');
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.agent_id).toBe('w2');

    clearActiveSubagents('s1');
    expect(getActiveSubagents('s1')).toEqual([]);
  });

  it('clearSessionUiState 全清 plan + subagents; plan 不受 turn 清理影响', () => {
    recordPlanUpdate('s1', { plan: [{ step: 'a', status: 'pending' }] });
    recordSubagentStart('s1', {
      agent_id: 'w1',
      task: 't',
      model: null,
      role_name: null,
      is_background: false,
      is_agent_tool: true,
      model_inherited: false,
    });

    /* agent_turn_done 只清 subagents, plan 跨 turn 保留 */
    clearActiveSubagents('s1');
    expect(getPlan('s1')).not.toBeNull();

    clearSessionUiState('s1');
    expect(getPlan('s1')).toBeNull();
    expect(getActiveSubagents('s1')).toEqual([]);
  });
});
