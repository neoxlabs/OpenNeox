
import type { ChatMessage } from '../../../../shared/ipc';
import { dropDiscardedAssistantText, type RetryDiscardDeps } from './retryDiscardedText';

/** 取事件里要作废的正文。kernel 放在 data.discardedText; 兼容直接挂在事件上的老形状。 */
export function dsmlDiscardedText(event: any): string {
  const raw = event?.discardedText ?? event?.data?.discardedText;
  return typeof raw === 'string' ? raw : '';
}

/** 撤掉这一轮的助手气泡 (调用方先 closeSlot, 让 slot 定格在这一轮) */
export function dropIncompleteAssistantTurn(
  sessionId: string,
  discardedText: string,
  deps: RetryDiscardDeps,
): void {
  if (discardedText) {
    dropDiscardedAssistantText(sessionId, discardedText, deps);
    return;
  }
  const slot = deps.slot;
  if (!slot) return;
  if (deps.deleteTimelineEntry) void deps.deleteTimelineEntry(sessionId, slot.timelineEntryId);
  const { messageId } = slot;
  deps.dispatchForegroundMessages(sessionId, (prev: ChatMessage[]) =>
    prev.filter((msg) => !(msg.id === messageId && msg.role === 'assistant')),
  );
}
