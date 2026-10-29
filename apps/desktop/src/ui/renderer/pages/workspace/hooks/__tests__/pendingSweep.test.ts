import { describe, expect, it } from 'vitest';
import { shouldSettlePendingAtTurnEnd, PERSIST_PENDING_ACROSS_TURN, isBackgroundDelegation } from '../pendingSweep';

describe('shouldSettlePendingAtTurnEnd', () => {
  it('没有 pending 标记的条目不碰', () => {
    expect(shouldSettlePendingAtTurnEnd({ type: 'tool_call', pending: false })).toBe(false);
    expect(shouldSettlePendingAtTurnEnd({ type: 'tool_call' })).toBe(false);
  });

  it('白名单内的老类型照常收敛', () => {
    for (const type of [
      'tool_call', 'explore_status', 'agent_delegation',
      'edit_file', 'file_stream', 'assistant_message', 'thinking',
    ]) {
      expect(shouldSettlePendingAtTurnEnd({ type, pending: true })).toBe(true);
    }
  });

  it('原白名单漏掉的类型现在也会被收敛', () => {
    for (const type of [
      'context_compaction', 'added', 'op_chip', 'log',
      'network_task_analysis', 'worker_start', 'timer_card',
    ]) {
      expect(shouldSettlePendingAtTurnEnd({ type, pending: true })).toBe(true);
    }
  });

  it('将来新增的未知类型默认也收敛 —— 安全的那一侧', () => {
    expect(shouldSettlePendingAtTurnEnd({ type: 'some_future_type_2027', pending: true })).toBe(true);
    expect(shouldSettlePendingAtTurnEnd({ type: '', pending: true })).toBe(true);
    expect(shouldSettlePendingAtTurnEnd({ pending: true })).toBe(true);
  });

  it('ask_user 豁免 —— 在等真人回答, 轮结束不代表问题作废', () => {
    expect(shouldSettlePendingAtTurnEnd({ type: 'ask_user', pending: true })).toBe(false);
  });

  it('豁免集合必须保持极小 —— 每加一项都是放弃一类兜底保护', () => {
    expect(PERSIST_PENDING_ACROSS_TURN.size).toBeLessThanOrEqual(3);
    expect([...PERSIST_PENDING_ACROSS_TURN]).toContain('ask_user');
  });
});

describe('后台子 agent 不在轮结束时收敛', () => {
  it('后台派发卡: 轮结束不收', () => {
    expect(shouldSettlePendingAtTurnEnd({
      type: 'agent_delegation', pending: true, delegationIsBackground: true,
    })).toBe(false);
  });

  it('⚠️ 前台派发卡照收 —— 它跟主 agent 同生命周期, 判据是字段不是 type', () => {
    expect(shouldSettlePendingAtTurnEnd({
      type: 'agent_delegation', pending: true, delegationIsBackground: false,
    })).toBe(true);
    /* 字段缺失 (老数据 / 非派发路径) 也按前台算 —— 落在安全那一侧 */
    expect(shouldSettlePendingAtTurnEnd({
      type: 'agent_delegation', pending: true,
    })).toBe(true);
  });

  it('豁免只对 pending 生效, 已收敛的不受影响', () => {
    expect(shouldSettlePendingAtTurnEnd({
      type: 'agent_delegation', pending: false, delegationIsBackground: true,
    })).toBe(false);
  });

  it('isBackgroundDelegation 只认 agent_delegation —— 别的 type 带了这个字段也不算', () => {
    expect(isBackgroundDelegation({ type: 'agent_delegation', delegationIsBackground: true })).toBe(true);
    expect(isBackgroundDelegation({ type: 'explore_status', delegationIsBackground: true })).toBe(false);
    expect(isBackgroundDelegation({ type: 'agent_delegation' })).toBe(false);
    expect(isBackgroundDelegation({})).toBe(false);
  });
});
