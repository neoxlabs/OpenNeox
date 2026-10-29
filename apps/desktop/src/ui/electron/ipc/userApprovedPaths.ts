import * as path from 'node:path';
import type { WebContents } from 'electron';

type Capability = 'read' | 'write';

type ApprovalBucket = {
  read: Set<string>;
  write: Set<string>;
  /** Session / surface 绑定过的工作区根 — 整个树可读 (写仍走 path/write 集或当前窗口 roots). */
  roots: Set<string>;
  cleanupRegistered: boolean;
};

const approvalsByWebContents = new Map<number, ApprovalBucket>();

function normalizeApprovedPath(filePath: string): string | null {
  if (!filePath || typeof filePath !== 'string') return null;
  if (!path.isAbsolute(filePath)) return null;
  return filePath.replace(/[\\/]+$/, '') || filePath;
}

function normalizeRoot(rootPath: string): string | null {
  const normalized = normalizeApprovedPath(rootPath);
  if (!normalized) return null;
  /* 根目录用尾部分隔符无关的稳定形式 */
  return normalized.replace(/[\\/]+$/, '') || normalized;
}

function pathKey(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

function isPathInsideRoot(root: string, target: string): boolean {
  const r = pathKey(root);
  const t = pathKey(target);
  if (r === t) return true;
  return t.startsWith(r + '/') || t.startsWith(r + '\\');
}

function bucketFor(sender: WebContents): ApprovalBucket {
  let bucket = approvalsByWebContents.get(sender.id);
  if (!bucket) {
    bucket = {
      read: new Set(),
      write: new Set(),
      roots: new Set(),
      cleanupRegistered: false,
    };
    approvalsByWebContents.set(sender.id, bucket);
  }
  if (!bucket.cleanupRegistered) {
    bucket.cleanupRegistered = true;
    sender.once('destroyed', () => {
      approvalsByWebContents.delete(sender.id);
    });
  }
  return bucket;
}

export function rememberUserApprovedPath(sender: WebContents, filePath: string, capability: Capability): void {
  const normalized = normalizeApprovedPath(filePath);
  if (!normalized) return;
  const bucket = bucketFor(sender);
  bucket[capability].add(normalized);
  if (capability === 'write') {
    bucket.read.add(normalized);
  }
}

/** 记住会话/Surface 绑定的工作区根 — 切换窗口 primary workspace 后预览仍稳定. */
export function rememberApprovedRoot(sender: WebContents, rootPath: string): void {
  const normalized = normalizeRoot(rootPath);
  if (!normalized) return;
  bucketFor(sender).roots.add(normalized);
}

export function listApprovedRoots(sender: WebContents): string[] {
  const bucket = approvalsByWebContents.get(sender.id);
  if (!bucket) return [];
  return Array.from(bucket.roots);
}

export function hasUserApprovedPath(sender: WebContents, filePath: string, capability: Capability): boolean {
  const normalized = normalizeApprovedPath(filePath);
  if (!normalized) return false;
  const bucket = approvalsByWebContents.get(sender.id);
  if (!bucket) return false;
  if (bucket[capability].has(normalized)) return true;
  /* 读: 落在任一已批准工作区根内即放行 (跨 workspace 切窗后 Surface 不红字). */
  if (capability === 'read') {
    for (const root of bucket.roots) {
      if (isPathInsideRoot(root, normalized)) return true;
    }
  }
  return false;
}
