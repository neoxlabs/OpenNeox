import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StreamedRunner } from '../runner.js';
import { ShortTermMemory } from '../../memory/shortterm.js';
import { CACHED_SUMMARY_PROMPT } from '../cachedSummaryCompaction.js';
import { resetAutoCompactState } from '../autoCompactGuard.js';
import type { Tool } from '../../types/index.js';

const SUMMARY_MARKER = '【工作记录】这是压缩摘要, 不是最终回答';
const FINAL_ANSWER = '全部跑完了: 3 个用例通过。';

/* 摘要要过 isUsableSummary 的 200 token 门槛, 顺便塞进去一句能认出来的标记 */
const SUMMARY_TEXT = `${SUMMARY_MARKER}\n` + '用户目标: 把测试补齐并跑通; 下一步: 运行完整套件第一次。\n'.repeat(120);

/* 每轮工具结果 ~5K token, 两轮就顶到阈值 */
const BIG_RESULT = 'probe output line\n'.repeat(4_000);

function bigTool(): Tool {
  return {
    name: 'probe_big',
    description: 'Return a big chunk of text',
    parameters: { type: 'object', properties: { n: { type: 'number' } } },
    function: async () => BIG_RESULT,
  };
}

function toolCallChunk(i: number) {
  return {
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: `call_${i}`,
          type: 'function',
          /* 每次参数都不同 —— 同参重复会被死循环检测拦下, 压不到阈值就提前收尾 */
          function: { name: 'probe_big', arguments: JSON.stringify({ n: i }) },
        }],
      },
    }],
  };
}

interface ProbeState {
  summaryRequests: number;
  /** 普通对话请求, 按到达顺序记下"摘要请求之后是否还有" */
  turnRequests: number;
  turnRequestsAfterSummary: number;
}

function scriptedProvider(state: ProbeState) {
  return {
    async chat() { throw new Error('chat() not expected'); },
    async *chatStreamed(messages: any[]) {
      const last = messages[messages.length - 1];
      const lastText = typeof last?.content === 'string' ? last.content : '';
      if (lastText === CACHED_SUMMARY_PROMPT) {
        state.summaryRequests++;
        yield { choices: [{ delta: { content: SUMMARY_TEXT } }] };
        yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
        return;
      }
      state.turnRequests++;
      if (state.summaryRequests > 0) state.turnRequestsAfterSummary++;
      /* 前两轮先干活 (发出大结果把上下文顶过阈值), 压缩之后写结论 */
      if (state.summaryRequests === 0) {
        yield toolCallChunk(state.turnRequests);
        yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }] };
        return;
      }
      yield { choices: [{ delta: { content: FINAL_ANSWER } }] };
      yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
    },
  } as any;
}

async function runOnce() {
  const state: ProbeState = { summaryRequests: 0, turnRequests: 0, turnRequestsAfterSummary: 0 };
  const runner = new StreamedRunner({
    llmProvider: scriptedProvider(state),
    model: 'test-model',
    tools: [bigTool()],
    memory: new ShortTermMemory(),
    config: { maxIterations: 20, temperature: 0 } as any,
    instructions: 'test agent',
    sessionId: 'auto-compact-then-continue',
    approvalHandler: async () => true,
    autoCompressEnabled: true,
    disableSystemPrompt: true,
    /* 20K 窗口 + 50% 阈值 → 10K token 就到线, 两轮大工具结果足够 */
    contextWindow: 20_000,
    compressionThreshold: 0.3,
    maxInputTokensOverride: 10_000,
  } as any);

  const memory = (runner as any).memory;
  const events: any[] = [];
  for await (const ev of runner.run('把测试补齐并跑通')) {
    events.push(ev);
    if (events.length > 5000) throw new Error('runaway event loop');
  }
  const text = events
    .filter((e) => e.type === 'text_delta')
    .map((e) => e.delta)
    .join('');
  const compactionCompleted = events.filter(
    (e) => e.type === 'context_compaction' && e.status === 'completed',
  ).length;
  if (process.env.DEBUG_ACTC === '1') {
    console.log('EVENTS', events.map((e) => `${e.type}:${e.status ?? ''}`).join(','));
    console.log('ERRORS', events.filter((e) => e.type === 'error').map((e) => String(e.error ?? e.message)));
    console.log('STATE', JSON.stringify(state));
    console.log('MEMORY', memory.getMessagesForLLM().length, memory.getMessagesForLLM().map((m: any) => (typeof m.content === 'string' ? m.content.length : 0)).reduce((a: number, b: number) => a + b, 0));
  }
  return { state, events, text, compactionCompleted };
}

describe('auto compaction keeps the agent loop running', () => {
  beforeEach(() => {
    resetAutoCompactState();
    delete process.env.NEOX_SPECULATIVE_COMPACT;
  });
  afterEach(() => {
    resetAutoCompactState();
  });

  it('摘要之后还会再调模型, 且摘要不进 text_delta 流', async () => {
    const { state, text, compactionCompleted } = await runOnce();

    /* 前提: 压缩真的发生了 (否则这条用例什么也没验证) */
    expect(state.summaryRequests).toBe(1);
    expect(compactionCompleted).toBe(1);

    /* (a) 压缩后循环继续 */
    expect(state.turnRequestsAfterSummary).toBeGreaterThanOrEqual(1);

    /* (b) 最终回答是模型自己的话, 不是摘要 */
    expect(text).toContain(FINAL_ANSWER);
    expect(text).not.toContain(SUMMARY_MARKER);
  });
});
