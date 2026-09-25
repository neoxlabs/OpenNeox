import { describe, it, expect } from 'vitest';
/* 历史 path: '../smartPruner.js'. source 已迁 kernel/utils/compression/.
   走 deep import 保留 test 覆盖 (kernel headTailProtection.test 只测 W5 新增,
   不覆盖本文件的 basic prune scenarios). */
import {
  smartPruneToolOutputs,
  autoSmartPruneIfOverBudget,
  DEFAULT_MIN_PRUNE_TOKENS,
  DEFAULT_PROTECT_TOOLS,
} from '@neoxlabs/kernel/utils/compression/smartPruner.js';
import type { Message } from '@neoxlabs/kernel';

function makeToolMsg(toolName: string, sizeChars: number, id = toolName): Message {
  return {
    role: 'tool',
    content: 'x'.repeat(sizeChars),
    tool_call_id: `call-${id}`,
    name: toolName,
  } as any;
}

function makeAssistant(text: string, toolCalls: any[] = []): Message {
  return {
    role: 'assistant',
    content: text,
    tool_calls: toolCalls.length ? toolCalls : undefined,
  } as any;
}

function makeUser(text: string): Message {
  return { role: 'user', content: text } as any;
}

// 大约 4000 tokens ≈ 16000 chars (len/4 估算)
const BIG_SIZE = 20000; // ≈ 5000 tokens, 满足 minPruneTokens=4000
const SMALL_SIZE = 4000; // ≈ 1000 tokens, 不剪

describe('smartPruneToolOutputs', () => {
  it('empty input → empty result', () => {
    const r = smartPruneToolOutputs({ messages: [], targetSavings: 10000 });
    expect(r.prunedCount).toBe(0);
    expect(r.savedTokens).toBe(0);
    expect(r.messages).toEqual([]);
  });

  it('targetSavings=0 → no prune', () => {
    const msgs = [makeUser('hi'), makeToolMsg('readfile', BIG_SIZE)];
    const r = smartPruneToolOutputs({ messages: msgs, targetSavings: 0 });
    expect(r.prunedCount).toBe(0);
  });

  it('too few assistant turns → all protected, no prune', () => {
    const msgs = [
      makeUser('read file a'),
      makeAssistant('ok', [{}]),
      makeToolMsg('readfile', BIG_SIZE),
    ];
    // 只有 1 个 assistant turn, protectRecentTurns=3 默认, 全部保护
    const r = smartPruneToolOutputs({ messages: msgs, targetSavings: 10000 });
    expect(r.prunedCount).toBe(0);
  });

  it('prunes oldest large tool_result first, respects protectRecentTurns', () => {
    // 4 轮对话, 默认 protectRecentTurns=3 → 只第 1 轮可剪.
    // 测试老 protectRecent-only 语义.
    const msgs: Message[] = [];
    for (let turn = 1; turn <= 4; turn += 1) {
      msgs.push(makeUser(`request ${turn}`));
      msgs.push(makeAssistant(`response ${turn}`, [{ id: `t${turn}` }]));
      msgs.push(makeToolMsg('readfile', BIG_SIZE, `t${turn}`));
    }
    const r = smartPruneToolOutputs({ messages: msgs, targetSavings: 10000, protectHeadTurns: 0 });
    // 第 1 轮的 readfile 应该被剪, 第 2/3/4 轮应保护(最近 3 个 assistant turn)
    expect(r.prunedCount).toBe(1);
    expect(r.prunedTools[0].toolName).toBe('readfile');
    expect(r.prunedTools[0].messageIndex).toBe(2); // turn 1 的 tool 在 index 2
  });

  it('stops after reaching targetSavings', () => {
    // 构造 5 个可剪的 tool_result(5 轮对话,protectRecentTurns=1 只保留最后 1 轮)
    const msgs: Message[] = [];
    for (let turn = 1; turn <= 5; turn += 1) {
      msgs.push(makeUser(`request ${turn}`));
      msgs.push(makeAssistant(`resp ${turn}`, [{ id: `t${turn}` }]));
      msgs.push(makeToolMsg('readfile', BIG_SIZE, `t${turn}`));
    }
    // BIG_SIZE = 20000 chars ≈ 5000 tokens. 目标节省 6000 tokens → 剪 2 条
    const r = smartPruneToolOutputs({
      messages: msgs,
      targetSavings: 6000,
      protectRecentTurns: 1,
    });
    expect(r.prunedCount).toBe(2);
    expect(r.savedTokens).toBeGreaterThanOrEqual(6000);
  });

  it('skips small tool_result below minPruneTokens', () => {
    const msgs = [
      makeUser('q1'),
      makeAssistant('a1', [{ id: 't1' }]),
      makeToolMsg('readfile', SMALL_SIZE, 't1'), // 太小,不剪
      makeUser('q2'),
      makeAssistant('a2', [{ id: 't2' }]),
      makeToolMsg('readfile', BIG_SIZE, 't2'),
      makeUser('q3'),
      makeAssistant('a3'),
      makeUser('q4'),
      makeAssistant('a4'),
      makeUser('q5'),
      makeAssistant('a5'),
    ];
    // 至少 4 个 assistant turn,protectRecentTurns=3 → 第 1 轮可剪
    const r = smartPruneToolOutputs({ messages: msgs, targetSavings: 10000 });
    // 第 1 轮 readfile 太小, 跳过; 第 2 轮的 readfile 可能也被保护区覆盖
    // 这里验证小的不被剪
    const prunedSmall = r.prunedTools.filter((p) => p.originalTokens < DEFAULT_MIN_PRUNE_TOKENS);
    expect(prunedSmall.length).toBe(0);
  });

  it('skips protected tool names (todo_list etc.)', () => {
    const msgs: Message[] = [];
    for (let turn = 1; turn <= 5; turn += 1) {
      msgs.push(makeUser(`q${turn}`));
      msgs.push(makeAssistant(`a${turn}`, [{ id: `t${turn}` }]));
      // 第 1 和第 2 轮的 tool 是受保护的
      const toolName = turn === 1 ? 'todo_list' : turn === 2 ? 'recall' : 'readfile';
      msgs.push(makeToolMsg(toolName, BIG_SIZE, `t${turn}`));
    }
    const r = smartPruneToolOutputs({ messages: msgs, targetSavings: 10000 });
    // 受保护的 todo_list / recall 不该出现在 prunedTools 里
    expect(r.prunedTools.some((p) => p.toolName === 'todo_list')).toBe(false);
    expect(r.prunedTools.some((p) => p.toolName === 'recall')).toBe(false);
  });

  it('replaces pruned tool content with placeholder', () => {
    const msgs: Message[] = [];
    for (let turn = 1; turn <= 5; turn += 1) {
      msgs.push(makeUser(`q${turn}`));
      msgs.push(makeAssistant(`a${turn}`, [{ id: `t${turn}` }]));
      msgs.push(makeToolMsg('readfile', BIG_SIZE, `t${turn}`));
    }
    const r = smartPruneToolOutputs({
      messages: msgs,
      targetSavings: 20000,
      protectRecentTurns: 1,
    });
    expect(r.prunedCount).toBeGreaterThan(0);
    const prunedIdx = r.prunedTools[0].messageIndex;
    const prunedMsg = r.messages[prunedIdx];
    expect(typeof prunedMsg.content).toBe('string');
    expect(prunedMsg.content as string).toContain('[TOOL_OUTPUT_PRUNED]');
    expect(prunedMsg.content as string).toContain('readfile');
    expect(prunedMsg.content as string).toContain('re-invoke');
  });

  it('preserves non-pruned messages unchanged', () => {
    const msgs: Message[] = [];
    for (let turn = 1; turn <= 4; turn += 1) {
      msgs.push(makeUser(`original q${turn}`));
      msgs.push(makeAssistant(`original a${turn}`, [{ id: `t${turn}` }]));
      msgs.push(makeToolMsg('readfile', BIG_SIZE, `t${turn}`));
    }
    const r = smartPruneToolOutputs({ messages: msgs, targetSavings: 10000 });
    // user / assistant 消息内容应保持不变
    for (let i = 0; i < msgs.length; i += 1) {
      if (msgs[i].role === 'user' || msgs[i].role === 'assistant') {
        expect(r.messages[i].content).toBe(msgs[i].content);
      }
    }
  });

  it('custom protectTools overrides default whitelist', () => {
    const msgs: Message[] = [];
    for (let turn = 1; turn <= 5; turn += 1) {
      msgs.push(makeUser(`q${turn}`));
      msgs.push(makeAssistant(`a${turn}`, [{ id: `t${turn}` }]));
      const tool = turn === 1 ? 'my_custom_stateful_tool' : 'readfile';
      msgs.push(makeToolMsg(tool, BIG_SIZE, `t${turn}`));
    }
    const r = smartPruneToolOutputs({
      messages: msgs,
      targetSavings: 10000,
      protectTools: new Set(['my_custom_stateful_tool']),
    });
    expect(r.prunedTools.some((p) => p.toolName === 'my_custom_stateful_tool')).toBe(false);
  });
});

describe('autoSmartPruneIfOverBudget', () => {
  it('returns empty result when under budget', () => {
    const msgs = [makeUser('hi'), makeAssistant('ok')];
    const r = autoSmartPruneIfOverBudget({ messages: msgs, tokenBudget: 100000 });
    expect(r.prunedCount).toBe(0);
  });

  it('auto-targets overage × buffer when over budget', () => {
    const msgs: Message[] = [];
    for (let turn = 1; turn <= 5; turn += 1) {
      msgs.push(makeUser(`q${turn}`));
      msgs.push(makeAssistant(`a${turn}`, [{ id: `t${turn}` }]));
      msgs.push(makeToolMsg('readfile', BIG_SIZE, `t${turn}`));
    }
    // 总 token 约 25000+. 预算 10000 → overage 15000
    const r = autoSmartPruneIfOverBudget({
      messages: msgs,
      tokenBudget: 10000,
      protectRecentTurns: 1,
    });
    expect(r.prunedCount).toBeGreaterThan(0);
    expect(r.savedTokens).toBeGreaterThan(0);
  });
});

describe('default protected tools includes state-carrying tools', () => {
  it('protects todo_list / recall / team_board / memory_read', () => {
    expect(DEFAULT_PROTECT_TOOLS.has('todo_list')).toBe(true);
    expect(DEFAULT_PROTECT_TOOLS.has('recall')).toBe(true);
    expect(DEFAULT_PROTECT_TOOLS.has('read_team_board')).toBe(true);
    expect(DEFAULT_PROTECT_TOOLS.has('memory_read')).toBe(true);
  });

  it('does NOT protect readfile / search / grep / execute_shell (re-runnable)', () => {
    expect(DEFAULT_PROTECT_TOOLS.has('readfile')).toBe(false);
    expect(DEFAULT_PROTECT_TOOLS.has('search')).toBe(false);
    expect(DEFAULT_PROTECT_TOOLS.has('grep')).toBe(false);
    expect(DEFAULT_PROTECT_TOOLS.has('execute_shell')).toBe(false);
  });
});
