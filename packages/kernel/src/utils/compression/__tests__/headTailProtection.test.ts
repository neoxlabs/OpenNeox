/**
 * W5 轨迹感知压缩 — head/tail 保护测试
 *
 * 覆盖:
 *   - smartPruner: protectHeadTurns 防止首轮 user prompt 被剪
 *   - llmSummarizer.partitionMessages: head + compressible + tail 三段分离
 *   - 组装顺序: system → head → summary → tail
 *   - 边界: 短会话 (head+tail 重叠) 不剪; protectHeadTurns=0 退化到旧行为
 */

import { describe, it, expect } from 'vitest';
import {
  smartPruneToolOutputs,
  DEFAULT_PROTECT_HEAD_TURNS,
} from '../smartPruner.js';
import { LLMSummarizer } from '../llmSummarizer.js';
import type { Message } from '../../../types/index.js';

// ============================================================================
// Helpers
// ============================================================================

function user(text: string): Message {
  return { role: 'user', content: text } as any;
}

function assistant(text: string, toolCalls: any[] = []): Message {
  return {
    role: 'assistant',
    content: text,
    tool_calls: toolCalls.length ? toolCalls : undefined,
  } as any;
}

function toolMsg(toolName: string, sizeChars: number, id = toolName): Message {
  return {
    role: 'tool',
    content: 'x'.repeat(sizeChars),
    tool_call_id: `call-${id}`,
    name: toolName,
  } as any;
}

function systemMsg(text: string): Message {
  return { role: 'system', content: text } as any;
}

/** 4000+ tokens ≈ 16000+ chars, 满足 minPruneTokens=4000 */
const BIG = 20000;

// ============================================================================
// smartPruner — protectHeadTurns
// ============================================================================

describe('smartPruneToolOutputs — protectHeadTurns', () => {
  it('默认 protectHeadTurns=1 保护首条 user 所属 turn', () => {
    /* 5 轮对话: [u0, a0(tool), tool0, u1, a1, tool1, u2, a2, tool2, u3, a3, tool3, u4, a4]
     * 默认 protectRecentTurns=3 保护末 3 assistant turn (a2/a3/a4 起算).
     * 默认 protectHeadTurns=1 保护首轮 (u0+a0+tool0, 直到 u1 之前).
     * 可剪区域: tool1 (i=5).  */
    const msgs: Message[] = [
      user('原始任务: 重构 auth.ts'),         // i=0
      assistant('我先读', [{ id: '1' }]),     // i=1
      toolMsg('readfile', BIG, 'head'),       // i=2 — 首轮 tool, 应被 head 保护
      user('继续'),                            // i=3
      assistant('改', [{ id: '2' }]),         // i=4
      toolMsg('edit', BIG, 'mid'),            // i=5 — 可剪
      user('再改'),                            // i=6
      assistant('改2', [{ id: '3' }]),        // i=7
      toolMsg('edit', BIG, 'tail1'),          // i=8 — 进尾部保护
      user('验证'),                            // i=9
      assistant('跑', [{ id: '4' }]),         // i=10
      toolMsg('execute_shell', BIG, 'tail2'), // i=11
      user('再验证'),                          // i=12
      assistant('done'),                       // i=13
    ];

    const r = smartPruneToolOutputs({
      messages: msgs,
      targetSavings: 100000,  // 极大, 让它能剪多少剪多少
    });

    /* 首轮 tool (head) 不应被剪 */
    expect((r.messages[2] as any).content).toBe('x'.repeat(BIG));
    /* 中间 tool (mid) 应被剪 */
    expect(typeof (r.messages[5] as any).content).toBe('string');
    expect((r.messages[5] as any).content).toContain('TOOL_OUTPUT_PRUNED');
    /* 至少剪 1 个 (mid) */
    expect(r.prunedCount).toBeGreaterThanOrEqual(1);
  });

  it('protectHeadTurns=0 关闭头部保护, 首轮 tool 可被剪', () => {
    const msgs: Message[] = [
      user('原始任务'),
      assistant('动手', [{ id: '1' }]),
      toolMsg('readfile', BIG, 'head'),
      user('next'),
      assistant('改', [{ id: '2' }]),
      toolMsg('edit', BIG, 'mid'),
      user('next2'),
      assistant('改2', [{ id: '3' }]),
      toolMsg('edit', BIG, 'tail1'),
      user('next3'),
      assistant('改3', [{ id: '4' }]),
      toolMsg('edit', BIG, 'tail2'),
      user('next4'),
      assistant('done'),
    ];

    const r = smartPruneToolOutputs({
      messages: msgs,
      targetSavings: 100000,
      protectHeadTurns: 0,
    });

    /* head tool 应被剪 */
    expect((r.messages[2] as any).content).toContain('TOOL_OUTPUT_PRUNED');
  });

  it('protectHeadTurns=2 + protectRecentTurns=3 保护前 2 + 末 3 轮, 中间 turn 3 可剪', () => {
    /* 6 个 turn (才能让 head 2 + tail 3 之间留出 1 个中间 turn 可剪).
     * 索引:  u0(0) a1(1) tool(2)  ← head turn 1
     *        u1(3) a2(4) tool(5)  ← head turn 2
     *        u2(6) a3(7) tool(8)  ← mid turn 3 (可剪)
     *        u3(9) a4(10) tool(11) ← tail turn 4 (protectRecent)
     *        u4(12) a5(13) tool(14)← tail turn 5 (protectRecent)
     *        u5(15) a6(16)         ← tail turn 6 (protectRecent) */
    const msgs: Message[] = [
      user('任务'),
      assistant('A1', [{ id: '1' }]),
      toolMsg('readfile', BIG, 'turn1'),
      user('再来'),
      assistant('A2', [{ id: '2' }]),
      toolMsg('edit', BIG, 'turn2'),
      user('继续'),
      assistant('A3', [{ id: '3' }]),
      toolMsg('edit', BIG, 'turn3-mid'),
      user('再来 2'),
      assistant('A4', [{ id: '4' }]),
      toolMsg('edit', BIG, 'turn4-tail'),
      user('再来 3'),
      assistant('A5', [{ id: '5' }]),
      toolMsg('execute_shell', BIG, 'turn5-tail'),
      user('done'),
      assistant('结束'),
    ];

    const r = smartPruneToolOutputs({
      messages: msgs,
      targetSavings: 100000,
      protectHeadTurns: 2,
    });

    /* turn1 (i=2) + turn2 (i=5) head 保护 */
    expect((r.messages[2] as any).content).toBe('x'.repeat(BIG));
    expect((r.messages[5] as any).content).toBe('x'.repeat(BIG));
    /* turn3-mid (i=8) 可剪 */
    expect((r.messages[8] as any).content).toContain('TOOL_OUTPUT_PRUNED');
    /* turn4-tail (i=11) / turn5-tail (i=14) 由 protectRecentTurns 保护 */
    expect((r.messages[11] as any).content).toBe('x'.repeat(BIG));
    expect((r.messages[14] as any).content).toBe('x'.repeat(BIG));
  });

  it('短会话: head + tail 覆盖所有可剪区域 → 不剪', () => {
    const msgs: Message[] = [
      user('任务'),
      assistant('做', [{ id: '1' }]),
      toolMsg('readfile', BIG),
    ];
    const r = smartPruneToolOutputs({
      messages: msgs,
      targetSavings: 100000,
    });
    expect(r.prunedCount).toBe(0);
  });

  it('DEFAULT_PROTECT_HEAD_TURNS 暴露为 1', () => {
    expect(DEFAULT_PROTECT_HEAD_TURNS).toBe(1);
  });
});

// ============================================================================
// llmSummarizer — partitionMessages head/compressible/tail
// ============================================================================

describe('LLMSummarizer.partitionMessages — head/compressible/tail 三段', () => {
  /* partitionMessages 是 private; 用 (any) 越权访问做单元测试. */
  function partition(messages: Message[], protectHeadCount = 2, protectRecentCount = 3) {
    const s = new LLMSummarizer({ protectHeadCount, protectRecentCount });
    return (s as any).partitionMessages(messages);
  }

  it('系统消息分到 systemMessages, 头部 N 条进 headPreserved', () => {
    const msgs: Message[] = [
      systemMsg('sys-prompt'),
      user('原始任务'),       // head[0]
      assistant('回应'),       // head[1]
      user('m2'),              // compressible[0]
      assistant('a2'),         // compressible[1]
      user('m3'),              // compressible[2]
      assistant('a3'),         // tail[0]
      user('m4'),              // tail[1]
      assistant('a4'),         // tail[2]
    ];
    const p = partition(msgs, 2, 3);

    expect(p.systemMessages).toHaveLength(1);
    expect(p.systemMessages[0].content).toBe('sys-prompt');

    expect(p.headPreserved).toHaveLength(2);
    expect((p.headPreserved[0] as any).content).toBe('原始任务');

    expect(p.tailPreserved).toHaveLength(3);
    expect((p.tailPreserved[0] as any).content).toBe('a3');
  });

  it('protectHeadCount=0 关闭头部保护, headPreserved 为空', () => {
    const msgs: Message[] = [
      user('m0'),
      assistant('a0'),
      user('m1'),
      assistant('a1'),
      user('m2'),
      assistant('a2'),
      user('m3'),
      assistant('a3'),
    ];
    const p = partition(msgs, 0, 3);
    expect(p.headPreserved).toHaveLength(0);
  });

  it('短会话: 尾部已吃掉所有可剪区域, head 也不重复占', () => {
    /* 4 条 non-system, protectRecentCount=3 → safeTailSplitIdx 1 左右
     * protectHeadCount=2 但被 cap 到 1
     * compressible 极少 */
    const msgs: Message[] = [
      user('m0'),
      assistant('a0'),
      user('m1'),
      assistant('a1'),
    ];
    const p = partition(msgs, 2, 3);

    /* head + tail 应当不重叠 */
    const headTexts = p.headPreserved.map((m: any) => m.content);
    const tailTexts = p.tailPreserved.map((m: any) => m.content);
    for (const h of headTexts) {
      expect(tailTexts).not.toContain(h);
    }
  });

  it('headPreserved + compressible + tailPreserved 等于 nonSystem 总数', () => {
    const msgs: Message[] = [
      systemMsg('sys'),
      ...Array.from({ length: 12 }, (_, i) =>
        i % 2 === 0 ? user(`u${i}`) : assistant(`a${i}`)
      ),
    ];
    const p = partition(msgs, 2, 3);
    const total = p.headPreserved.length + p.compressible.length + p.tailPreserved.length;
    expect(total).toBe(12);
  });
});
