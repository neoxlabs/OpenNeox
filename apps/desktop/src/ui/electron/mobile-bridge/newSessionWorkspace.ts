import { bridgeLog } from './log.js';

interface ScopeLike {
  workspacePath?: string;
}

interface ProjectManagerLike {
  getByPath?: (p: string) => ScopeLike | undefined | null;
  getFocused?: () => ScopeLike | undefined | null;
  openProject?: (p: string) => Promise<unknown>;
  openProjects?: ScopeLike[];
}

interface SessionStoreLike {
  listSessionsSlim?: (workspacePath?: string) => Promise<Array<{ workspacePath?: string; updatedAt?: number }>>;
}

async function openAndGet(pm: ProjectManagerLike, path: string): Promise<ScopeLike | null> {
  const open = pm.getByPath?.(path);
  if (open?.workspacePath) return open;
  try {
    await pm.openProject?.(path);
  } catch (e: any) {
    bridgeLog('createSession', `open workspace failed ${path}: ${e?.message ?? e}`);
    return null;
  }
  return pm.getByPath?.(path) ?? null;
}

export async function resolveNewSessionScope(
  pm: ProjectManagerLike,
  store: SessionStoreLike,
  requestedPath?: string,
): Promise<ScopeLike | null> {
  if (requestedPath) return openAndGet(pm, requestedPath);
  const focused = pm.getFocused?.() ?? pm.openProjects?.[0] ?? null;
  if (focused?.workspacePath) return focused;
  let recent: string | undefined;
  try {
    const rows = (await store.listSessionsSlim?.()) ?? [];
    recent = rows
      .filter((r) => typeof r.workspacePath === 'string' && r.workspacePath.length > 0)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]?.workspacePath;
  } catch (e: any) {
    bridgeLog('createSession', `list recent sessions failed: ${e?.message ?? e}`);
  }
  if (!recent) return null;
  bridgeLog('createSession', `no open workspace → opening most recent ${recent}`);
  return openAndGet(pm, recent);
}
