import { describe, it, expect } from 'vitest';
import { enforceToolPairs } from '../toolPairGuard.js';

const assistantWithCalls = (ids: string[], name = 'read_file') => ({
  role: 'assistant',
  content: '',
  tool_calls: ids.map((id) => ({ id, type: 'function', function: { name, arguments: '{}' } })),
});
const toolResult = (id: string, content = 'ok') => ({ role: 'tool', content, tool_call_id: id });

describe('enforceToolPairs', () => {
  it('配对完整时原样返回 (同一个数组引用, 热路径零拷贝)', () => {
    const msgs = [
      { role: 'user', content: 'hi' },
      assistantWithCalls(['c1']),
      toolResult('c1'),
      { role: 'assistant', content: '好了' },
    ];
    const r = enforceToolPairs(msgs);
    expect(r.repaired).toBe(false);
    expect(r.messages).toBe(msgs);
  });

  it('纯对话 (完全没有工具) 走快速路径', () => {
    const msgs = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    const r = enforceToolPairs(msgs);
    expect(r.repaired).toBe(false);
    expect(r.messages).toBe(msgs);
  });

  it('缺 tool result → 紧跟 assistant 后面补占位, 且不删 tool_calls', () => {
    const msgs = [
      { role: 'user', content: '读文件' },
      assistantWithCalls(['c1']),
      { role: 'user', content: '还在吗' },
    ];
    const r = enforceToolPairs(msgs);
    expect(r.repaired).toBe(true);
    expect(r.stats.filledMissing).toBe(1);
    /* 占位必须紧挨在 assistant 之后, 不能落到末尾 */
    expect(r.messages[1].role).toBe('assistant');
    expect(r.messages[1].tool_calls).toHaveLength(1);
    expect(r.messages[2].role).toBe('tool');
    expect(r.messages[2].tool_call_id).toBe('c1');
    expect(String(r.messages[2].content)).toContain('TOOL_RESULT_MISSING');
    expect(r.messages[3].content).toBe('还在吗');
  });

  it('一条 assistant 多个 tool_calls 只缺一个 — 只补缺的那个', () => {
    const msgs = [
      assistantWithCalls(['c1', 'c2']),
      toolResult('c2'),
    ];
    const r = enforceToolPairs(msgs);
    expect(r.stats.filledMissing).toBe(1);
    const toolMsgs = r.messages.filter((m: any) => m.role === 'tool');
    expect(toolMsgs.map((m: any) => m.tool_call_id).sort()).toEqual(['c1', 'c2']);
    /* 已有的真实结果不能被占位覆盖 */
    expect(toolMsgs.find((m: any) => m.tool_call_id === 'c2')!.content).toBe('ok');
  });

  it('孤儿 tool 消息 (前面没有对应 tool_calls) 被删掉', () => {
    const msgs = [
      { role: 'user', content: 'hi' },
      toolResult('ghost'),
      { role: 'assistant', content: '继续' },
    ];
    const r = enforceToolPairs(msgs);
    expect(r.repaired).toBe(true);
    expect(r.stats.droppedOrphans).toBe(1);
    expect(r.messages.some((m: any) => m.role === 'tool')).toBe(false);
    expect(r.messages).toHaveLength(2);
  });

  it('同时有缺失和孤儿 — 两边都处理', () => {
    const msgs = [
      assistantWithCalls(['c1']),
      toolResult('ghost'),
    ];
    const r = enforceToolPairs(msgs);
    expect(r.stats.filledMissing).toBe(1);
    expect(r.stats.droppedOrphans).toBe(1);
    const toolMsgs = r.messages.filter((m: any) => m.role === 'tool');
    expect(toolMsgs).toHaveLength(1);
    expect(toolMsgs[0].tool_call_id).toBe('c1');
  });

  it('幂等 — 修过一遍的结果再跑不会重复补', () => {
    const msgs = [assistantWithCalls(['c1'])];
    const once = enforceToolPairs(msgs);
    const twice = enforceToolPairs(once.messages);
    expect(twice.repaired).toBe(false);
    expect(twice.messages).toBe(once.messages);
  });

  it('多轮混合: 每个断掉的 turn 各补各的', () => {
    const msgs = [
      assistantWithCalls(['a1']),          // 断了
      { role: 'user', content: '再试' },
      assistantWithCalls(['b1']),
      toolResult('b1'),                     // 正常
      { role: 'assistant', content: '完成' },
      assistantWithCalls(['c1']),          // 又断了
    ];
    const r = enforceToolPairs(msgs);
    expect(r.stats.filledMissing).toBe(2);
    /* 每条占位都紧跟自己的 assistant */
    const idx = (id: string) => r.messages.findIndex((m: any) => m.tool_call_id === id);
    expect(idx('a1')).toBe(1);
    expect(r.messages[idx('c1') - 1].tool_calls?.[0]?.id).toBe('c1');
  });

  it('流式落库残片: 同一批 id 先分片再完整落库 → 删残片, 保留完整那条 (真机 payload 形状)', () => {
    const msgs = [
      { role: 'user', content: '派三个 agent' },
      assistantWithCalls(['A']),
      assistantWithCalls(['B']),
      assistantWithCalls(['A', 'B']),
      toolResult('A'),
      toolResult('B'),
      { role: 'assistant', content: '汇总如下' },
    ];
    const r = enforceToolPairs(msgs);
    expect(r.repaired).toBe(true);
    /* 两条残片被删, 不能补占位 (那会让模型以为工具真的失败了) */
    expect(r.stats.filledMissing).toBe(0);
    expect(r.stats.droppedOrphans).toBe(2);
    const withCalls = r.messages.filter((m: any) => m.role === 'assistant' && m.tool_calls?.length);
    expect(withCalls).toHaveLength(1);
    expect(withCalls[0].tool_calls.map((tc: any) => tc.id)).toEqual(['A', 'B']);
    /* 完整那条后面仍然紧跟它的两条结果 */
    const idx = r.messages.indexOf(withCalls[0]);
    expect(r.messages[idx + 1].tool_call_id).toBe('A');
    expect(r.messages[idx + 2].tool_call_id).toBe('B');
  });

  it('残片带正文时保住正文, 只剥 tool_calls', () => {
    const frag = { ...assistantWithCalls(['A']), content: '我先看一下后端' };
    const msgs = [frag, assistantWithCalls(['A']), toolResult('A')];
    const r = enforceToolPairs(msgs);
    expect(r.messages[0].content).toBe('我先看一下后端');
    expect(r.messages[0].tool_calls).toBeUndefined();
  });

  it('一条消息里既有残片 id 又有真缺失 id — 剥前者、补后者', () => {
    const msgs = [
      assistantWithCalls(['A', 'GONE']),
      assistantWithCalls(['A']),
      toolResult('A'),
    ];
    const r = enforceToolPairs(msgs);
    /* 第一条: A 是残片被剥, GONE 全历史没结果 → 保留 + 补占位 */
    expect(r.messages[0].tool_calls.map((tc: any) => tc.id)).toEqual(['GONE']);
    expect(r.messages[1].role).toBe('tool');
    expect(r.messages[1].tool_call_id).toBe('GONE');
    expect(r.stats.filledMissing).toBe(1);
  });

  it('中间隔了别的 role 就不算相邻 — 结果在别处会被判成残片', () => {
    const msgs = [
      assistantWithCalls(['A']),
      { role: 'user', content: '插一句' },
      assistantWithCalls(['A']),
      toolResult('A'),
    ];
    const r = enforceToolPairs(msgs);
    const withCalls = r.messages.filter((m: any) => m.role === 'assistant' && m.tool_calls?.length);
    expect(withCalls).toHaveLength(1);
  });

  it('并行调用里读图: 图片附件夹在 tool 结果中间 → 挪到整批结果之后, 不剥任何调用 (2026-09-18 真机形状)', () => {
    const img = { role: 'user', content: [{ type: 'text', text: '[系统注入] 图片' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] };
    const msgs = [
      { role: 'user', content: '测测读取能力' },
      assistantWithCalls(['A', 'B', 'C']),
      toolResult('A', '[readfile 返回了 1 张图片]'),
      img,
      toolResult('B'),
      toolResult('C'),
      { role: 'assistant', content: '图里是…' },
    ];
    const r = enforceToolPairs(msgs);
    expect(r.repaired).toBe(true);
    expect(r.stats).toEqual({ filledMissing: 0, droppedOrphans: 0, strippedStale: 0, displaced: 1 });
    expect(r.messages.map((m: any) => m.tool_call_id ?? m.role)).toEqual(
      ['user', 'assistant', 'A', 'B', 'C', 'user', 'assistant'],
    );
    expect(r.messages[1].tool_calls).toHaveLength(3);
    expect(r.messages[5]).toBe(img);
    /* 修过的再跑一遍不再动 */
    expect(enforceToolPairs(r.messages).repaired).toBe(false);
  });

  it('夹心之后才到的用户新消息留在原位, 不跨 turn 搬', () => {
    const msgs = [
      assistantWithCalls(['A', 'B']),
      toolResult('A'),
      { role: 'user', content: '附件' },
      toolResult('B'),
      { role: 'user', content: '下一句' },
    ];
    const r = enforceToolPairs(msgs);
    expect(r.messages.map((m: any) => m.tool_call_id ?? m.content)).toEqual(['', 'A', 'B', '附件', '下一句']);
  });

  it('只剥残片 id (没补占位, 条数不变) 也要真的生效', () => {
    const msgs = [
      assistantWithCalls(['A', 'B']),
      toolResult('B'),
      assistantWithCalls(['A']),
      toolResult('A'),
    ];
    const r = enforceToolPairs(msgs);
    expect(r.repaired).toBe(true);
    expect(r.stats.strippedStale).toBe(1);
    expect(r.messages[0].tool_calls.map((tc: any) => tc.id)).toEqual(['B']);
  });

  it('畸形数据不炸: tool_calls 里没有 id / tool 消息没有 tool_call_id', () => {
    const msgs = [
      { role: 'assistant', content: '', tool_calls: [{ type: 'function', function: { name: 'x' } }] },
      { role: 'tool', content: 'orphan-without-id' },
      { role: 'user', content: 'hi' },
    ];
    expect(() => enforceToolPairs(msgs)).not.toThrow();
    const r = enforceToolPairs(msgs);
    /* 没 id 的既不算缺失也不算孤儿 — 原样透传, 不自作主张删 */
    expect(r.repaired).toBe(false);
  });
});
