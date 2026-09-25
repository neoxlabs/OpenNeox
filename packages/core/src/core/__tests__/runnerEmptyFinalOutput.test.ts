import { describe, expect, it, vi } from 'vitest';
import { handleEmptyFinalOutputRecovery } from '@neoxlabs/kernel/core/runnerEmptyFinalOutputUtils.js';
import { finalizeNoToolResponse } from '@neoxlabs/kernel/core/runnerNoToolFinalizeUtils.js';

describe('runner empty final output recovery', () => {
  it('nudges the model to provide a final answer after tools', () => {
    const appendReminder = vi.fn();
    const result = handleEmptyFinalOutputRecovery({
      fullContent: '',
      finishReason: 'stop',
      textOnlyStreakCount: 0,
      totalToolCalls: 2,
      memory: { appendReminder },
    });

    expect(result.shouldContinue).toBe(true);
    expect(result.textOnlyStreakCount).toBe(1);
    expect(result.event).toMatchObject({
      type: 'raw_response_event',
      event_type: 'runner.empty_final_output_recovery',
    });
    expect(appendReminder).toHaveBeenCalledOnce();
    expect(appendReminder.mock.calls[0][0]).toContain('没有输出最终结果');
  });

  it('accepts legitimate empty stop after retries — finishReason=stop is a valid end state', async () => {
    /* 跟 Claude Code claude.ts:2346-2349 行为对齐 — 模型决定"我做完了, 没补充"
     * 是合法响应, 不是 error. 重试用尽后静默接收, 不抛 error 卡片. */
    const result = await finalizeNoToolResponse({
      fullContent: '',
      finishReason: 'stop',
      toolCallCount: 0,
      totalToolCalls: 2,
      iteration: 4,
      textOnlyStreakCount: 2,
      outputGuardrails: [],
      context: {},
      agentName: 'plan-agent',
      memory: { appendReminder: vi.fn() },
    });

    expect(result.shouldContinue).toBe(false);
    expect(result.finalOutput).toBe('');
    /* 不应有 error 事件 (合法终止) */
    const errorEvents = result.events.filter((e: any) => e.type === 'error');
    expect(errorEvents).toEqual([]);
  });

  it('surfaces a red error card on abnormal finish_reason (length / content_filter)', async () => {
    /* S3 (runnerNoToolFinalizeUtils): 调完 tool 后 finish_reason=length/content_filter 截断
     * 没吐字 → 用户看到"工具跑完但没有回复", 给红色 error 卡片告知 finish_reason
     * (行为变更: 原软提示升级为 error — 这是真问题不该静默). */
    const result = await finalizeNoToolResponse({
      fullContent: '',
      finishReason: 'length',
      toolCallCount: 0,
      totalToolCalls: 3,
      iteration: 4,
      textOnlyStreakCount: 2,
      outputGuardrails: [],
      context: {},
      agentName: 'plan-agent',
      memory: { appendReminder: vi.fn() },
    });

    expect(result.shouldContinue).toBe(false);
    const errorEvents = result.events.filter((e: any) => e.type === 'error');
    expect(errorEvents).toHaveLength(1);
    expect(String((errorEvents[0] as any).error)).toContain('finish_reason=length');
  });
});
