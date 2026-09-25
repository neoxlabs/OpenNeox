import path from 'path';
import os from 'os';
import { getWorkspaceRootFromContext } from '@neoxlabs/kernel/tools/workspaceContext.js';

const WORKSPACE_ENV_KEY = 'NEOX_WORKDIR';

export function getWorkspaceRoot(): string {
  const contextRoot = getWorkspaceRootFromContext();
  if (contextRoot) {
    return path.resolve(contextRoot);
  }

  const envPath = process.env[WORKSPACE_ENV_KEY];
  if (envPath && envPath.trim()) {
    return path.resolve(envPath);
  }
  return process.cwd();
}

export function resolveWorkspacePath(requestedPath?: string): string {
  const workspaceRoot = getWorkspaceRoot();
  if (!requestedPath || requestedPath.trim() === '' || requestedPath.trim() === '.') {
    return workspaceRoot;
  }

  let normalized = requestedPath.trim();

  if (normalized.startsWith('~/')) {
    return path.resolve(path.join(os.homedir(), normalized.slice(2)));
  }

  const isAbsolutePath = path.isAbsolute(normalized);
  const looksLikeRootlessUserPath =
    process.platform !== 'win32' && normalized.startsWith(`Users${path.sep}`);

  if (isAbsolutePath || looksLikeRootlessUserPath) {
    const absCandidate =
      !isAbsolutePath && looksLikeRootlessUserPath ? path.join(path.sep, normalized) : normalized;
    return path.resolve(absCandidate);
  }

  normalized = normalized.replace(/^(?:\.{1,2}[\\/]|[\\/])+/, '');
  const segments = normalized.split(/[\\/]+/).filter(Boolean);
  const workspaceName = path.basename(workspaceRoot);
  if (segments.length > 0 && segments[0] === workspaceName) {
    segments.shift();
  }

  const targetPath = path.join(workspaceRoot, ...segments);
  return path.resolve(targetPath);
}

export function formatDisplayPath(absPath: string): string {
  const workspaceRoot = getWorkspaceRoot();
  const relative = path.relative(workspaceRoot, absPath);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return relative;
  }
  return absPath;
}

