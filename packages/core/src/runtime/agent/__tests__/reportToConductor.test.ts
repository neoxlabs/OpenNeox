/**
 * report_to_conductor 工具测试 (Team P1 §3.4)
 *
 * 覆盖: 工具 → agentMessageBus 收发 roundtrip / 三种 kind 直传 messageType /
 *   参数校验与无 inbox 时的软失败 / agentTypes 各类型白名单放行 (再委派仍被禁)。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { agentMessageBus } from '@neoxlabs/kernel';
import { createReportToConductorTool } from '../reportToConductorTool.js';
import { getAvailableAgentTypes, resolveAgentTools } from '../agentTypes.js';

const CONDUCTOR = 'parent-session-rtc';

const makeTool = () => createReportToConductorTool({
  conductorSessionId: CONDUCTOR,
  agentSessionId: 'agent_Agent-1_1',
  agentId: 'Agent-1',
});

describe('report_to_conductor', () => {
  beforeEach(() => {
    agentMessageBus.registerInbox(CONDUCTOR);
  });
  afterEach(() => {
    agentMessageBus.unregisterInbox(CONDUCTOR);
  });

  it('roundtrip: 工具发送 → bus receive 拿到 kind/payload/fromAgentName', async () => {
    const tool = makeTool();
    const out = await tool.function({ kind: 'question', content: '选 A 还是 B?' });
    expect(JSON.parse(out as string).status).toBe('reported');

    const msgs = agentMessageBus.receive(CONDUCTOR);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      fromAgentName: 'Agent-1',
      fromSessionId: 'agent_Agent-1_1',
      toSessionId: CONDUCTOR,
      messageType: 'question',
      payload: '选 A 还是 B?',
    });
  });

  it('progress / blocker 两种 kind 直传为 messageType', async () => {
    const tool = makeTool();
    await tool.function({ kind: 'progress', content: '模块 A 完成 50%' });
    await tool.function({ kind: 'blocker', content: '缺依赖 X, 我的工具装不了' });
    const msgs = agentMessageBus.receive(CONDUCTOR);
    expect(msgs.map(m => m.messageType)).toEqual(['progress', 'blocker']);
  });

  it('非法 kind / 空 content → [ERROR] 且不入队', async () => {
    const tool = makeTool();
    await expect(tool.function({ kind: 'gossip', content: 'x' })).resolves.toMatch(/^\[ERROR\] kind/);
    await expect(tool.function({ kind: 'question', content: '   ' })).resolves.toMatch(/^\[ERROR\] content/);
    expect(agentMessageBus.hasMessages(CONDUCTOR)).toBe(false);
  });

  it('Conductor inbox 不存在 → 软失败返回 [ERROR], 不抛异常', async () => {
    const tool = createReportToConductorTool({
      conductorSessionId: 'ghost-session-never-registered',
      agentSessionId: 'agent_A_1',
      agentId: 'A',
    });
    await expect(tool.function({ kind: 'blocker', content: '卡住了' }))
      .resolves.toMatch(/^\[ERROR\] 上报未送达/);
  });

  it('agentTypes 白名单: 全部子 agent 类型放行 report_to_conductor, 再委派仍被禁', () => {
    const stub = (name: string) => ({
      name,
      description: name,
      parameters: { type: 'object' as const, properties: {} },
      function: async () => 'ok',
    });
    const pool = [stub('report_to_conductor'), stub('readfile'), stub('agent'), stub('explore')];
    const types = getAvailableAgentTypes();
    expect(types.length).toBeGreaterThanOrEqual(6);
    for (const type of types) {
      const resolvedNames = resolveAgentTools(pool as any, type).map(t => t.name);
      expect(resolvedNames, `type=${type.id}`).toContain('report_to_conductor');
      // ALWAYS_EXCLUDED 不动 — 子 agent 依旧不能再委派
      expect(resolvedNames, `type=${type.id}`).not.toContain('agent');
      expect(resolvedNames, `type=${type.id}`).not.toContain('explore');
    }
  });
});
