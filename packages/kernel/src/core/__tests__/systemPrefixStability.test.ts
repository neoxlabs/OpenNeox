/**
 * PROMPT-07 · 同一个 runner 连续多轮, system 段字节必须不变
 *
 * 这里跑真 runner (不是只测助手函数): 第一轮建 system, 之后每轮过一遍
 * dynamicSystemPromptProvider。以前首轮把段拼进整段 system, 次轮又 upsert 一条,
 * 于是第二轮 system 里同一段出现两次 —— 本用例对旧代码会直接红。
 */
import { describe, it, expect } from 'vitest';
import { StreamedRunner } from '../runner.js';
import { ShortTermMemory } from '../../memory/shortterm.js';

const SECTION = '<model_orchestration>\n智能模型编排已开启\n</model_orchestration>';

function textProvider() {
  return {
    async chat() { throw new Error('chat() not expected'); },
    async *chatStreamed() {
      yield { choices: [{ delta: { content: '收到。' } }] };
      yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
    },
  } as any;
}

async function runTurn(runner: StreamedRunner, input: string): Promise<void> {
  const events: any[] = [];
  for await (const ev of runner.run(input)) {
    events.push(ev);
    if (events.length > 1000) throw new Error('runaway event loop');
  }
}

describe('system 前缀跨轮稳定 (PROMPT-07)', () => {
  it('连续 5 轮: system 消息数与内容完全不变, dynamic 段只出现一次', async () => {
    const memory = new ShortTermMemory();
    const runner = new StreamedRunner({
      llmProvider: textProvider(),
      model: 'test-model',
      tools: [],
      memory,
      config: { maxIterations: 3, temperature: 0 } as any,
      instructions: '你是 Neox',
      sessionId: 'prefix-stability',
      approvalHandler: async () => true,
      dynamicSystemPromptProvider: () => SECTION,
    } as any);

    const snapshots: string[] = [];
    const counts: number[] = [];
    for (let i = 0; i < 5; i++) {
      await runTurn(runner, `第 ${i + 1} 轮`);
      const systems = memory.getMessagesForLLM()
        .filter((m) => m.role === 'system')
        .map((m) => String(m.content));
      counts.push(systems.length);
      snapshots.push(systems.join('\n\n'));
    }

    expect(counts).toEqual([2, 2, 2, 2, 2]);
    expect(new Set(snapshots).size).toBe(1);
    expect(snapshots[0].split(SECTION).length - 1).toBe(1);
  });

  it('段内容变化时原地更新 (system 消息数不变, 旧内容不残留)', async () => {
    const memory = new ShortTermMemory();
    let section = SECTION;
    const runner = new StreamedRunner({
      llmProvider: textProvider(),
      model: 'test-model',
      tools: [],
      memory,
      config: { maxIterations: 3, temperature: 0 } as any,
      instructions: '你是 Neox',
      sessionId: 'prefix-stability-change',
      approvalHandler: async () => true,
      dynamicSystemPromptProvider: () => section,
    } as any);

    await runTurn(runner, '第一轮');
    section = SECTION.replace('已开启', '已关闭');
    await runTurn(runner, '第二轮');

    const systems = memory.getMessagesForLLM()
      .filter((m) => m.role === 'system')
      .map((m) => String(m.content));
    expect(systems).toHaveLength(2);
    expect(systems.join('\n')).toContain('已关闭');
    expect(systems.join('\n')).not.toContain('已开启');
  });
});
