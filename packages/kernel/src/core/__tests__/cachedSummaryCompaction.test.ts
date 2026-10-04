/**
 * Compaction by one summary request on the conversation's cached prefix.
 *
 * Found in a CLI trial: the per-category summarizer re-sent a 400K-token history as flattened
 * text in dozens of fresh requests (no cache hits) and took four minutes. The summary request
 * must be the conversation as-is plus one prompt, and the rebuilt history must land near the
 * session's starting size.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ShortTermMemory } from '../../memory/shortterm.js';
import {
  buildSummaryRequest,
  CACHED_SUMMARY_PROMPT,
  hasEnoughToSummarize,
  rebuildAfterSummary,
} from '../cachedSummaryCompaction.js';
import { compressContextWindow } from '../runnerCompressionUtils.js';
import { resetCircuitBreaker, releaseCompactLock } from '../autoCompactGuard.js';
import { COMPACTION_SUMMARY_MARKER } from '../../utils/compression/llmSummarizer.js';
import type { Message } from '../../types/index.js';

const big = (n: number) => 'x'.repeat(n);

function longSession(): Message[] {
  const msgs: Message[] = [
    { role: 'system', content: 'You are Neox.' },
    { role: 'user', content: '做一个进销存系统' },
  ];
  for (let i = 0; i < 30; i++) {
    msgs.push({ role: 'assistant', content: '', tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'readfile', arguments: `{"path":"f${i}.ts"}` } }] } as any);
    msgs.push({ role: 'tool', tool_call_id: `c${i}`, content: big(4000) } as any);
  }
  msgs.push({ role: 'user', content: '再加一个盘点模块' });
  msgs.push({ role: 'assistant', content: '', tool_calls: [{ id: 'last', type: 'function', function: { name: 'readfile', arguments: '{}' } }] } as any);
  msgs.push({ role: 'tool', tool_call_id: 'last', content: big(3000) } as any);
  return msgs;
}

describe('cached-prefix summary compaction', () => {
  beforeEach(() => { releaseCompactLock(); resetCircuitBreaker(); });

  it('the summary request is the conversation unchanged plus one prompt at the end', () => {
    const wire = longSession();
    const req = buildSummaryRequest(wire);
    expect(req.slice(0, wire.length)).toEqual(wire);
    expect(req[req.length - 1]).toEqual({ role: 'user', content: CACHED_SUMMARY_PROMPT });
  });

  it('rebuild keeps the system prefix, the summary and the latest user message — nothing with a tool call', () => {
    const { messages, summarizedCount } = rebuildAfterSummary(longSession(), '## 1. 用户目标\n进销存');
    expect(messages[0]).toEqual({ role: 'system', content: 'You are Neox.' });
    expect(String(messages[1].content).startsWith(COMPACTION_SUMMARY_MARKER)).toBe(true);
    expect(String(messages[1].content)).toContain('进销存');
    expect(messages[2]).toEqual({ role: 'user', content: '再加一个盘点模块' });
    expect(messages).toHaveLength(3);
    expect(messages.some((m: any) => m.tool_calls || m.role === 'tool')).toBe(false);
    expect(summarizedCount).toBe(longSession().length - 2);
  });

  it('an earlier work record is folded into the new summary, not kept beside it', () => {
    const withOld: Message[] = [
      { role: 'system', content: 'You are Neox.' },
      { role: 'system', content: `${COMPACTION_SUMMARY_MARKER} — 10 earlier messages summarized]\n\nold` },
      ...longSession().slice(1),
    ];
    const { messages } = rebuildAfterSummary(withOld, 'new record');
    expect(messages.filter(m => String(m.content).startsWith(COMPACTION_SUMMARY_MARKER))).toHaveLength(1);
    expect(String(messages[1].content)).toContain('new record');
  });

  /* A resumed session: the earlier work record is first and the system prompt was appended
   * behind the history. The second compaction in a trial summarized the prompt away (12.9K
   * context afterwards, less than a fresh session starts with). */
  it('keeps a system prompt that sits behind the history, and puts it first', () => {
    const resumed: Message[] = [
      { role: 'system', content: `${COMPACTION_SUMMARY_MARKER} — 30 earlier messages summarized]\n\nold` },
      { role: 'user', content: '先回答两个问题' },
      ...longSession().slice(2),
      { role: 'system', content: 'You are Neox. (prompt re-added on resume)' },
    ];
    const { messages } = rebuildAfterSummary(resumed, 'new record');
    expect(messages[0]).toEqual({ role: 'system', content: 'You are Neox. (prompt re-added on resume)' });
    expect(String(messages[1].content)).toContain('new record');
    expect(messages.filter(m => m.role === 'system')).toHaveLength(2);
  });

  it('does not start on a history too small to summarize', () => {
    expect(hasEnoughToSummarize([{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }])).toBe(false);
    expect(hasEnoughToSummarize(longSession())).toBe(true);
  });

  it('compressContextWindow uses the cached-prefix summary and lands near the starting size', async () => {
    const memory = new ShortTermMemory();
    for (const m of longSession()) memory.add(m);
    let calls = 0;
    const result = await compressContextWindow({
      maxInputTokens: 50_000,
      contextWindow: 60_000,
      iteration: 1,
      memory,
      unifiedCompressor: {} as any,   // must not be touched on this path
      compressionMode: 'sync',
      trigger: 'auto',
      overrideRatio: 0.1,
      logInfo: () => {},
      logDebug: () => {},
      summarizeOnCachedPrefix: async () => { calls++; return '## 1. 用户目标\n进销存系统\n'.repeat(40); },
    });
    expect(calls).toBe(1);
    expect(result).not.toBeNull();
    expect(result!.compressedTokens).toBeLessThan(result!.originalTokens / 10);
    const after = memory.getMessagesForLLM();
    expect(after.some((m: any) => m.role === 'tool')).toBe(false);
    expect(after.find(m => m.role === 'user')?.content).toBe('再加一个盘点模块');
  });

  it('a failed summary request throws instead of passing for "no gain"', async () => {
    const memory = new ShortTermMemory();
    for (const m of longSession()) memory.add(m);
    await expect(compressContextWindow({
      maxInputTokens: 50_000, contextWindow: 60_000, iteration: 1, memory,
      unifiedCompressor: {} as any, compressionMode: 'sync', trigger: 'auto', overrideRatio: 0.1,
      logInfo: () => {}, logDebug: () => {},
      summarizeOnCachedPrefix: async () => { throw new Error('ECONNRESET'); },
    })).rejects.toThrow('ECONNRESET');
    expect(memory.getMessagesForLLM().length).toBe(longSession().length);
  });
});
