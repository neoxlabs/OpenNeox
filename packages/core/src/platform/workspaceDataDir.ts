import path from 'path';
import crypto from 'crypto';
import { CONFIG_DIR } from '@neoxlabs/platform/utils/config.js';

export const WORKSPACES_DIR = path.join(CONFIG_DIR, 'workspaces');

function sanitizeName(name: string): string {
  const normalized = name
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized.slice(0, 24) || 'workspace';
}

export function buildWorkspaceId(workspacePath: string): string {
  const resolved = path.resolve(workspacePath);
  const baseName = sanitizeName(path.basename(resolved));
  const hash = crypto.createHash('sha1').update(resolved).digest('hex').slice(0, 12);
  return `${baseName}-${hash}`;
}

export function workspaceDataDir(workspacePath: string): string {
  return path.join(WORKSPACES_DIR, buildWorkspaceId(workspacePath));
}
