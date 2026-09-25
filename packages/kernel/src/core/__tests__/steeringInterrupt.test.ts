import { describe, expect, it } from 'vitest';
import { StreamedRunner } from '../runner.js';
import { ShortTermMemory } from '../../memory/shortterm.js';

function makeSteeringProvider() {
  const state = { calls: 0 };
  const provider: any = {
    state,
    async chat() {
      throw new Error('chat() not expected in this test');
    },
    async *chatStreamed(_messages: any[], options: any) {
      state.calls++;
      if (state.calls === 1) {
        yield { choices: [{ delta: { content: 'partial answer before interrupt' } }] };
        await new Promise((_resolve, reject) => {
          const signal: AbortSignal | undefined = options?.signal;
          const abortErr = () => {
            const e: any = new Error('Request was aborted');
            e.name = 'AbortError';
            reject(e);
          };
          if (!signal) return; // 没 signal 就永远挂起, 测试超时会暴露问题
          if (signal.aborted) return abortErr();
          signal.addEventListener('abort', abortErr, { once: true });
        });
      } else {
        yield { choices: [{ delta: { content: 'steered final answer' } }] };
        yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
      }
    },
  };
  return provider;
}

describe('mid-stream steering interrupt', () => {
  it('aborts current stream, keeps partial, and continues to next iteration', async () => {
    const memory = new ShortTermMemory();
    const provider = makeSteeringProvider();
    const runner = new StreamedRunner({
      llmProvider: provider,
      model: 'test-model',
      tools: [],
      memory,
      config: { maxIterations: 5, temperature: 0 } as any,
      instructions: 'You are a test agent.',
      autoCompressEnabled: false,
      disableSystemPrompt: true,
    });

    const events: any[] = [];
    let steered = false;
    for await (const event of runner.run('do something')) {
      events.push(event);
      if (!steered && event.type === 'text_delta') {
        steered = runner.requestSteeringInterrupt();
        // 模拟 host: 打断后把插话写进 memory (真实路径是 processPendingInjectedMessages)
        memory.add({ role: 'user', content: 'actually, do something else' });
      }
      if (events.length > 500) throw new Error('runaway event loop');
    }

    expect(steered).toBe(true);
    expect(provider.state.calls).toBe(2);

    // 不能以"用户取消"收尾
    const interrupted = events.find(
      (e) => e.type === 'error' && String(e.error).includes('interrupted'),
    );
    expect(interrupted).toBeUndefined();

    // partial 带中断标记存入 memory, 且后面跟着插话
    const messages = memory.getMessagesForLLM();
    const partialIdx = messages.findIndex(
      (m) => m.role === 'assistant' && String(m.content).includes('[response interrupted'),
    );
    expect(partialIdx).toBeGreaterThanOrEqual(0);
    expect(String(messages[partialIdx].content)).toContain('partial answer before interrupt');

    // 第二条流的最终回答正常产出
    const finalText = events
      .filter((e) => e.type === 'text_delta')
      .map((e) => e.delta)
      .join('');
    expect(finalText).toContain('steered final answer');
  });

  it('returns false when no stream is active', () => {
    const runner = new StreamedRunner({
      llmProvider: makeSteeringProvider(),
      model: 'test-model',
      tools: [],
      memory: new ShortTermMemory(),
      config: { maxIterations: 2, temperature: 0 } as any,
      instructions: 'test',
    });
    expect(runner.requestSteeringInterrupt()).toBe(false);
  });
});

describe('steering interrupt during tool phase', () => {
  it('aborts the tool-phase signal and reports true', async () => {
    const runner = new StreamedRunner({
      llmProvider: makeSteeringProvider(),
      model: 'test-model',
      tools: [],
      memory: new ShortTermMemory(),
      config: { maxIterations: 2, temperature: 0 } as any,
      instructions: 'test',
    });

    const toolAbort = new AbortController();
    (runner as any).activeToolSteeringAbort = toolAbort;

    expect(runner.requestSteeringInterrupt()).toBe(true);
    await new Promise((r) => setTimeout(r, 1000));
    expect(toolAbort.signal.aborted).toBe(false);
    await new Promise((r) => setTimeout(r, 5000));
    expect(toolAbort.signal.aborted).toBe(true);

    // 已经掐过 → 再请求没有活目标, 不能再报 true (否则 UI 会以为又插了一次)
    expect(runner.requestSteeringInterrupt()).toBe(false);
  });
});
