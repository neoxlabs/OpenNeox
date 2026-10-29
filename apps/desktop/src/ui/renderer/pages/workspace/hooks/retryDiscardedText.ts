
import type { ChatMessage } from '../../../../shared/ipc';
import type { TimelineEntry } from '../../../utils/workspaceUtils';

/**
 * text 去掉末尾的 discarded 之后还剩什么; null = 对不上, 别动。
 * 允许 text 只是 discarded 的前缀 (节流器还没把整段显示出来) → 剩 ''。
 */
export function withoutDiscardedTail(text: string, discarded: string): string | null {
  const gone = discarded.trimEnd();
  if (!gone) return null;
  const shown = text.trimEnd();
  if (shown.endsWith(gone)) return shown.slice(0, -gone.length).trimEnd();
  if (shown.length > 0 && gone.startsWith(shown)) return '';
  return null;
}

export interface RetryDiscardDeps {
  slot: { messageId: string; timelineEntryId: string } | null | undefined;
  timeline: TimelineEntry[];
  updateTimelineEntryById: (sessionId: string, entryId: string, updater: (entry: TimelineEntry) => TimelineEntry, forceSync?: boolean) => void;
  deleteTimelineEntry?: (sessionId: string, entryId: string) => void | Promise<void>;
  dispatchForegroundMessages: (sessionId: string, fn: (prev: ChatMessage[]) => ChatMessage[]) => void;
}

/** 撤掉当前 (刚被 closeSlot 定稿的) 助手气泡末尾的作废正文; 撤空了就整条删掉 */
export function dropDiscardedAssistantText(sessionId: string, discarded: string, deps: RetryDiscardDeps): void {
  if (!discarded || !deps.slot) return;
  const { messageId, timelineEntryId } = deps.slot;
  const entry = deps.timeline.find((e) => e.id === timelineEntryId);
  const kept = entry ? withoutDiscardedTail(entry.detail || '', discarded) : null;
  if (!entry || kept === null) return;
  if (kept === '' && deps.deleteTimelineEntry) void deps.deleteTimelineEntry(sessionId, entry.id);
  else deps.updateTimelineEntryById(sessionId, entry.id, (prev) => ({ ...prev, detail: kept, pending: false }), true);
  deps.dispatchForegroundMessages(sessionId, (prev) => {
    const next: ChatMessage[] = [];
    for (const msg of prev) {
      if (msg.id !== messageId || msg.role !== 'assistant') { next.push(msg); continue; }
      const rest = withoutDiscardedTail(msg.text || '', discarded);
      if (rest === null) next.push(msg);
      else if (rest !== '') next.push({ ...msg, text: rest, pending: false });
    }
    return next;
  });
}
