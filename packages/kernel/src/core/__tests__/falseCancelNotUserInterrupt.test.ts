/**
 * "被用户停止" 只在 abort 信号确实来自用户时成立。
 * ═══════════════════════════════════════════════════════════════════════════
 * 网络流断开不能被误判为用户取消。取消分类需要区分:
 *   1. anthropic.ts 判"是不是取消"用的是 `error.message.includes('aborted')` ——
 *      Node 的 http 响应被上游/代理中途掐断时抛的错误 message 恰好就是 `aborted`
 *      (code=ECONNRESET), 于是一次纯网络截断被贴上 AbortError/ERR_CANCELED;
 *   2. runner 见到 CANCELED 就 terminate('interrupted') + yield "Task interrupted by user.",
 *      而且这个分支排在重试决策**之前** —— 一次都不重连就把话说死。
 *
 * 没有 abort 信号且不是 steering 时归入流中断并走正常重连；signal.aborted 时保持取消行为。
 */
import { describe, expect, it } from 'vitest';
import { StreamedRunner } from '../runner.js';
import { ShortTermMemory } from '../../memory/shortterm.js';
import { reclassifyFalseCancel } from '../runnerErrorUtils.js';
import { classifyError, ErrorCategory, NeoxError } from '../../types/errors.js';

/** 复刻 Node 在响应被上游掐断时抛的那个错误 */
function makeNodeAbortedError(): any {
  const err: any = new Error('aborted');
  err.code = 'ECONNRESET';
  return err;
}

describe('reclassifyFalseCancel', () => {
  const canceled = new NeoxError({
    category: ErrorCategory.CANCELED,
    code: 'CANCELED',
    message: 'Request was canceled',
    retryable: false,
  });

  it('没有 abort 信号 → 不是取消, 归可重试的流中断', () => {
    const out = reclassifyFalseCancel(canceled, { aborted: false, steering: false });
    expect(out.category).toBe(ErrorCategory.RETRYABLE_STREAM);
    expect(out.retryable).toBe(true);
    expect(out.code).toBe('STREAM_INTERRUPTED');
  });

  it('用户真按了停止 → 原样保留 CANCELED', () => {
    expect(reclassifyFalseCancel(canceled, { aborted: true, steering: false })).toBe(canceled);
  });

  it('steering 打断 → 原样保留 (runner 靠 CANCELED 走插话续跑那条路)', () => {
    expect(reclassifyFalseCancel(canceled, { aborted: false, steering: true })).toBe(canceled);
  });

  it('非 CANCELED 的错误不碰', () => {
    const net = classifyError(makeNodeAbortedError());
    expect(net.category).toBe(ErrorCategory.RETRYABLE_NETWORK);
    expect(reclassifyFalseCancel(net, { aborted: false, steering: false })).toBe(net);
  });
});

describe('runner: 上游掐断的流不许说成"用户中断"', () => {
  it('provider 抛 AbortError 但没人 abort → 重连并正常收尾', async () => {
    const state = { calls: 0 };
    const provider: any = {
      async chat() { throw new Error('chat() not expected'); },
      async *chatStreamed() {
        state.calls++;
        if (state.calls === 1) {
          yield { choices: [{ delta: { content: '半张表格' } }] };
          /* provider 层把网络截断误标成 abort 的形态 (修复前 anthropic.ts 就这么干) */
          const e: any = new Error('aborted');
          e.name = 'AbortError';
          e.code = 'ERR_CANCELED';
          throw e;
        }
        yield { choices: [{ delta: { content: '重连后的完整回答' } }] };
        yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
      },
    };

    const runner = new StreamedRunner({
      llmProvider: provider,
      model: 'test-model',
      tools: [],
      memory: new ShortTermMemory(),
      config: { maxIterations: 5, temperature: 0 } as any,
      instructions: 'You are a test agent.',
      autoCompressEnabled: false,
      disableSystemPrompt: true,
    });

    const events: any[] = [];
    for await (const event of runner.run('写一份长文档')) {
      events.push(event);
      if (events.length > 500) throw new Error('runaway event loop');
    }

    const interrupted = events.find(
      (e) => e.type === 'error' && /interrupted by user/i.test(String(e.error)),
    );
    expect(interrupted).toBeUndefined();
    expect(state.calls).toBe(2);
    const finalText = events
      .filter((e) => e.type === 'text_delta')
      .map((e) => e.delta)
      .join('');
    expect(finalText).toContain('重连后的完整回答');
  });
});
