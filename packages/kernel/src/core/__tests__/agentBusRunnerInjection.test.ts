/**
 * AgentMessageBus × runner 接线测试 (Team P1 §3.4)
 *
 * 覆盖: runner run 开始 registerInbox / 每轮循环顶部 receive 积压消息并以
 *   <agent-message from role> reminder 注入 (走 memory.appendReminder 顺序尾部
 *   追加, 不进顶层 system 块) / 一次性消费 (注入后 inbox 清空) / turn 结束
 *   inbox 保留 (后台成员在父 turn 间隙上报仍可入队)。
 */
import { describe, expect, it, afterEach } from 'vitest';
import { StreamedRunner } from '../runner.js';
import { ShortTermMemory } from '../../memory/shortterm.js';
import { agentMessageBus } from '../agentMessageBus.js';

function makeOneShotProvider() {
  return {
    async chat() {
      throw new Error('chat() not expected in this test');
    },
    async *chatStreamed() {
      yield { choices: [{ delta: { content: 'final answer' } }] };
      yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
    },
  } as any;
}

const SID = 'conductor-bus-test';

afterEach(() => {
  agentMessageBus.unregisterInbox(SID);
});

describe('AgentMessageBus × runner injection', () => {
  it('积压消息在循环顶部以 <agent-message> reminder 注入并清空 inbox', async () => {
    const memory = new ShortTermMemory();
    /* 预注册 + 预投递 — 模拟"上一 turn 间隙成员上报"的积压场景 */
    agentMessageBus.registerInbox(SID);
    agentMessageBus.send({
      fromSessionId: 'agent_Agent-1_123',
      fromAgentName: 'Agent-1',
      toSessionId: SID,
      messageType: 'question',
      payload: '接口签名有两种做法, 选哪种?',
    });
    agentMessageBus.send({
      fromSessionId: 'agent_Agent-2_456',
      fromAgentName: 'Agent-2',
      toSessionId: SID,
      messageType: 'progress',
      payload: '模块 A 已完成',
    });

    const runner = new StreamedRunner({
      llmProvider: makeOneShotProvider(),
      model: 'test-model',
      tools: [],
      memory,
      config: { maxIterations: 3, temperature: 0 } as any,
      instructions: 'test agent',
      sessionId: SID,
      autoCompressEnabled: false,
      disableSystemPrompt: true,
    });

    for await (const _event of runner.run('do the task')) { /* drain */ }

    const allText = memory.getMessagesForLLM().map(m => String(m.content)).join('\n');
    expect(allText).toContain(
      '<agent-message from="Agent-1" role="question">接口签名有两种做法, 选哪种?</agent-message>',
    );
    expect(allText).toContain(
      '<agent-message from="Agent-2" role="progress">模块 A 已完成</agent-message>',
    );
    /* reminder 注入走 appendReminder — 内容被 <system-reminder> 包裹, 且不进 system role */
    expect(allText).toContain('<system-reminder>');
    const systemMsgs = memory.getMessagesForLLM().filter(m => m.role === 'system');
    expect(systemMsgs.some(m => String(m.content).includes('<agent-message'))).toBe(false);

    /* 一次性消费: 注入后 inbox 已清 */
    expect(agentMessageBus.hasMessages(SID)).toBe(false);

    /* turn 结束 inbox 不注销 — 后台成员上报仍可入队 (send 无 inbox 会抛) */
    expect(() => agentMessageBus.send({
      fromSessionId: 'agent_x', fromAgentName: 'x', toSessionId: SID, payload: 'late report',
    })).not.toThrow();
  });

  it('runner run 开始自动注册自己的 inbox (无需外部预注册)', async () => {
    const sid = 'conductor-auto-register';
    expect(() => agentMessageBus.send({
      fromSessionId: 'a', fromAgentName: 'a', toSessionId: sid, payload: 'x',
    })).toThrow(/没有 inbox/);

    const runner = new StreamedRunner({
      llmProvider: makeOneShotProvider(),
      model: 'test-model',
      tools: [],
      memory: new ShortTermMemory(),
      config: { maxIterations: 2, temperature: 0 } as any,
      instructions: 'test agent',
      sessionId: sid,
      autoCompressEnabled: false,
      disableSystemPrompt: true,
    });
    for await (const _e of runner.run('hi')) { /* drain */ }

    /* run 之后 inbox 存在 — 成员可随时上报 */
    expect(() => agentMessageBus.send({
      fromSessionId: 'a', fromAgentName: 'a', toSessionId: sid, payload: 'now deliverable',
    })).not.toThrow();
    agentMessageBus.unregisterInbox(sid);
  });

  it('无 sessionId 的 runner 不消费别人的 inbox', async () => {
    agentMessageBus.registerInbox(SID);
    agentMessageBus.send({
      fromSessionId: 'a', fromAgentName: 'a', toSessionId: SID, payload: 'not for you',
    });

    const memory = new ShortTermMemory();
    const runner = new StreamedRunner({
      llmProvider: makeOneShotProvider(),
      model: 'test-model',
      tools: [],
      memory,
      config: { maxIterations: 2, temperature: 0 } as any,
      instructions: 'test agent',
      autoCompressEnabled: false,
      disableSystemPrompt: true,
    });
    for await (const _e of runner.run('hi')) { /* drain */ }

    expect(agentMessageBus.hasMessages(SID)).toBe(true); // 原样留着
    const allText = memory.getMessagesForLLM().map(m => String(m.content)).join('\n');
    expect(allText).not.toContain('<agent-message');
  });
});
