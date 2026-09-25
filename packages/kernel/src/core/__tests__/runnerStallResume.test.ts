/**
 * stall 续跑沿用当前轮次的状态和预算，而不是创建新一轮。
 *
 *   流卡住时 host 会拿原 task 再调一次 runner.run(), 带 `resumeAfterStall: true`。
 *   resumeAfterStall 除了避免重复追加用户消息，还必须保留
 *   **开新一轮的清零**照跑: skill scope 抹掉、loopDetector 清零、收尾验证闸清零、
 *   runContext 换新、迭代数/工具调用数/运行时长全部从头算。
 *
 */
import { describe, expect, it } from 'vitest';
import { StreamedRunner } from '../runner.js';
import { ShortTermMemory } from '../../memory/shortterm.js';

/** 每次 chatStreamed 都直接给最终答案; 记录被调了几次 */
function makeCountingProvider() {
  const calls = { count: 0 };
  const provider = {
    async chat() { throw new Error('chat() not expected'); },
    async *chatStreamed() {
      calls.count++;
      yield { choices: [{ delta: { content: 'final answer' } }] };
      yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
    },
  } as any;
  return { provider, calls };
}

function makeRunner(sessionId: string, provider: any, maxIterations: number) {
  return new StreamedRunner({
    llmProvider: provider,
    model: 'test-model',
    tools: [],
    memory: new ShortTermMemory(),
    config: { maxIterations, temperature: 0 } as any,
    instructions: 'test agent',
    sessionId,
    autoCompressEnabled: false,
    disableSystemPrompt: true,
  });
}

async function drain(gen: AsyncGenerator<unknown>) {
  for await (const _e of gen) { /* drain */ }
}

describe('stall 续跑', () => {
  it('续跑保留本轮状态: runContext 不换、验证闸/改动计数不清零', async () => {
    const { provider } = makeCountingProvider();
    const runner = makeRunner('stall-resume-state', provider, 8);
    await drain(runner.run('原任务'));

    const box = runner as any;
    const contextBefore = box.runContext;
    /* 模拟"本轮已经改过文件、还没验证" —— 这正是收尾验证闸要记住的事 */
    box.runMutationCount = 3;
    box.ranVerifyTool = true;
    box.idleNoToolStreak = 2;

    await drain(runner.run('原任务', undefined, undefined, { resumeAfterStall: true }));

    expect(box.runContext).toBe(contextBefore);   /* 同一个对象, 不是新建的 */
    expect(box.runMutationCount).toBe(3);
    expect(box.ranVerifyTool).toBe(true);
    /* 空转计数只会接着累加, 不会回零 —— 续跑那一段本身又是"零工具零改动"的一轮,
     * 所以是 2 起步继续加, 而不是从 0 重新数 (回零正是空转硬停失灵的入口)。 */
    expect(box.idleNoToolStreak).toBeGreaterThanOrEqual(2);
  });

  it('不带标记的下一轮照旧清零 —— 上一轮的状态不许沾染新一轮', async () => {
    const { provider } = makeCountingProvider();
    const runner = makeRunner('stall-resume-newturn', provider, 8);
    await drain(runner.run('第一轮'));

    const box = runner as any;
    const contextBefore = box.runContext;
    box.runMutationCount = 3;
    box.ranVerifyTool = true;

    await drain(runner.run('第二轮 (用户真的又说话了)'));

    expect(box.runContext).not.toBe(contextBefore);
    expect(box.runMutationCount).toBe(0);
    expect(box.ranVerifyTool).toBe(false);
  });

  it('迭代额度接着上一段算: 用满的轮次不会因为断流又白拿一次', async () => {
    /* maxIterations=1: 第一次 run 就把额度用完了。
     * 续跑必须一进循环就判超, 不再向模型发第二次请求。 */
    const { provider, calls } = makeCountingProvider();
    const runner = makeRunner('stall-resume-budget', provider, 1);
    await drain(runner.run('原任务'));
    expect(calls.count).toBe(1);

    await drain(runner.run('原任务', undefined, undefined, { resumeAfterStall: true }));
    expect(calls.count).toBe(1);   /* 续跑没有白拿一轮 */

    /* 对照: 真的新一轮就该重新给额度 */
    await drain(runner.run('新一轮'));
    expect(calls.count).toBe(2);
  });

  it('host 重启后第一次就带标记进来 (没有可继承的状态) → 按新一轮初始化, 不炸', async () => {
    const { provider, calls } = makeCountingProvider();
    const runner = makeRunner('stall-resume-cold', provider, 8);
    await drain(runner.run('原任务', undefined, undefined, { resumeAfterStall: true }));
    expect((runner as any).runContext).toBeTruthy();
    expect(calls.count).toBe(1);
  });
});
