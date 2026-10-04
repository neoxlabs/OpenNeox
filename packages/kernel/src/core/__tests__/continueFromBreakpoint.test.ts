import { describe, expect, it } from 'vitest';
import { StreamedRunner } from '../runner.js';
import { ShortTermMemory } from '../../memory/shortterm.js';

const PARTIAL = '## App vs PC\n\n| 能力 | PC | App |\n| --- | --- | --- |\n| 文本/图/语音 | 有 | 有 |';

function makeRunner(memory: ShortTermMemory, provider: any) {
  return new StreamedRunner({
    llmProvider: provider,
    model: 'test-model',
    tools: [],
    memory,
    config: { maxIterations: 5, temperature: 0 } as any,
    instructions: 'You are a test agent.',
    autoCompressEnabled: false,
    disableSystemPrompt: true,
  });
}

async function drain(gen: AsyncGenerator<any>): Promise<any[]> {
  const out: any[] = [];
  for await (const e of gen) {
    out.push(e);
    if (out.length > 500) throw new Error('runaway event loop');
  }
  return out;
}

describe('① 终态错误也要保住断点', () => {
  it('重试用尽/不可重试收尾前, 半截回答进 memory', async () => {
    const memory = new ShortTermMemory();
    const provider: any = {
      async chat() { throw new Error('chat() not expected'); },
      async *chatStreamed() {
        yield { choices: [{ delta: { content: PARTIAL } }] };
        /* 不可重试的终态错误 (400) —— 直接走到 runner 的收尾分支 */
        const err: any = new Error('Bad request');
        err.response = { status: 400, data: {} };
        throw err;
      },
    };

    const events = await drain(makeRunner(memory, provider).run('写一份对标文档'));
    expect(events.some((e) => e.type === 'error')).toBe(true);

    const msgs = memory.getAll().filter((m: any) => m.role !== 'system');
    const last = msgs[msgs.length - 1];
    expect(last.role).toBe('assistant');
    expect(String(last.content)).toContain('App vs PC');

    /* 错误事件要带上"可以续"这个事实, UI 据此把按钮从"重试"换成"继续" */
    const classified = events.find((e) => e.event_type === 'error.classified');
    expect(classified?.data?.resumable).toBe(true);
    expect(classified?.data?.partialChars).toBeGreaterThan(30);
  });
});

describe('② 续跑那一轮: 不复读用户原话, 请求最后一条就是那半截', () => {
  it.each(['', 'continue', 'old client resubmitted text'])(
    'recovery ignores incoming prompt %j and preserves tool history',
    async prompt => {
      const memory = new ShortTermMemory();
      memory.add({ role: 'user', content: 'original task' });
      memory.add({
        role: 'assistant', content: '',
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      });
      memory.add({ role: 'tool', tool_call_id: 'call-1', content: 'already read' });
      memory.add({ role: 'assistant', content: PARTIAL });
      const before = structuredClone(memory.getAll());
      const requests: any[][] = [];
      const provider: any = {
        async *chatStreamed(messages: any[]) {
          requests.push(structuredClone(messages));
          yield { choices: [{ delta: { content: 'more output' } }] };
          yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
        },
      };
      const runner = makeRunner(memory, provider);
      await drain(runner.run(prompt, undefined, undefined, { continuation: true }));
      await drain(runner.run('', undefined, undefined, { continuation: true }));
      expect(requests).toHaveLength(2);
      for (const sent of requests) {
        expect(sent.filter(m => m.role === 'user')).toEqual([
          expect.objectContaining({ content: 'original task' }),
        ]);
        expect(sent).toContainEqual(expect.objectContaining({
          role: 'tool', tool_call_id: 'call-1', content: 'already read',
        }));
        expect(sent).toContainEqual(expect.objectContaining({ role: 'assistant', content: PARTIAL }));
      }
      expect(memory.getAll().slice(0, before.length)).toEqual(before);
    },
  );

  it('does not append images again, including image-only restored turns', async () => {
    const memory = new ShortTermMemory();
    const image = 'data:image/png;base64,aGVsbG8=';
    memory.add({ role: 'user', content: [{ type: 'image_url', image_url: { url: image } }] });
    memory.add({ role: 'assistant', content: PARTIAL });
    let sent: any[] = [];
    const provider: any = {
      async *chatStreamed(messages: any[]) {
        sent = structuredClone(messages);
        yield { choices: [{ delta: { content: 'continued' } }] };
        yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
      },
    };
    await drain(makeRunner(memory, provider).run('', [image], undefined, { continuation: true }));
    expect(sent.filter(m => m.role === 'user')).toEqual([
      expect.objectContaining({ content: [{ type: 'image_url', image_url: { url: image } }] }),
    ]);
  });

  it('rejects recovery without history instead of inventing a user message', async () => {
    const memory = new ShortTermMemory();
    let called = false;
    const provider: any = { async *chatStreamed() { called = true; } };
    await expect(drain(makeRunner(memory, provider).run(
      'continue', undefined, undefined, { continuation: true },
    ))).rejects.toThrow('no conversation history');
    expect(called).toBe(false);
    expect(memory.getAll().filter(m => m.role === 'user')).toHaveLength(0);
  });

  it('continuation=true → messages 末尾是 assistant partial, user 只有一条', async () => {
    const memory = new ShortTermMemory();
    memory.add({ role: 'user', content: '写一份对标文档' });
    memory.add({ role: 'assistant', content: PARTIAL });

    let sent: any[] = [];
    const provider: any = {
      async chat() { throw new Error('chat() not expected'); },
      async *chatStreamed(messages: any[]) {
        sent = messages;
        yield { choices: [{ delta: { content: '\n| 自定义表情 | 有 | 没有 |' } }] };
        yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
      },
    };

    await drain(makeRunner(memory, provider).run(
      '写一份对标文档', undefined, undefined, { continuation: true },
    ));

    const nonSystem = sent.filter((m) => m.role !== 'system');
    expect(nonSystem.filter((m) => m.role === 'user')).toHaveLength(1);
    const last = nonSystem[nonSystem.length - 1];
    expect(last.role).toBe('assistant');
    expect(String(last.content)).toContain('App vs PC');
  });

  it('不带 continuation (普通新一轮) 时, 用户消息照常入列', async () => {
    const memory = new ShortTermMemory();
    memory.add({ role: 'user', content: '第一个问题' });
    memory.add({ role: 'assistant', content: PARTIAL });

    let sent: any[] = [];
    const provider: any = {
      async chat() { throw new Error('chat() not expected'); },
      async *chatStreamed(messages: any[]) {
        sent = messages;
        yield { choices: [{ delta: { content: '好的' } }] };
        yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
      },
    };

    await drain(makeRunner(memory, provider).run('第二个问题'));
    const nonSystem = sent.filter((m) => m.role !== 'system');
    expect(nonSystem.filter((m) => m.role === 'user')).toHaveLength(2);
    expect(nonSystem[nonSystem.length - 1].role).toBe('user');
  });

  it('自动「继续」: 历史里是「原话+23:09」注入版, 这次是「原话+23:16」→ 不复读 (2026-09-13 真机)', async () => {
    const tag = (hm: string) => `\n\n<current-time>2026-09-13 周日 ${hm}</current-time>`;
    const memory = new ShortTermMemory();
    /* 第一轮开头 runner 已把用户消息原地升级成注入版 —— 历史里存的就是带 23:09 的那份 */
    memory.add({ role: 'user', content: `写一份对标文档${tag('23:09')}` });
    memory.add({ role: 'assistant', content: PARTIAL });

    let sent: any[] = [];
    const provider: any = {
      async chat() { throw new Error('chat() not expected'); },
      async *chatStreamed(messages: any[]) {
        sent = messages;
        yield { choices: [{ delta: { content: '\n| 自定义表情 | 有 | 没有 |' } }] };
        yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
      },
    };

    await drain(makeRunner(memory, provider).run(
      `写一份对标文档${tag('23:16')}`, undefined, undefined, { continuation: true },
    ));

    const nonSystem = sent.filter((m) => m.role !== 'system');
    expect(nonSystem.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(nonSystem[nonSystem.length - 1].role).toBe('assistant');
  });
});
