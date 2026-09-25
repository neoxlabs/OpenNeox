/**
 * 等待态账本回归
 *
 * 这套逻辑决定了"agent 在干活"还是"agent 卡在等你确认"。它的失效方式都是静默的:
 * 状态提前回到 running (用户不知道还有东西等他点) 或者永远卡在 awaiting (轮已经结束
 * 界面还显示在等审批), 所以每条退出路径和并发组合都要钉住。
 */
import { describe, expect, it } from 'vitest';
import { SessionWaitingRegistry } from '../services/sessionWaitingRegistry.js';

const S = 'session-1';

describe('SessionWaitingRegistry', () => {
  it('没有等待项时 status 为 null (调用方据此回 running)', () => {
    const r = new SessionWaitingRegistry();
    expect(r.resolve(S)).toEqual({ status: null, pendingToolCalls: [] });
  });

  it('审批进入 → awaiting_approval, 并带上工具名给端上渲染', () => {
    const r = new SessionWaitingRegistry();
    r.enter(S, 'approval', 'req-1', { toolName: 'delete_file', args: { path: '/tmp/x' } }, 1000);
    const res = r.resolve(S);
    expect(res.status).toBe('awaiting_approval');
    expect(res.pendingToolCalls).toEqual([
      { toolCallId: 'req-1', toolName: 'delete_file', args: { path: '/tmp/x' }, startedAt: 1000 },
    ]);
  });

  it('ask_user 进入 → awaiting_user, 且 pendingToolCalls 为空', () => {
    const r = new SessionWaitingRegistry();
    r.enter(S, 'user', 'ask-1');
    expect(r.resolve(S)).toEqual({ status: 'awaiting_user', pendingToolCalls: [] });
  });

  it('审批优先于 ask_user (审批挡着工具执行, 先让用户看到它)', () => {
    const r = new SessionWaitingRegistry();
    r.enter(S, 'user', 'ask-1');
    r.enter(S, 'approval', 'req-1', { toolName: 'bash' });
    expect(r.resolve(S).status).toBe('awaiting_approval');
    /* 审批清掉后应回落到 ask_user, 而不是直接回 running —— 用户还有问题没答 */
    r.exit(S, 'approval', 'req-1');
    expect(r.resolve(S).status).toBe('awaiting_user');
    r.exit(S, 'user', 'ask-1');
    expect(r.resolve(S).status).toBeNull();
  });

  it('并行审批: 清掉一个不能让状态提前回 running', () => {
    const r = new SessionWaitingRegistry();
    r.enter(S, 'approval', 'req-1', { toolName: 'bash' });
    r.enter(S, 'approval', 'req-2', { toolName: 'write_file' });
    r.exit(S, 'approval', 'req-1');
    const res = r.resolve(S);
    expect(res.status).toBe('awaiting_approval');
    expect(res.pendingToolCalls.map((p) => p.toolName)).toEqual(['write_file']);
  });

  /* 这条是用 Set/Map 而不是计数器的全部理由: 取消与回复、超时与回答都可能同时到达,
   * 计数器会被减穿, 把一个仍然挂着的审批误判成"等完了"。 */
  it('重复 exit 幂等 — 不会把仍挂着的等待项误清掉', () => {
    const r = new SessionWaitingRegistry();
    r.enter(S, 'approval', 'req-1', { toolName: 'bash' });
    r.enter(S, 'approval', 'req-2', { toolName: 'write_file' });
    r.exit(S, 'approval', 'req-1');
    r.exit(S, 'approval', 'req-1');
    r.exit(S, 'approval', 'req-1');
    expect(r.resolve(S).pendingToolCalls.map((p) => p.toolCallId)).toEqual(['req-2']);
  });

  it('exit 不存在的项 / 空参数不抛', () => {
    const r = new SessionWaitingRegistry();
    expect(() => r.exit(S, 'approval', 'nope')).not.toThrow();
    expect(() => r.exit('', 'approval', 'req')).not.toThrow();
    expect(() => r.enter('', 'approval', 'req')).not.toThrow();
    expect(() => r.enter(S, 'approval', '')).not.toThrow();
    expect(r.resolve(S).status).toBeNull();
  });

  it('同 requestId 重复 enter 不重复计数', () => {
    const r = new SessionWaitingRegistry();
    r.enter(S, 'approval', 'req-1', { toolName: 'bash' });
    r.enter(S, 'approval', 'req-1', { toolName: 'bash' });
    expect(r.resolve(S).pendingToolCalls).toHaveLength(1);
    r.exit(S, 'approval', 'req-1');
    expect(r.resolve(S).status).toBeNull();
  });

  it('findSession 按 requestId 反查 (replyAskUser 只有全局 requestId)', () => {
    const r = new SessionWaitingRegistry();
    r.enter('s-a', 'user', 'ask-1');
    r.enter('s-b', 'approval', 'req-9', { toolName: 'bash' });
    expect(r.findSession('user', 'ask-1')).toBe('s-a');
    expect(r.findSession('approval', 'req-9')).toBe('s-b');
    /* kind 必须参与匹配 — 否则 ask 的 id 会命中审批账本 */
    expect(r.findSession('approval', 'ask-1')).toBeNull();
    expect(r.findSession('user', 'nope')).toBeNull();
  });

  it('会话之间互不串账', () => {
    const r = new SessionWaitingRegistry();
    r.enter('s-a', 'approval', 'req-1', { toolName: 'bash' });
    expect(r.resolve('s-b').status).toBeNull();
    r.exit('s-b', 'approval', 'req-1');
    expect(r.resolve('s-a').status).toBe('awaiting_approval');
  });

  /* 一轮可能在还挂着等待项时因异常/abort 收尾。不清账, 下一轮会被上一轮的幽灵审批
   * 钉在 awaiting_approval —— 界面显示"在等你批准"但根本没有待批的东西。 */
  it('clearSession 清干净整条会话的账', () => {
    const r = new SessionWaitingRegistry();
    r.enter(S, 'approval', 'req-1', { toolName: 'bash' });
    r.enter(S, 'user', 'ask-1');
    r.clearSession(S);
    expect(r.resolve(S)).toEqual({ status: null, pendingToolCalls: [] });
    expect(r.findSession('approval', 'req-1')).toBeNull();
  });

  it('缺 toolName 时回落 unknown, 不产生 undefined 字段', () => {
    const r = new SessionWaitingRegistry();
    r.enter(S, 'approval', 'req-1', undefined, 500);
    expect(r.resolve(S).pendingToolCalls[0]).toEqual({
      toolCallId: 'req-1', toolName: 'unknown', args: undefined, startedAt: 500,
    });
  });
});
