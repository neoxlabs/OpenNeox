/**
 * LOOP-17 的端到端约束：压缩产物里**一定**有改动清单，且滚动压缩时旧清单不丢、
 * 也不会被当成对话内容再喂给摘要模型。
 */
import { describe, it, expect } from 'vitest';
import { LLMSummarizer, COMPACTION_SUMMARY_MARKER } from '../llmSummarizer.js';

function mockProvider() {
  const calls: Array<{ system: string; user: string }> = [];
  return {
    calls,
    provider: {
      chat: async (msgs: any[]) => {
        calls.push({ system: String(msgs[0].content), user: String(msgs[1].content) });
        return { choices: [{ message: { content: `SUMMARY-${calls.length}` } }] };
      },
    } as any,
  };
}

function editCall(id: string, name: string, args: Record<string, any>) {
  return { role: 'assistant', content: '', tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }] };
}

/** 足够大（>2000 token）的可压缩区，里面带两次真实的 mutation。 */
function history(): any[] {
  const big = (i: number) => `output-${i} ` + 'x'.repeat(4000);
  return [
    { role: 'user', content: '原始任务: 重构压缩链' },
    { role: 'assistant', content: '开始' },
    editCall('m1', 'edit_file', { file_path: 'src/a.ts', hunks: [{}, {}] }),
    { role: 'tool', name: 'edit_file', tool_call_id: 'm1', content: big(1) },
    editCall('m2', 'write_file', { file_path: 'src/b.ts', content: 'new content' }),
    { role: 'tool', name: 'write_file', tool_call_id: 'm2', content: big(2) },
    { role: 'tool', name: 'readfile', tool_call_id: 'r1', content: big(3) },
    { role: 'tool', name: 'execute_shell', tool_call_id: 'r2', content: big(4) },
    { role: 'user', content: '继续' },
    { role: 'assistant', content: '好' },
  ];
}

const summarizer = () => new LLMSummarizer({ protectHeadCount: 1, protectRecentCount: 2 });

describe('压缩摘要固定含改动清单', () => {
  it('摘要里出现每个已改文件的一行说明', async () => {
    const { provider } = mockProvider();
    const r = await summarizer().summarize(history(), 100_000, provider, 'test-model');
    const summary = r.messages.find((m: any) => m.role === 'system' && String(m.content).startsWith(COMPACTION_SUMMARY_MARKER));
    expect(summary).toBeDefined();
    const text = String(summary!.content);
    expect(text).toContain('### Changed Files');
    expect(text).toContain('- `src/a.ts` — 修改 2 处（1 次编辑）');
    expect(text).toContain('- `src/b.ts` — 写入 1 次（最后一次 11 字符）');
  });

  it('滚动压缩：旧清单被携带，且不再喂给对话桶', async () => {
    const { provider, calls } = mockProvider();
    const prior = {
      role: 'system',
      content: `${COMPACTION_SUMMARY_MARKER} — 9 messages across 1 categories]\n\n### Conversation\n- 旧目标\n\n### Changed Files\n- \`src/old.ts\` — 已删除`,
    };
    const messages = [prior, ...history()];
    const r = await summarizer().summarize(messages as any, 100_000, provider, 'test-model');

    const summary = r.messages.find((m: any) => m.role === 'system' && String(m.content).startsWith(COMPACTION_SUMMARY_MARKER));
    const text = String(summary!.content);
    expect(text).toContain('`src/old.ts` — 已删除');
    expect(text).toContain('`src/a.ts`');

    /* 旧清单不能被当成 conversation 内容重摘要 */
    expect(calls.some((c) => c.user.includes('src/old.ts'))).toBe(false);
  });
});
