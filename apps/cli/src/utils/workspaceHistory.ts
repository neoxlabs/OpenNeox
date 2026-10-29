import * as fs from 'node:fs';
import * as path from 'path';

export function normalizeWorkspacePath(input: string, homeDir: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Empty workspace path');
  }
  if (trimmed === '~') {
    return homeDir || trimmed;
  }
  if (trimmed.startsWith('~/')) {
    return path.join(homeDir || '', trimmed.slice(2));
  }
  return path.resolve(trimmed);
}

/** Workspace labels shorten home to ~ and preserve the project name when truncated. */
export function formatWorkspaceLabel(workspacePath: string, homeDir: string, maxLen = 62): string {
  const shortened = homeDir && workspacePath.startsWith(homeDir)
    ? `~${workspacePath.slice(homeDir.length)}`
    : workspacePath;

  if (shortened.length <= maxLen) return shortened;
  const parts = shortened.split('/').filter(Boolean);
  const tail = parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : shortened;
  return tail.length <= maxLen ? tail : `…${tail.slice(-(maxLen - 1))}`;
}

export function getWorkspaceHistory(
  workDir: string,
  recentWorkspaces: unknown,
  homeDir: string,
): string[] {
  const stored = Array.isArray(recentWorkspaces) ? recentWorkspaces : [];
  const result: string[] = [];
  const seen = new Set<string>();
  const addPath = (item: string) => {
    try {
      const normalized = normalizeWorkspacePath(item, homeDir);
      if (!seen.has(normalized)) {
        seen.add(normalized);
        result.push(normalized);
      }
    } catch {
      // Ignore invalid entries.
    }
  };
  addPath(workDir);
  for (const item of stored) {
    addPath(item);
  }
  /* Remove missing directories while always retaining the current workspace. */
  return result.filter((p, idx) => {
    if (idx === 0) return true; // workDir 自己
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
}

export function saveWorkspaceHistoryIfChanged(params: {
  workspaces: string[];
  recentWorkspaces: unknown;
  persistRecentWorkspaces: (workspaces: string[]) => void;
}): void {
  const { workspaces, recentWorkspaces, persistRecentWorkspaces } = params;
  const unique = Array.from(new Set(workspaces));
  const current = Array.isArray(recentWorkspaces) ? recentWorkspaces : [];
  const unchanged =
    current.length === unique.length &&
    current.every((value, index) => value === unique[index]);
  if (unchanged) {
    return;
  }
  persistRecentWorkspaces(unique);
}
