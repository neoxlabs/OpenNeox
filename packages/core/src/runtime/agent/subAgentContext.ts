import { AsyncLocalStorage } from 'node:async_hooks';

const store = new AsyncLocalStorage<string>();

export function runInSubAgentSession<T>(subSessionId: string, fn: () => T): T {
  return store.run(subSessionId, fn);
}

export function currentSubAgentSessionId(): string | undefined {
  return store.getStore();
}
