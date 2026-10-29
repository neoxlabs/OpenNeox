import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ingestSubAgentEvent, refreshSubAgents, sessionsWithRunningSubAgents,
  _resetSubAgentsStoreForTest,
} from '../subAgentsStore';

let serverList: any[] = [];

beforeEach(() => {
  _resetSubAgentsStoreForTest();
  vi.useFakeTimers();
  serverList = [];
  (globalThis as any).window = { neox: { listSubAgents: async () => serverList } };
});
afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as any).window;
});

const started = (sid: string, agentId: string) =>
  ingestSubAgentEvent(sid, { action: 'started', agentId, description: `调研: ${agentId}` });

describe('refreshSubAgents 以服务端为准', () => {
  it('本地 running 但服务端已经没有 → 不再算在跑 (漏了结束事件也能自愈)', async () => {
    started('P', 'Agent-12');
    started('P', 'Agent-13');
    expect(sessionsWithRunningSubAgents()).toEqual(['P']);

    serverList = [];   // 服务端: 一个都没在跑
    await refreshSubAgents('P');

    expect(sessionsWithRunningSubAgents()).toEqual([]);
    /* 走 fade, 过了淡出期整条摘掉 */
    vi.advanceTimersByTime(20_000);
    expect(sessionsWithRunningSubAgents()).toEqual([]);
  });

  it('服务端还在跑的保持 running, 只收掉已经没了的', async () => {
    started('P', 'Agent-1');
    started('P', 'Agent-2');
    serverList = [{ agentId: 'Agent-2', description: 'x', status: 'running', elapsed: 5 }];
    await refreshSubAgents('P');
    expect(sessionsWithRunningSubAgents()).toEqual(['P']);
  });

  it('只看本会话的快照, 不误伤别的会话', async () => {
    started('P', 'Agent-1');
    started('Q', 'Agent-9');
    serverList = [];
    await refreshSubAgents('P');
    expect(sessionsWithRunningSubAgents()).toEqual(['Q']);
  });
});
