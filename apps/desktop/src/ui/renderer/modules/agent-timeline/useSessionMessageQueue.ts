import { useCallback, useRef, useState } from 'react';

export interface ComposerQueuedMessage {
  text: string;
  images?: Array<{ mediaType: string; data: string; name?: string }>;
}

/** Keep ownership across session switches; taking a batch is synchronous. */
export function useSessionMessageQueue(sessionId: string | null) {
  const queues = useRef(new Map<string | null, ComposerQueuedMessage[]>());
  const [, refresh] = useState(0);
  const get = useCallback((sid: string | null) => queues.current.get(sid) ?? [], []);
  const setForSession = useCallback((
    sid: string | null,
    update: ComposerQueuedMessage[] | ((previous: ComposerQueuedMessage[]) => ComposerQueuedMessage[]),
  ) => {
    const previous = queues.current.get(sid) ?? [];
    const next = typeof update === 'function' ? update(previous) : update;
    if (previous === next) return;
    if (next.length) queues.current.set(sid, next);
    else queues.current.delete(sid);
    refresh(value => value + 1);
  }, []);
  const set = useCallback((
    update: ComposerQueuedMessage[] | ((previous: ComposerQueuedMessage[]) => ComposerQueuedMessage[]),
  ) => setForSession(sessionId, update), [sessionId, setForSession]);
  const takeAll = useCallback(() => {
    const items = get(sessionId);
    if (items.length) setForSession(sessionId, []);
    return items;
  }, [sessionId, get, setForSession]);
  return { items: get(sessionId), get, set, setForSession, takeAll };
}
