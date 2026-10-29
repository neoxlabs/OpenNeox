/** Anthropic 并行 tool_use 的增量参数按事件 index 归位，允许分片交错到达。 */
import { describe, it, expect } from 'vitest';
import { OpenAIProvider } from '../openai.js';

/** 把 SSE 事件序列包成 parseAnthropicStreamResponse 期望的 chunk 流 */
async function* sseStream(events: object[]): AsyncGenerator<Buffer> {
  for (const e of events) {
    yield Buffer.from(`data: ${JSON.stringify(e)}\n\n`);
  }
  yield Buffer.from('data: [DONE]\n\n');
}

/** 两个并行 tool_use 的 delta 交错到达，覆盖按 index 聚合参数的契约。 */
const INTERLEAVED_EVENTS = [
  { type: 'message_start', message: { id: 'msg_1', usage: {} } },
  { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_A', name: 'edit_file' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"ShopProjectServiceImpl.java",' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"new_string":"return buildDySync' } },
  /* ← 第二个工具在这里开始, 而第一个还没写完 */
  { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_B', name: 'read_file' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"ShopProjectDy' } },
  /* ← block0 的剩余分片这时才到 (交错) */
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'ExecuteResult(dto);"}' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'Dto.java"}' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: {} },
];

/** 收集流式 chunk 里的 tool_call 增量, 按 index 还原成完整参数 —— 跟 runner.ts 的聚合同款 */
async function collectToolArgs(chunks: AsyncGenerator<any>): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  for await (const chunk of chunks) {
    for (const tc of chunk?.choices?.[0]?.delta?.tool_calls ?? []) {
      const piece = tc?.function?.arguments;
      if (typeof piece === 'string' && piece) {
        out.set(tc.index, (out.get(tc.index) ?? '') + piece);
      }
    }
  }
  return out;
}

function makeProvider(): any {
  /* 只用它的私有解析器, 不发任何网络请求 */
  return new OpenAIProvider({
    apiKey: 'test-key',
    baseUrl: 'https://example.invalid',
    model: 'test-model',
  } as any);
}

describe('Anthropic 流式 · 并行 tool_use 交错', () => {
  it('每个 tool 的参数各自完整, 不串到别人身上', async () => {
    const provider = makeProvider();
    const args = await collectToolArgs(provider.parseAnthropicStreamResponse(sseStream(INTERLEAVED_EVENTS)));

    expect(args.size).toBe(2);

    /* 两份参数都必须是合法 JSON —— 串味的表现就是这里抛 JSON_PARSE_ERROR */
    const a = args.get(0)!;
    const b = args.get(1)!;
    expect(() => JSON.parse(a), `tool A 参数不是合法 JSON: ${a}`).not.toThrow();
    expect(() => JSON.parse(b), `tool B 参数不是合法 JSON: ${b}`).not.toThrow();

    expect(JSON.parse(a)).toEqual({
      file_path: 'ShopProjectServiceImpl.java',
      new_string: 'return buildDySyncExecuteResult(dto);',
    });
    expect(JSON.parse(b)).toEqual({ path: 'ShopProjectDyDto.java' });
  });

  it('A 的分片绝不能出现在 B 的参数里 (用户实拍的那个形状)', async () => {
    const provider = makeProvider();
    const args = await collectToolArgs(provider.parseAnthropicStreamResponse(sseStream(INTERLEAVED_EVENTS)));
    expect(args.get(1)).not.toContain('ExecuteResult');
    expect(args.get(0)).not.toContain('ShopProjectDy"');
  });

  it('顺序不交错时同样正确 (不能为了修交错而弄坏常规情形)', async () => {
    const sequential = [
      { type: 'message_start', message: { id: 'msg_2', usage: {} } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't_A', name: 'a' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"x":' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '1}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't_B', name: 'b' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"y":2}' } },
      { type: 'content_block_stop', index: 1 },
    ];
    const provider = makeProvider();
    const args = await collectToolArgs(provider.parseAnthropicStreamResponse(sseStream(sequential)));
    expect(JSON.parse(args.get(0)!)).toEqual({ x: 1 });
    expect(JSON.parse(args.get(1)!)).toEqual({ y: 2 });
  });

  it('单个 tool_use 不受影响', async () => {
    const single = [
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't', name: 'only' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"ok":true}' } },
      { type: 'content_block_stop', index: 0 },
    ];
    const provider = makeProvider();
    const args = await collectToolArgs(provider.parseAnthropicStreamResponse(sseStream(single)));
    expect(JSON.parse(args.get(0)!)).toEqual({ ok: true });
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * AnthropicProvider 的 reducer 路径 (chatStreamed 走的就是它 —— 主 agent 循环)
 * 它本来就按 index 归位, 这里钉住"交错不串味", 外加 findToolBlock 兜底的收紧:
 * index 找不到且同时开着多个 tool_use 时, 宁可丢弃也不猜 (猜错会同时毁掉两个调用)。
 * ──────────────────────────────────────────────────────────────────────────── */
describe('AnthropicProvider reducer · 交错与兜底', () => {
  const makeAnthropic = async (): Promise<any> => {
    const { AnthropicProvider } = await import('../anthropic.js');
    return new AnthropicProvider({ apiKey: 'k', baseUrl: 'https://example.invalid', model: 'claude-x' } as any);
  };
  /* 跟 anthropic.ts chatStreamed 里的初始化保持一致 */
  const freshState = (): any => ({
    blocks: new Map(),
    toolCalls: [],
    nextToolIndex: 0,
    roleSent: false,
    usage: null,
    stopReason: null,
    messageStopReceived: false,
  });

  /** 把事件逐条折叠进 state, 收集 yields 里的 tool 参数增量 */
  const reduceAll = (provider: any, state: any, events: object[]): Map<number, string> => {
    const out = new Map<number, string>();
    for (const e of events) {
      const { yields } = provider.reduceAnthropicStreamEvent(e, state);
      for (const chunk of yields ?? []) {
        for (const tc of chunk?.choices?.[0]?.delta?.tool_calls ?? []) {
          const piece = tc?.function?.arguments;
          if (typeof piece === 'string' && piece) out.set(tc.index, (out.get(tc.index) ?? '') + piece);
        }
      }
    }
    return out;
  };

  it('交错到达时各归各位', async () => {
    const provider = await makeAnthropic();
    const args = reduceAll(provider, freshState(), INTERLEAVED_EVENTS);
    expect(JSON.parse(args.get(0)!)).toEqual({
      file_path: 'ShopProjectServiceImpl.java',
      new_string: 'return buildDySyncExecuteResult(dto);',
    });
    expect(JSON.parse(args.get(1)!)).toEqual({ path: 'ShopProjectDyDto.java' });
  });

  it('index 对不上且同时开着两个 tool_use → 丢弃, 不往任何一个身上接', async () => {
    const provider = await makeAnthropic();
    const state = freshState();
    const args = reduceAll(provider, state, [
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'A', name: 'a' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'B', name: 'b' } },
      /* index=7 上没有任何块, 两个 tool_use 都开着 —— 无法确定归属 */
      { type: 'content_block_delta', index: 7, delta: { type: 'input_json_delta', partial_json: '{"orphan":1}' } },
    ]);
    expect(args.get(0)).toBeUndefined();
    expect(args.get(1)).toBeUndefined();
  });

  it('只有一个未关闭 tool_use 时仍然兜底 (无歧义, 不该丢数据)', async () => {
    const provider = await makeAnthropic();
    const args = reduceAll(provider, freshState(), [
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'A', name: 'a' } },
      { type: 'content_block_delta', index: 9, delta: { type: 'input_json_delta', partial_json: '{"ok":1}' } },
    ]);
    expect(JSON.parse(args.get(0)!)).toEqual({ ok: 1 });
  });
});
