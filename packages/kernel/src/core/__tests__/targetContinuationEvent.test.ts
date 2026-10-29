import { describe, expect, it } from 'vitest';
import { buildTargetContinuationEvent } from '../runnerEventBuilders.js';

describe('buildTargetContinuationEvent', () => {
  it('emits raw_response_event for desktop divider', () => {
    const event = buildTargetContinuationEvent({
      iteration: 181,
      consecutiveBlocks: 1,
    });
    expect(event.type).toBe('raw_response_event');
    expect(event.event_type).toBe('target.continuation');
    expect(event.data).toEqual({
      type: 'target.continuation',
      iteration: 181,
      consecutive_blocks: 1,
      /* kind 缺省 'target' —— 保持历史行为 */
      kind: 'target',
    });
  });

  /* 收尾验证闸复用同一条事件通道，并携带 kind，避免 UI 将未配置 Target 的状态显示为未完成。 */
  it('carries kind=verify so the UI can label the verify gate correctly', () => {
    const event = buildTargetContinuationEvent({
      iteration: 4,
      consecutiveBlocks: 1,
      kind: 'verify',
    });
    expect((event.data as any).kind).toBe('verify');
  });
});
