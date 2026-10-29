import { describe, it, expect, vi } from 'vitest';

vi.mock('@neoxlabs/kernel/platform/cliLogger.js', () => ({
  cliLogger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

import { createListAgentsTool } from '../listAgentsTool.js';
import { createStopAgentTool } from '../stopAgentTool.js';
import { registerDeepResearch } from '../../../research/activeRuns.js';

type Task = { agentId: string; sessionId: string; description: string; status: string; name?: string };

/** 只实现两个工具真正会碰的方法 */
function fakeManager(tasks: Task[]) {
  const aborted: Array<{ id: string; reason?: string }> = [];
  const mgr: any = {
    listActive: (sid?: string) => tasks
      .filter((t) => t.status === 'running' && (!sid || t.sessionId === sid))
      .map((t) => ({ ...t, elapsed: 12, progress: { toolUseCount: 3 } })),
    resolveAgent: (to: string) => tasks.find((t) => t.agentId === to || t.name === to),
    abort: (id: string, reason?: string) => {
      const t = tasks.find((x) => x.agentId === id);
      if (!t || t.status !== 'running') return false;
      t.status = 'cancelled';
      aborted.push({ id, reason });
      return true;
    },
  };
  return { mgr, aborted };
}

const call = async (tool: any, args: any = {}) => String(await tool.function(args, {}));

describe('list_agents', () => {
  it('前台同步派出去的调研员也列得出来 (就是侧栏上转圈的那些)', async () => {
    const { mgr } = fakeManager([
      { agentId: 'Agent-12', sessionId: 'S', description: '调研: 公告原文', status: 'running' },
      { agentId: 'Agent-13', sessionId: 'S', description: '调研: AI 岗占比', status: 'running' },
      { agentId: 'Agent-9', sessionId: 'OTHER', description: '别的会话的', status: 'running' },
    ]);
    const out = JSON.parse(await call(createListAgentsTool({ callerSessionId: 'S', backgroundManager: mgr })));
    expect(out.agents.map((a: any) => a.agentId)).toEqual(['Agent-12', 'Agent-13']);
  });

  it('本会话有 deep_research 在跑 → 告诉模型怎么整轮停', async () => {
    const { mgr } = fakeManager([]);
    const off = registerDeepResearch('S2', { topic: '上海 PM', startedAt: Date.now(), stop: () => {} });
    try {
      const out = JSON.parse(await call(createListAgentsTool({ callerSessionId: 'S2', backgroundManager: mgr })));
      expect(out.deep_research.topic).toBe('上海 PM');
      expect(out.deep_research.note).toContain('stop_agent');
    } finally { off(); }
  });

  it('真没有才说没有', async () => {
    const { mgr } = fakeManager([]);
    const out = JSON.parse(await call(createListAgentsTool({ callerSessionId: 'S3', backgroundManager: mgr })));
    expect(out.agents).toEqual([]);
  });
});

describe('stop_agent', () => {
  it('按 agentId 停本会话的子 agent, 原因带过去', async () => {
    const { mgr, aborted } = fakeManager([{ agentId: 'Agent-1', sessionId: 'S', description: '调研: x', status: 'running' }]);
    const out = await call(createStopAgentTool({ callerSessionId: 'S', backgroundManager: mgr }), { to: 'Agent-1', reason: '用户说停' });
    expect(out).toContain('已停止 Agent-1');
    expect(aborted).toEqual([{ id: 'Agent-1', reason: '用户说停' }]);
  });

  it('别的会话的 agent 停不了', async () => {
    const { mgr, aborted } = fakeManager([{ agentId: 'Agent-7', sessionId: 'OTHER', description: 'x', status: 'running' }]);
    const out = await call(createStopAgentTool({ callerSessionId: 'S', backgroundManager: mgr }), { to: 'Agent-7' });
    expect(out).toContain('[ERROR]');
    expect(aborted).toEqual([]);
  });

  it('to: "deep_research" → 整轮叫停', async () => {
    const { mgr } = fakeManager([]);
    const stop = vi.fn();
    const off = registerDeepResearch('S4', { topic: 't', startedAt: Date.now(), stop });
    try {
      const out = await call(createStopAgentTool({ callerSessionId: 'S4', backgroundManager: mgr }), { to: 'deep_research', reason: '够了' });
      expect(out).toContain('已叫停 deep_research');
      expect(stop).toHaveBeenCalledWith('够了');
    } finally { off(); }
  });

  it('没有 deep_research 在跑时如实报错', async () => {
    const { mgr } = fakeManager([]);
    expect(await call(createStopAgentTool({ callerSessionId: 'S5', backgroundManager: mgr }), { to: 'deep_research' })).toContain('[ERROR]');
  });
});
