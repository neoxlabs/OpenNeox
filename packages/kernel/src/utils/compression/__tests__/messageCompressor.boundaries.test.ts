import { describe, it, expect, vi } from 'vitest';
import { MessageCompressor } from '../messageCompressor.js';
import { ToolCompressor } from '../toolCompressor.js';
import { estimateTokensForMessage, estimateTokensFromMessages } from '../../../compat/memoryPressure.js';
import type { Message } from '../../../types/index.js';

const user = (content: string): Message => ({ role: 'user', content });
const assistant = (content: string): Message => ({ role: 'assistant', content });

function providerReturning(content: string) {
  return { chat: vi.fn(async () => ({ choices: [{ message: { content } }] })) } as any;
}

function providerThrowing(message = 'boom') {
  return { chat: vi.fn(async () => { throw new Error(message); }) } as any;
}

describe('MessageCompressor.compressMessage', () => {
  it('system 消息永不压缩', async () => {
    const c = new MessageCompressor();
    const msg: Message = { role: 'system', content: 'x'.repeat(10000) };
    const r = await c.compressMessage(msg, { llmProvider: providerThrowing() });
    expect(r.strategy).toBe('preserve_system');
    expect(r.message).toBe(msg);
    expect(r.usedLLM).toBe(false);
  });

  it('tool 结果走 ToolCompressor，并按工具名选择策略', async () => {
    const c = new MessageCompressor();
    const msg: Message = { role: 'tool', name: 'Read', content: 'file: a.ts\n' + Array.from({ length: 100 }, (_, i) => `line-${i} ${'x'.repeat(50)}`).join('\n') };
    const r = await c.compressMessage(msg, {});
    expect(r.strategy).toBe('tool_file_read');
    expect(r.message.content.length).toBeLessThan(msg.content.length);
  });

  it('没有 name 的 tool 消息按 unknown 处理，不崩', async () => {
    const c = new MessageCompressor();
    const msg: Message = { role: 'tool', content: 'result' };
    const r = await c.compressMessage(msg, {});
    expect(r.strategy).toBe('tool_other');
    expect(r.message.content).toBe('result');
  });

  it('超过 3000 字符且有 provider 时调用 LLM', async () => {
    const provider = providerReturning('short summary');
    const c = new MessageCompressor();
    const r = await c.compressMessage(user('a'.repeat(4000)), { llmProvider: provider });
    expect(r.usedLLM).toBe(true);
    expect(r.strategy).toBe('llm_content_compression');
    expect(r.message.content).toBe('short summary');
    expect(provider.chat).toHaveBeenCalledTimes(1);
  });

  it('中文长消息使用中文 system prompt，且输入截断到 6000', async () => {
    const provider = providerReturning('摘要');
    const c = new MessageCompressor();
    await c.compressMessage(user('这是一段中文内容。'.repeat(1000)), { llmProvider: provider });
    const [messages] = provider.chat.mock.calls[0] as any[];
    expect(messages[0].content).not.toContain('使用与原对话相同的语言');
    expect(messages[1].content).toContain('[内容过长，已截断]');
    expect(messages[1].content.length).toBeLessThan(6200);
  });

  it('LLM 失败时保留原消息', async () => {
    const c = new MessageCompressor();
    const msg = user('b'.repeat(4000));
    const r = await c.compressMessage(msg, { llmProvider: providerThrowing() });
    expect(r.usedLLM).toBe(false);
    expect(r.strategy).toBe('preserve');
    expect(r.message).toBe(msg);
  });

  it('LLM 返回空内容时保留原消息', async () => {
    const c = new MessageCompressor();
    const msg = user('c'.repeat(4000));
    const r = await c.compressMessage(msg, { llmProvider: providerReturning('') });
    expect(r.strategy).toBe('preserve');
    expect(r.message).toBe(msg);
  });

  it('没有 provider 或关闭 LLM 压缩时不改消息', async () => {
    const c = new MessageCompressor();
    const msg = user('d'.repeat(4000));
    expect((await c.compressMessage(msg, {})).message).toBe(msg);
    expect((await c.compressMessage(msg, { llmProvider: providerReturning('s'), enableLLMCompression: false })).message).toBe(msg);
  });
});

describe('MessageCompressor.compressMessages — 预算内', () => {
  it('预算内不丢消息，只压缩大消息', async () => {
    const c = new MessageCompressor();
    const messages: Message[] = [
      user('short'),
      { role: 'tool', name: 'unknown_tool', content: 'x'.repeat(12000) },
      assistant('short reply'),
    ];
    const r = await c.compressMessages(messages, { tokenBudget: 1_000_000 });
    expect(r.compressedCount).toBe(3);
    expect(r.stats.droppedMessages).toBe(0);
    expect(r.stats.truncatedMessages).toBe(1);
    expect(r.messages[0]).toBe(messages[0]);
    expect((r.messages[1].content as string).length).toBeLessThan(12000);
  });
});

describe('MessageCompressor.compressMessages — 超预算分层', () => {
  const build = (): Message[] => [
    { role: 'system', content: 'sys' },
    ...Array.from({ length: 6 }, (_, i) => user(`old-${i} ` + 'x'.repeat(200))),
    user('error: boom'),
    assistant('recent-a'),
    user('recent-u'),
  ];

  it('永远保留 system 与最近 N 条', async () => {
    const c = new MessageCompressor({ minRecentMessages: 2 });
    const messages = build();
    const critical = messages.filter((_, i) => i === 0 || i >= messages.length - 2);
    const budget = estimateTokensFromMessages(critical);
    const r = await c.compressMessages(messages, { tokenBudget: budget });
    expect(r.messages.map(m => m.content)).toEqual(['sys', 'recent-a', 'recent-u']);
    expect(r.stats.droppedMessages).toBe(7);
    expect(r.compressedTokens).toBeLessThanOrEqual(budget);
  });

  it('预算够时保留错误消息（HIGH 优先级）', async () => {
    const c = new MessageCompressor({ minRecentMessages: 2 });
    const messages = build();
    const critical = messages.filter((_, i) => i === 0 || i >= messages.length - 2);
    const budget = estimateTokensFromMessages(critical) + estimateTokensForMessage(messages[7]);
    const r = await c.compressMessages(messages, { tokenBudget: budget });
    expect(r.messages.map(m => m.content)).toContain('error: boom');
  });

  it('工具调用 / 工具结果（HIGH）预算够时成对保留', async () => {
    const c = new MessageCompressor({ minRecentMessages: 1 });
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'assistant', content: 'calling', tool_calls: [{ id: 't1', type: 'function', function: { name: 'Read', arguments: '{}' } }] } as any,
      { role: 'tool', name: 'Read', content: 'file: a.ts\nbody', tool_call_id: 't1' } as any,
      user('recent'),
    ];
    const critical = [messages[0], messages[3]];
    const budget = estimateTokensFromMessages(critical) + estimateTokensForMessage(messages[1]) + estimateTokensForMessage(messages[2]);
    const r = await c.compressMessages(messages, { tokenBudget: budget });
    const contents = r.messages.map(m => String(m.content));
    expect(contents).toContain('calling');
    expect(contents.some(x => x.includes('body'))).toBe(true);
  });

  it('中低优先级放不下且候选 >= 5 时用 LLM 批量摘要', async () => {
    const provider = providerReturning('SUM');
    const c = new MessageCompressor({ minRecentMessages: 1 });
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      ...Array.from({ length: 8 }, (_, i) => user(`history-${i} ` + 'y'.repeat(100))),
      user('recent'),
    ];
    const critical = [messages[0], messages[messages.length - 1]];
    const budget = estimateTokensFromMessages(critical) + 50;
    const r = await c.compressMessages(messages, { tokenBudget: budget, llmProvider: provider });
    const summary = r.messages.find(m => m.name === 'CompressedHistory');
    expect(summary).toBeTruthy();
    expect(String(summary!.content)).toContain('SUM');
    expect(provider.chat).toHaveBeenCalledTimes(1);
    expect(r.stats.llmCompressedMessages).toBe(1);
  });

  it('批量摘要失败时回退到“保留最近能放下的”', async () => {
    const c = new MessageCompressor({ minRecentMessages: 1 });
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      ...Array.from({ length: 8 }, (_, i) => user(`history-${i} ` + 'y'.repeat(100))),
      user('recent'),
    ];
    const critical = [messages[0], messages[messages.length - 1]];
    const budget = estimateTokensFromMessages(critical) + 10;
    const r = await c.compressMessages(messages, { tokenBudget: budget, llmProvider: providerThrowing() });
    expect(r.messages.map(m => m.content)).toEqual(['sys', 'recent']);
    expect(r.stats.llmCompressedMessages).toBe(0);
  });

  it('开启 debug 时返回调试信息', async () => {
    const c = new MessageCompressor({ debug: true, minRecentMessages: 1 });
    const messages = [
      { role: 'system', content: 'sys' },
      ...Array.from({ length: 6 }, (_, i) => user(`history-${i} ` + 'z'.repeat(100))),
      user('recent'),
    ];
    const r = await c.compressMessages(messages, { tokenBudget: 1 });
    expect(r.debugInfo?.some(line => line.includes('优先级分布'))).toBe(true);
    expect(r.debugInfo?.some(line => line.includes('最终'))).toBe(true);
  });

  it('自定义 minRecentMessages 生效', async () => {
    const c = new MessageCompressor({ minRecentMessages: 3 });
    const messages = [
      ...Array.from({ length: 5 }, (_, i) => user(`u-${i}`)),
    ];
    const r = await c.compressMessages(messages, { tokenBudget: estimateTokensFromMessages(messages.slice(-3)) });
    expect(r.messages.map(m => m.content)).toEqual(['u-2', 'u-3', 'u-4']);
  });

  it('注入自定义 ToolCompressor 时使用它', async () => {
    const toolCompressor = new ToolCompressor();
    const spy = vi.spyOn(toolCompressor, 'compress');
    const c = new MessageCompressor({ toolCompressor });
    await c.compressMessage({ role: 'tool', name: 'Read', content: 'file: a\nx' }, {});
    expect(spy).toHaveBeenCalledWith('Read', 'file: a\nx', {});
  });
});
