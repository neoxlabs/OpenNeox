import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';

const workspaceStore = new AsyncLocalStorage<string>();

export function getWorkspaceRootFromContext(): string | undefined {
  return workspaceStore.getStore();
}

export async function runWithWorkspaceRoot<T>(
  workspaceRoot: string | undefined,
  task: () => T | Promise<T>
): Promise<T> {
  if (!workspaceRoot || !workspaceRoot.trim()) {
    return task();
  }
  const normalized = path.resolve(workspaceRoot);
  return workspaceStore.run(normalized, async () => await task());
}
