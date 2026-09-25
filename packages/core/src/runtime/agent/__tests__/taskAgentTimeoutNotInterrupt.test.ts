/** 子 agent 自身超时必须标记为运行时上限，而非用户中断，并引导拆分任务或接手处理。 */
import { describe, expect, it } from 'vitest';
import { resolveTaskAgentRunError } from '../taskAgentRunFailure.js';

/** 复刻 agentTool 成功路径上的超时改写 —— 钉行为, 不钉实现。 */
function remapTimeout(
  runError: string | null,
  opts: { selfTimedOut: boolean; abortReason?: string; timeoutMs: number; toolCount: number },
): string | null {
  if (!runError?.startsWith('aborted')) return runError;
  const reason = opts.abortReason ?? '';
  if (!opts.selfTimedOut && !reason.includes('agent timeout')) return runError;
  const secs = Math.round(opts.timeoutMs / 1000);
  return `timeout (${secs}s): 子 agent 撞到自身运行时上限被停止, 已执行 ${opts.toolCount} 次工具调用。`
    + `这不是它的结论有问题, 而是没跑完 —— 要么把任务拆小重派, 要么这一块自己接手做。`
    + `原样重派只会再撞一次同样的上限。`;
}

/** host 在超时 abort 后仍以正常 resolve 返回的 summary 形状。 */
const timedOutSummary = { failed: false, interrupted: true, output: '' };

describe('超时不许谎报成用户中断', () => {
  /* 'Task interrupted' 是 host 给"这轮被中断了"打的**标签**, 不是错因。
   * 把它塞进"原因"位就成了「中断: 中断」—— 零信息, 还读起来像用户按了停止。
   * 现在 stripInterruptLabel 在唯一出口把它剥掉, 这个字符串不该再出现在任何地方。 */
  it('光有中断标签时不许伪装成错因 —— 只返回裸 aborted', () => {
    const raw = resolveTaskAgentRunError(timedOutSummary, 'Task interrupted', 'task-agent run failed');
    expect(raw).toBe('aborted');
    expect(raw).not.toContain('Task interrupted');
  });

  it('标签后面跟着真原因时, 只留原因', () => {
    const raw = resolveTaskAgentRunError(
      timedOutSummary, 'Task interrupted: 停滞终止: 已经 5 分钟没有任何工具调用', 'task-agent run failed',
    );
    expect(raw).toBe('aborted: 停滞终止: 已经 5 分钟没有任何工具调用');
    expect(raw).not.toContain('Task interrupted');
  });

  it('selfTimedOut → 改写成 timeout (Ns), 不再出现 interrupted 字样', () => {
    const raw = resolveTaskAgentRunError(timedOutSummary, 'Task interrupted', 'task-agent run failed');
    const out = remapTimeout(raw, { selfTimedOut: true, timeoutMs: 300_000, toolCount: 9 });
    expect(out).toMatch(/^timeout \(300s\)/);
    expect(out).not.toContain('interrupted');
    expect(out).not.toContain('Task interrupted');
  });

  it('只有 abort reason 能证明超时时也要改写 (selfTimedOut 标记没传到)', () => {
    const raw = resolveTaskAgentRunError(timedOutSummary, 'Task interrupted', 'task-agent run failed');
    const out = remapTimeout(raw, {
      selfTimedOut: false, abortReason: 'agent timeout after 300s', timeoutMs: 300_000, toolCount: 3,
    });
    expect(out).toMatch(/^timeout \(300s\)/);
  });

  it('错误文案必须带上已执行的工具数 —— 父 agent 靠它判断"跑了多少活"', () => {
    const raw = resolveTaskAgentRunError(timedOutSummary, 'Task interrupted', 'task-agent run failed');
    const out = remapTimeout(raw, { selfTimedOut: true, timeoutMs: 300_000, toolCount: 17 });
    expect(out).toContain('17 次工具调用');
  });

  it('必须劝阻原样重派 —— 否则父 agent 会再撞一次同样的上限 (截图里的 -R1)', () => {
    const raw = resolveTaskAgentRunError(timedOutSummary, 'Task interrupted', 'task-agent run failed');
    const out = remapTimeout(raw, { selfTimedOut: true, timeoutMs: 300_000, toolCount: 5 });
    expect(out).toContain('拆小');
    expect(out).toContain('原样重派');
  });

  it('真的被用户停止时不许改写成 timeout —— 那是另一回事', () => {
    const raw = resolveTaskAgentRunError(timedOutSummary, 'Task interrupted', 'task-agent run failed');
    const out = remapTimeout(raw, { selfTimedOut: false, abortReason: 'user stop', timeoutMs: 300_000, toolCount: 2 });
    expect(out).toBe('aborted');
    expect(out).not.toContain('timeout');
  });

  it('传输故障导致的中断保留真实原因, 不被超时分支吃掉', () => {
    const raw = resolveTaskAgentRunError(timedOutSummary, 'ECONNRESET upstream closed', 'task-agent run failed');
    expect(raw).toBe('aborted: ECONNRESET upstream closed');
    const out = remapTimeout(raw, { selfTimedOut: false, abortReason: '', timeoutMs: 300_000, toolCount: 1 });
    expect(out).toBe('aborted: ECONNRESET upstream closed');
  });

  it('非 aborted 的失败 (真报错) 不进超时改写', () => {
    const failed = resolveTaskAgentRunError(
      { failed: true, interrupted: false, output: '' }, 'TypeError: x is not a function', 'task-agent run failed',
    );
    const out = remapTimeout(failed, { selfTimedOut: true, timeoutMs: 300_000, toolCount: 4 });
    expect(out).toBe('TypeError: x is not a function');
  });

  it('不同 agent 类型的上限如实报出 (plan 3min / research 6min)', () => {
    const raw = resolveTaskAgentRunError(timedOutSummary, 'Task interrupted', 'task-agent run failed');
    expect(remapTimeout(raw, { selfTimedOut: true, timeoutMs: 180_000, toolCount: 1 })).toMatch(/^timeout \(180s\)/);
    expect(remapTimeout(raw, { selfTimedOut: true, timeoutMs: 360_000, toolCount: 1 })).toMatch(/^timeout \(360s\)/);
  });
});
