import { describe, expect, it, vi } from 'vitest';
import { dropDiscardedAssistantText, withoutDiscardedTail } from '../retryDiscardedText';

describe('withoutDiscardedTail', () => {
  it('整段就是作废的正文 → 空', () => {
    expect(withoutDiscardedTail('我先看看本机的情况。', '我先看看本机的情况。')).toBe('');
  });
  it('前面有别的正文 → 只撤末尾那段', () => {
    expect(withoutDiscardedTail('上一步做完了。\n\n我先看看本机的情况。', '我先看看本机的情况。')).toBe('上一步做完了。');
  });
  it('节流器还没显示完 (显示的是作废段的前缀) → 空', () => {
    expect(withoutDiscardedTail('我先看看', '我先看看本机的情况。')).toBe('');
  });
  it('对不上 → null, 不动', () => {
    expect(withoutDiscardedTail('完全不同的内容', '我先看看本机的情况。')).toBeNull();
    expect(withoutDiscardedTail('随便', '')).toBeNull();
  });
});

describe('dropDiscardedAssistantText', () => {
  const slot = { messageId: 'm1', timelineEntryId: 'msg-m1' };
  const deps = (detail: string) => {
    let messages: any[] = [{ id: 'm1', role: 'assistant', text: detail }, { id: 'u1', role: 'user', text: 'hi' }];
    const d = {
      slot,
      timeline: [{ id: 'msg-m1', type: 'assistant_message', detail } as any],
      updateTimelineEntryById: vi.fn(),
      deleteTimelineEntry: vi.fn(),
      dispatchForegroundMessages: vi.fn((_s: string, fn: (p: any[]) => any[]) => { messages = fn(messages); }),
    };
    return { d, messages: () => messages };
  };

  it('实拍场景: 重试从头生成 → 上一次那句开场白整条删掉', () => {
    const { d, messages } = deps('我先看看本机的情况。');
    dropDiscardedAssistantText('s1', '我先看看本机的情况。', d);
    expect(d.deleteTimelineEntry).toHaveBeenCalledWith('s1', 'msg-m1');
    expect(messages().map((m) => m.id)).toEqual(['u1']);
  });

  it('气泡里还有之前的正文 → 只截掉作废段', () => {
    const { d, messages } = deps('前文。我先看看本机的情况。');
    dropDiscardedAssistantText('s1', '我先看看本机的情况。', d);
    expect(d.deleteTimelineEntry).not.toHaveBeenCalled();
    const updater = d.updateTimelineEntryById.mock.calls[0][2];
    expect(updater({ id: 'msg-m1', detail: 'x' }).detail).toBe('前文。');
    expect(messages()[0].text).toBe('前文。');
  });

  it('prefill 续写 (discardedText 为空) / 对不上 → 什么都不动', () => {
    const { d } = deps('我先看看本机的情况。');
    dropDiscardedAssistantText('s1', '', d);
    dropDiscardedAssistantText('s1', '别的话', d);
    expect(d.deleteTimelineEntry).not.toHaveBeenCalled();
    expect(d.updateTimelineEntryById).not.toHaveBeenCalled();
  });
});
