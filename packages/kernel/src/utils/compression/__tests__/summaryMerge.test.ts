/**
 * 滚动摘要合并 + 分片 + 缓存 (压缩链升级):
 *   ① 旧 [Compressed Work Record] 不进"永不压"区 — 按类别折叠进本轮各桶重摘要,
 *      任何时刻结果里最多一条 summary (堆积根治)
 *   ② 本轮无新内容的类别: 旧段落原样携带, 不烧 LLM
 *   ③ 摘要缓存: 同内容第二次 summarize 零 LLM 调用 (净增回退后重压不重烧)
 *   ④ 超大桶分片 map-reduce: 多次 LLM 调用, 每片完整注意力
 *   ⑤ isCompactionSummaryMessage 身份判定 (持久化白名单共用)
 */
import { describe, it, expect } from 'vitest';
import {
  LLMSummarizer,
  COMPACTION_SUMMARY_MARKER,
  isCompactionSummaryMessage,
} from '../llmSummarizer.js';

/** 记录每次调用输入、按序回放摘要的 mock provider */
function mockProvider(reply = (n: number) => `SUMMARY-${n}`) {
  const calls: Array<{ system: string; user: string }> = [];
  return {
    calls,
    provider: {
      chat: async (msgs: any[]) => {
        const call = { system: String(msgs[0].content), user: String(msgs[1].content) };
        calls.push(call);
        return { choices: [{ message: { content: reply(calls.length) } }] };
      },
    } as any,
  };
}

function priorSummary(body: string) {
  return {
    role: 'system',
    content: `${COMPACTION_SUMMARY_MARKER} — 20 messages across 2 categories]\n\n${body}`,
  } as any;
}

/** 造一段足够大 (>2000 tok) 的可压缩区: N 条 4K 字符的 tool 消息 + 对话 */
function bigHistory(toolName: string, count = 4, size = 4000): any[] {
  const msgs: any[] = [{ role: 'user', content: '原始任务: 修压缩链' }, { role: 'assistant', content: '开始' }];
  for (let i = 0; i < count; i++) {
    msgs.push({ role: 'assistant', content: '', tool_calls: [{ id: `c${i}`, function: { name: toolName, arguments: '{}' } }] });
    msgs.push({ role: 'tool', name: toolName, tool_call_id: `c${i}`, content: `output-${i} ` + 'x'.repeat(size) });
  }
  msgs.push({ role: 'user', content: '继续' }, { role: 'assistant', content: '好' });
  return msgs;
}

const small = () => new LLMSummarizer({ protectHeadCount: 1, protectRecentCount: 2 });

describe('isCompactionSummaryMessage', () => {
  it('识别 role=system + 标记开头; 其他一律 false', () => {
    expect(isCompactionSummaryMessage(priorSummary('x'))).toBe(true);
    expect(isCompactionSummaryMessage({ role: 'system', content: 'sys prompt' })).toBe(false);
    expect(isCompactionSummaryMessage({ role: 'user', content: `${COMPACTION_SUMMARY_MARKER}]` })).toBe(false);
    expect(isCompactionSummaryMessage({ role: 'system', content: [{ type: 'text', text: 'x' }] })).toBe(false);
    expect(isCompactionSummaryMessage(null)).toBe(false);
  });
});

describe('滚动摘要合并', () => {
  it('旧 summary 折叠进对应桶的 LLM 输入, 结果只有一条 summary', async () => {
    const { provider, calls } = mockProvider();
    const messages = [
      { role: 'system', content: 'sys prompt' },
      priorSummary('### Files\n- /a.ts: 旧文件记录\n\n### Conversation\n## User Goals\n- 旧目标'),
      ...bigHistory('readfile'),
    ];
    const s = small();
    const r = await s.summarize(messages as any, 100_000, provider, 'test-model');

    const summaries = r.messages.filter((m: any) => isCompactionSummaryMessage(m));
    expect(summaries).toHaveLength(1);
    // 旧 summary 原文不再出现 (被折叠), 真 system prompt 保留
    expect(r.messages.filter((m: any) => m.role === 'system')).toHaveLength(2); // prompt + 新 summary
    expect(String(summaries[0].content)).toContain('merged 1 earlier record');

    // files 桶的 LLM 输入里带旧 Files 段 + 合并指令
    const filesCall = calls.find(c => c.user.includes('旧文件记录'));
    expect(filesCall).toBeDefined();
    expect(filesCall!.user).toContain('PRIOR COMPRESSED RECORD');
    expect(filesCall!.user).toContain('output-0'); // 新内容也在同一次调用里
  });

  it('本轮无新内容的类别原样携带, 不为它烧 LLM', async () => {
    const { provider, calls } = mockProvider();
    const messages = [
      priorSummary('### Commands\n- npm test: 旧命令记录 3 pass'),
      // 新内容只有对话, 没有 commands
      { role: 'user', content: '任务' },
      { role: 'assistant', content: '嗯' },
      { role: 'user', content: '聊点别的 ' + 'y'.repeat(9000) },
      { role: 'assistant', content: '好的' },
      { role: 'user', content: '结尾1' },
      { role: 'assistant', content: '结尾2' },
    ];
    const s = small();
    const r = await s.summarize(messages as any, 100_000, provider, 'test-model');

    // 只有 conversation 桶烧了 LLM
    expect(calls).toHaveLength(1);
    const summary = r.messages.find((m: any) => isCompactionSummaryMessage(m));
    expect(String(summary!.content)).toContain('### Commands\n- npm test: 旧命令记录 3 pass');
    expect(String(summary!.content)).toContain('### Conversation\nSUMMARY-1');
  });

  it('无 ### 标题的旧 summary 整体归 conversation 保底不丢', async () => {
    const { provider, calls } = mockProvider();
    const messages = [
      priorSummary('自由格式的旧摘要内容, 没有分节标题'),
      ...bigHistory('execute_shell'),
    ];
    const r = await small().summarize(messages as any, 100_000, provider, 'test-model');
    const convCall = calls.find(c => c.user.includes('自由格式的旧摘要内容'));
    expect(convCall).toBeDefined();
    expect(r.messages.filter((m: any) => isCompactionSummaryMessage(m))).toHaveLength(1);
  });

  it('可压缩量太小时走轻量路径, 旧 summary 原样保留 (仍只有一条)', async () => {
    const failing: any = { chat: () => { throw new Error('不该烧 LLM'); } };
    const messages = [
      { role: 'system', content: 'sys' },
      priorSummary('### Files\n- 旧记录'),
      { role: 'user', content: '嗯 ' + 'z'.repeat(60_000) }, // 超大单条在保护区 → 触发裁剪的轻量路径
      { role: 'assistant', content: '好' },
    ];
    const r = await small().summarize(messages as any, 10_000, failing, 'test-model');
    expect(r.messages.filter((m: any) => isCompactionSummaryMessage(m))).toHaveLength(1);
    expect(r.savedTokens).toBeGreaterThan(0);
  });
});

describe('摘要缓存', () => {
  it('同内容第二次 summarize 零 LLM 调用 (净增回退重压场景)', async () => {
    const { provider, calls } = mockProvider();
    const messages = bigHistory('readfile');
    const s = small();

    const r1 = await s.summarize(messages as any, 100_000, provider, 'test-model');
    const callsAfterFirst = calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const r2 = await s.summarize(messages as any, 100_000, provider, 'test-model');
    expect(calls.length).toBe(callsAfterFirst); // 全命中
    expect(r2.compressedTokens).toBe(r1.compressedTokens);
  });

  it('内容变了不误命中', async () => {
    const { provider, calls } = mockProvider();
    const s = small();
    await s.summarize(bigHistory('readfile') as any, 100_000, provider, 'test-model');
    const n = calls.length;
    await s.summarize(bigHistory('readfile', 4, 4100) as any, 100_000, provider, 'test-model');
    expect(calls.length).toBeGreaterThan(n);
  });
});

describe('超大桶分片 map-reduce', () => {
  it('超过 chunkCharLimit 的桶分成多片, 各片 map 后再 reduce', async () => {
    const { provider, calls } = mockProvider();
    const s = new LLMSummarizer({ protectHeadCount: 1, protectRecentCount: 2, chunkCharLimit: 10_000 });
    // 8 条 4K tool 消息 ≈ 32K 字符 → 4 片 (每片 ~2 条) + 1 次 reduce = 5 次调用
    const messages = bigHistory('readfile', 8, 4000);
    const r = await s.summarize(messages as any, 200_000, provider, 'test-model');

    const filesCalls = calls.filter(c => c.system.includes('file-related'));
    expect(filesCalls.length).toBeGreaterThanOrEqual(4); // ≥3 map + 1 reduce
    const reduceCall = filesCalls[filesCalls.length - 1];
    expect(reduceCall.user).toContain('PARTIAL SUMMARIES');
    expect(r.messages.filter((m: any) => isCompactionSummaryMessage(m))).toHaveLength(1);
  });
});
