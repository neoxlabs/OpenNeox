/**
 * 暂停期间收到停止信号时 runner 必须结束。
 *
 *   pauseGate.waitForResume() 与 abort 竞速；停止后立即收尾并调用 gate.cancel() 清理暂停，
 *   轮次结束时也清理尚未完成的暂停请求。
 */
import { describe, expect, it } from 'vitest';
import { StreamedRunner } from '../runner.js';
import { ShortTermMemory } from '../../memory/shortterm.js';
import { waitForResumeOrAbort, type PauseGate } from '../pauseGate.js';

function makeProvider(onStream?: () => void) {
  const state = { calls: 0 };
  const provider: any = {
    state,
    async chat() { throw new Error('chat() not expected'); },
    async *chatStreamed() {
      state.calls++;
      onStream?.();
      yield { choices: [{ delta: { content: 'done' } }] };
      yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
    },
  };
  return provider;
}

function makeRunner(provider: any, pauseGate: PauseGate) {
  return new StreamedRunner({
    llmProvider: provider,
    model: 'test-model',
    tools: [],
    memory: new ShortTermMemory(),
    config: { maxIterations: 5, temperature: 0 } as any,
    instructions: 'You are a test agent.',
    autoCompressEnabled: false,
    disableSystemPrompt: true,
    sessionId: 'sess-pause-abort',
    pauseGate,
  } as any);
}

/** 可控的暂停闸: waitForResume 只有 resume()/cancel() 能唤醒 */
function makeGate(initiallyPaused: boolean) {
  const g = {
    paused: initiallyPaused,
    cancelled: 0,
    wake: null as null | (() => void),
  };
  const gate: PauseGate = {
    isPaused: () => g.paused,
    waitForResume: () => new Promise<void>((resolve) => { g.wake = resolve; }),
    cancel: () => { g.cancelled++; g.paused = false; g.wake?.(); },
  };
  return { g, gate, resume: () => { g.paused = false; g.wake?.(); } };
}

describe('waitForResumeOrAbort', () => {
  const ctx = { sessionId: 's', iteration: 1, toolCalls: 0 };

  it('停止信号先到 → aborted, 并调用 cancel 清暂停', async () => {
    const { g, gate } = makeGate(true);
    const ac = new AbortController();
    const p = waitForResumeOrAbort(gate, ctx, ac.signal);
    setTimeout(() => ac.abort(), 20);
    await expect(p).resolves.toBe('aborted');
    expect(g.cancelled).toBe(1);
    expect(g.paused).toBe(false);
  });

  it('恢复先到 → resumed, 不调 cancel', async () => {
    const { g, gate, resume } = makeGate(true);
    const ac = new AbortController();
    const p = waitForResumeOrAbort(gate, ctx, ac.signal);
    setTimeout(resume, 20);
    await expect(p).resolves.toBe('resumed');
    expect(g.cancelled).toBe(0);
  });

  it('进来时已经停止 → 立刻 aborted', async () => {
    const { gate } = makeGate(true);
    const ac = new AbortController();
    ac.abort();
    await expect(waitForResumeOrAbort(gate, ctx, ac.signal)).resolves.toBe('aborted');
  });
});

describe('runner: 暂停中停止', () => {
  it('暂停挂起时触发 abort → run 在合理时间内结束, 不再调用模型, 暂停被清掉', async () => {
    const { g, gate } = makeGate(true);
    const provider = makeProvider();
    const runner = makeRunner(provider, gate);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);

    const started = Date.now();
    let n = 0;
    for await (const _ of runner.run('do something', undefined, ac.signal)) {
      if (++n > 200) throw new Error('runaway event loop');
    }

    expect(Date.now() - started).toBeLessThan(2000);
    expect(provider.state.calls).toBe(0);
    expect(g.cancelled).toBeGreaterThanOrEqual(1);
    expect(g.paused).toBe(false);
  });

  it('最后一个安全点之后才点的暂停, 在这一轮结束时被清掉', async () => {
    const { g, gate } = makeGate(false);
    /* 模拟用户在最后一次模型流进行中点了暂停 —— 这之后没有循环顶部了 */
    const provider = makeProvider(() => { g.paused = true; });
    const runner = makeRunner(provider, gate);
    for await (const _ of runner.run('say done')) { /* drain */ }
    expect(provider.state.calls).toBeGreaterThanOrEqual(1);
    expect(g.paused).toBe(false);
    expect(g.cancelled).toBeGreaterThanOrEqual(1);
  });
});
