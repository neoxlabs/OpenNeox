import type { ChatMessage } from '../../../../shared/ipc';

export function makeForegroundMessageDispatch(
  dispatch: (fn: (prev: ChatMessage[]) => ChatMessage[]) => void,
  activeSessionIdRef: { current: string | null },
): (sessionId: string, fn: (prev: ChatMessage[]) => ChatMessage[]) => void {
  return (sessionId, fn) => {
    if (activeSessionIdRef.current !== sessionId) return;
    dispatch(fn);
  };
}

export function patchMessageById(
  prev: ChatMessage[],
  messageId: string,
  patch: (msg: ChatMessage) => ChatMessage | null | undefined,
): ChatMessage[] {
  let changed = false;
  const next = prev.map((msg) => {
    if (msg.id !== messageId) return msg;
    const updated = patch(msg);
    if (!updated || updated === msg) return msg;
    changed = true;
    return updated;
  });
  return changed ? next : prev;
}
