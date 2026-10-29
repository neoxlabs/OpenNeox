import { beforeEach, describe, expect, it } from 'vitest';
import {
  _clearAllPendingActionsForTest,
  clearPendingActions,
  getPendingActions,
  recordApprovalNeeded,
  recordAskUserNeeded,
  removeApproval,
  removeAskUser,
  removeAskUserByRequestId,
} from '../pendingActionsRegistry.js';

describe('pendingActionsRegistry', () => {
  beforeEach(() => {
    _clearAllPendingActionsForTest();
  });

  it('snapshots pending approvals and ask_user actions per session', () => {
    recordApprovalNeeded('s1', {
      request_id: 'perm-1',
      tool_name: 'shell',
      args: { command: 'npm test' },
      reason: 'needs exec',
      allow_remember: true,
      turn_id: 't1',
    });
    recordAskUserNeeded('s1', {
      request_id: 'ask-1',
      questions: [{ question: 'Which path?', options: [{ label: 'A' }] }],
      turn_id: 't1',
    });

    expect(getPendingActions('s1')).toEqual({
      approvals: [expect.objectContaining({ request_id: 'perm-1', tool_name: 'shell' })],
      ask_user: [expect.objectContaining({ request_id: 'ask-1' })],
    });
    expect(getPendingActions('s2')).toEqual({ approvals: [], ask_user: [] });
  });

  it('removes individual actions and clears a session', () => {
    recordApprovalNeeded('s1', {
      request_id: 'perm-1',
      tool_name: 'shell',
      args: {},
      reason: '',
      allow_remember: false,
    });
    recordAskUserNeeded('s1', {
      request_id: 'ask-1',
      questions: [],
    });

    removeApproval('s1', 'perm-1');
    removeAskUser('s1', 'ask-1');
    expect(getPendingActions('s1')).toEqual({ approvals: [], ask_user: [] });

    recordApprovalNeeded('s1', {
      request_id: 'perm-2',
      tool_name: 'edit_file',
      args: {},
      reason: '',
      allow_remember: false,
    });
    clearPendingActions('s1');
    expect(getPendingActions('s1')).toEqual({ approvals: [], ask_user: [] });
  });

  it('按 requestId 撤 ask —— 手机重连时不该再看到已答的卡 (2026-09-22)', () => {
    recordAskUserNeeded('s1', { request_id: 'ask-1', questions: [] });
    recordAskUserNeeded('s2', { request_id: 'ask-2', questions: [] });

    removeAskUserByRequestId('ask-1');

    expect(getPendingActions('s1').ask_user).toEqual([]);
    expect(getPendingActions('s2').ask_user).toEqual([
      expect.objectContaining({ request_id: 'ask-2' }),
    ]);
  });

  it('按 requestId 撤 ask: 未知 id / 空 id 不动任何会话', () => {
    recordAskUserNeeded('s1', { request_id: 'ask-1', questions: [] });
    removeAskUserByRequestId('nope');
    removeAskUserByRequestId('');
    expect(getPendingActions('s1').ask_user).toHaveLength(1);
  });
});
