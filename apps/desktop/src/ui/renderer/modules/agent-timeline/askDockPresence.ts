import { useSyncExternalStore } from 'react';

let shownId: string | null = null;
const listeners = new Set<() => void>();

/** 药丸侧发布: 当前由药丸接管的 ask id; 没有就传 null */
export function setAskDockShown(id: string | null): void {
  if (shownId === id) return;
  shownId = id;
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function useAskDockShown(requestId: string | undefined): boolean {
  const read = () => !!requestId && shownId === requestId;
  return useSyncExternalStore(subscribe, read, read);
}
