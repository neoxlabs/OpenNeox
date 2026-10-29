/**
 * LOOP-03: 同一 noToolReason 只续跑一次。
 *
 *   模型连着两轮踩同一个坑 (同一句提醒已经给过, 它做出的仍是同一类半成品), 再提醒第三次
 *   也改不了, 只是整轮整轮烧钱。第一次照旧续跑, 同一 reason 第二次出现即收尾。
 *   中间真的调过工具 → 计数清零 (不是空转, 长任务不受影响)。
 *
 * LOOP-04: 一批 5 个工具里 1 个失败, 另外 4 个结果仍要回到模型手里。
 */
import { describe, expect, it } from 'vitest';
import { StreamedRunner } from '../runner.js';
import { ShortTermMemory } from '../../memory/shortterm.js';
import type { Tool } from '../../types/index.js';

/** 只开「续跑意图检测」——延续真实 provider profile 的最小形状 */
const PROFILE = {
  id: 'loop-test-profile',
  completion: {
    detectContinuationIntent: true,
    textOnlyCompletionGrace: 1,
  },
} as any;

const SHORT_TEXT = '我接着看看后面的代码。';

const stopChunk = { choices: [{ delta: {}, finish_reason: 'stop' }] };
const textChunk = (content: string) => ({ choices: [{ delta: { content } }] });

function toolCallChunk(id: string, name: string) {
  return {
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id,
          type: 'function',
          function: { name, arguments: '{}' },
        }],
      },
    }],
  };
}

function multiToolCallChunk(calls: Array<{ id: string; name: string }>) {
  return {
    choices: [{
      delta: {
        tool_calls: calls.map((c, index) => ({
          index,
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: '{}' },
        })),
      },
    }],
  };
}

function probeTools(state: { n: number }): Tool[] {
  return [{
    name: 'probe_page',
    description: 'Read the page',
    parameters: { type: 'object', properties: {} },
    parallelSafety: 'safe',
    function: async () => { state.n++; return 'page content'; },
  } as unknown as Tool];
}

function makeRunner(provider: any, sessionId: string, tools: Tool[]) {
  return new StreamedRunner({
    llmProvider: provider,
    model: 'test-model',
    modelProfile: PROFILE,
    tools,
    memory: new ShortTermMemory(),
    config: { maxIterations: 12, temperature: 0 } as any,
    instructions: 'test agent',
    sessionId,
    approvalHandler: async () => true,
    autoCompressEnabled: false,
    disableSystemPrompt: true,
  } as any);
}

async function run(runner: StreamedRunner) {
  const events: any[] = [];
  for await (const ev of runner.run('把设置页改好')) {
    events.push(ev);
    if (events.length > 2000) throw new Error('runaway event loop');
  }
  return {
    events,
    text: events.filter((e) => e.type === 'text_delta').map((e) => e.delta).join(''),
    errors: events.filter((e) => e.type === 'error').map((e) => String(e.error)),
  };
}

describe('LOOP-03 同一 noToolReason 只续跑一次', () => {
  it('连续两轮同一续跑意图 → 只提醒一次, 第二次直接收尾', async () => {
    let calls = 0;
    const seen: any[][] = [];
    const provider = {
      async chat() { throw new Error('chat() not expected'); },
      async *chatStreamed(messages: any[]) {
        seen.push(messages.map((m) => ({ ...m })));
        const turn = calls++;
        if (turn === 0) {
          yield toolCallChunk('call_1', 'probe_page');
          yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }] };
          return;
        }
        /* 没有 finish_reason=stop: 模拟「话说到一半、还打算继续」的短输出 */
        yield textChunk(SHORT_TEXT);
      },
    };
    const runner = makeRunner(provider, 'loop03-repeat', probeTools({ n: 0 }));
    const { text, errors } = await run(runner);

    /* 改前: 同一 reason 会一直续跑到 textOnlyStreak 打到 3 (4 次请求) 才收尾 */
    expect(calls).toBe(3);
    expect(errors).toEqual([]);
    /* 最终回答就是模型第二次说的那句话 (收尾时保留正文) */
    expect(text).toContain(SHORT_TEXT);
    /* 同一句提醒只注入过一次: 第三轮的历史里只剩一份 */
    const reminders = seen[2]!
      .filter((m: any) => typeof m.content === 'string' && m.content.includes('直接调用工具'));
    expect(reminders).toHaveLength(1);
  });

  it('连续空输出 → 也只补一次, 第二次空就收尾 (改前要空到 streak=2 才停)', async () => {
    let calls = 0;
    const provider = {
      async chat() { throw new Error('chat() not expected'); },
      async *chatStreamed() {
        calls++;
        /* 模型把这一轮吞了: 没有任何正文, 也没有工具调用 */
        yield { choices: [{ delta: { content: '' } }] };
      },
    };
    const runner = makeRunner(provider, 'loop03-empty', probeTools({ n: 0 }));
    await run(runner);

    expect(calls).toBe(2);
  });

  it('中间调过工具 → 计数清零, 同一个 reason 之后还能再续跑一次 (长任务不被误杀)', async () => {
    let calls = 0;
    const provider = {
      async chat() { throw new Error('chat() not expected'); },
      async *chatStreamed() {
        const turn = calls++;
        if (turn === 0) {
          yield toolCallChunk('call_a', 'probe_page');
          yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }] };
          return;
        }
        if (turn === 1) { yield textChunk(SHORT_TEXT); return; }
        if (turn === 2) {
          yield toolCallChunk('call_b', 'probe_page');
          yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }] };
          return;
        }
        if (turn === 3) { yield textChunk(SHORT_TEXT); return; }
        yield textChunk('两处都改完了, 测试通过。');
        yield stopChunk;
      },
    };
    const runner = makeRunner(provider, 'loop03-reset', probeTools({ n: 0 }));
    const { text, errors } = await run(runner);

    expect(calls).toBe(5);
    expect(errors).toEqual([]);
    expect(text).toContain('两处都改完了');
  });
});

describe('LOOP-04 批次里 1 个工具失败, 其余结果照常回到模型', () => {
  it('5 个并行工具 1 个抛错: 下一轮历史里 4 条真实结果 + 1 条失败原因', async () => {
    let calls = 0;
    const seen: any[][] = [];
    const provider = {
      async chat() { throw new Error('chat() not expected'); },
      async *chatStreamed(messages: any[]) {
        seen.push(messages.map((m) => ({ ...m })));
        const turn = calls++;
        if (turn === 0) {
          yield multiToolCallChunk([
            { id: 'c1', name: 't1' },
            { id: 'c2', name: 't2' },
            { id: 'c3', name: 't3' },
            { id: 'c4', name: 't4' },
            { id: 'c5', name: 't5' },
          ]);
          yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }] };
          return;
        }
        yield textChunk('四个成功的结果我看到了, 第三个失败了。');
        yield stopChunk;
      },
    };
    const tools: Tool[] = ['t1', 't2', 't3', 't4', 't5'].map((name) => ({
      name,
      description: name,
      parameters: { type: 'object', properties: {} },
      parallelSafety: 'safe',
      function: async () => {
        if (name === 't3') throw new Error('t3 exploded');
        return `result-${name}`;
      },
    } as unknown as Tool));

    const runner = makeRunner(provider, 'loop04-batch', tools);
    const { text, errors } = await run(runner);

    expect(calls).toBe(2);
    expect(errors).toEqual([]);
    expect(text).toContain('四个成功的结果我看到了');

    const secondTurn = seen[1]!;
    const toolMessages = secondTurn.filter((m: any) => m.role === 'tool');
    expect(toolMessages).toHaveLength(5);

    const body = toolMessages.map((m: any) => String(m.content ?? '')).join('\n---\n');
    for (const ok of ['result-t1', 'result-t2', 'result-t4', 'result-t5']) {
      expect(body).toContain(ok);
    }
    expect(body).toContain('t3 exploded');
  });
});
