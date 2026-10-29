import { describe, expect, it, vi } from 'vitest';
import { dsmlDiscardedText, dropIncompleteAssistantTurn } from '../dsmlRetryDiscard';

const THINKING = 'I should call the shell tool now.\n<｜DSML｜invoke name="bash">';

function env(detail: string) {
  let messages: any[] = [
    { id: 'u1', role: 'user', text: '修一下构建' },
    { id: 'm1', role: 'assistant', text: detail, pending: true },
  ];
  const d = {
    slot: { messageId: 'm1', timelineEntryId: 'msg-m1' },
    timeline: [{ id: 'msg-m1', type: 'assistant_message', detail } as any],
    updateTimelineEntryById: vi.fn(),
    deleteTimelineEntry: vi.fn(),
    dispatchForegroundMessages: vi.fn((_s: string, fn: (p: any[]) => any[]) => { messages = fn(messages); }),
  };
  return { d, messages: () => messages };
}

describe('dsmlDiscardedText', () => {
  it('兼容 data 里 / 事件顶层两种放法; 别的形状一律当没带', () => {
    expect(dsmlDiscardedText({ data: { discardedText: 'x' } })).toBe('x');
    expect(dsmlDiscardedText({ discardedText: 'y' })).toBe('y');
    expect(dsmlDiscardedText({ data: { attempt: 1 } })).toBe('');
    expect(dsmlDiscardedText(undefined)).toBe('');
  });
});

describe('dropIncompleteAssistantTurn (残缺 DSML 重来)', () => {
  it('先流出一段思考 → 收到重来事件 → 气泡清空, 新回答正常接上', () => {
    const { d, messages } = env(THINKING);
    dropIncompleteAssistantTurn('s1', THINKING, d);

    expect(d.deleteTimelineEntry).toHaveBeenCalledWith('s1', 'msg-m1');
    expect(messages().map((m) => m.id)).toEqual(['u1']); // 思考那段没了, 用户消息还在

    /* 重来后的正文新开一个气泡 (真实链路里是下一段流式 token), 屏幕上只剩正常回答 */
    const afterRetry = [...messages(), { id: 'm2', role: 'assistant', text: '修好了。' }];
    expect(afterRetry.filter((m) => m.role === 'assistant').map((m) => m.text)).toEqual(['修好了。']);
  });

  it('节流器只画到作废段的前缀 → 整条气泡删掉', () => {
    const { d, messages } = env('I should call');
    dropIncompleteAssistantTurn('s1', THINKING, d);
    expect(d.deleteTimelineEntry).toHaveBeenCalledWith('s1', 'msg-m1');
    expect(messages().map((m) => m.id)).toEqual(['u1']);
  });

  it('事件没带正文 (老 kernel) → 这一轮整体作废, 不留旧气泡', () => {
    const { d, messages } = env(THINKING);
    dropIncompleteAssistantTurn('s1', '', d);
    expect(d.deleteTimelineEntry).toHaveBeenCalledWith('s1', 'msg-m1');
    expect(messages().map((m) => m.id)).toEqual(['u1']);
  });

  it('对不上 (已经被别的路径改过) → 原样不动, 不猜', () => {
    const { d, messages } = env('完全不同的内容');
    dropIncompleteAssistantTurn('s1', THINKING, d);
    expect(d.deleteTimelineEntry).not.toHaveBeenCalled();
    expect(messages()).toHaveLength(2);
  });
});
