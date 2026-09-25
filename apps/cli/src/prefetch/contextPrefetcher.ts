/**
 * Context Prefetcher — Speculation Phase 2
 *
 * 用户开始输入时，后台预加载常用上下文信息：
 * - git status
 * - 最近修改文件列表
 * - 当前文件 outline（如果在编辑器中打开）
 *
 * 减少提交后的等待时间 — 上下文数据已缓存在内存中。
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// ==================== Types ====================

export interface PrefetchedContext {
  gitStatus?: string;
  recentFiles?: string[];
  gitBranch?: string;
  lastFetched: number;
  /** Time taken to prefetch in ms */
  fetchDurationMs: number;
}

// ==================== Cache ====================

const CACHE_TTL_MS = 30_000; // 30 seconds
let cachedContext: PrefetchedContext | null = null;
let prefetchInFlight: Promise<PrefetchedContext> | null = null;

// ==================== Prefetch Logic ====================

async function runGitCommand(args: string[], cwd?: string, timeoutMs = 5_000): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: cwd || process.cwd(),
      timeout: timeoutMs,
      encoding: 'utf-8',
    });
    return stdout.trim();
  } catch {
    return '';
  }
}

async function fetchContextInternal(cwd?: string): Promise<PrefetchedContext> {
  const startTime = Date.now();

  // Run all git commands in parallel
  const [gitStatus, recentFilesRaw, gitBranch] = await Promise.all([
    runGitCommand(['status', '--porcelain', '--short'], cwd),
    runGitCommand(['log', '--pretty=format:', '--name-only', '-20', '--diff-filter=ACMR'], cwd),
    runGitCommand(['branch', '--show-current'], cwd),
  ]);

  // Parse recent files (deduplicate)
  const recentFiles = recentFilesRaw
    ? [...new Set(recentFilesRaw.split('\n').filter(f => f.trim()))].slice(0, 20)
    : [];

  const result: PrefetchedContext = {
    gitStatus: gitStatus || undefined,
    recentFiles: recentFiles.length > 0 ? recentFiles : undefined,
    gitBranch: gitBranch || undefined,
    lastFetched: Date.now(),
    fetchDurationMs: Date.now() - startTime,
  };

  cachedContext = result;
  return result;
}

// ==================== Public API ====================

/**
 * Start prefetching context in the background.
 * Safe to call multiple times — deduplicates concurrent requests.
 */
export function startPrefetch(cwd?: string): void {
  // Skip if cache is fresh
  if (cachedContext && (Date.now() - cachedContext.lastFetched) < CACHE_TTL_MS) {
    return;
  }

  // Skip if already in flight
  if (prefetchInFlight) return;

  prefetchInFlight = fetchContextInternal(cwd)
    .finally(() => { prefetchInFlight = null; });
}

/**
 * Get the cached prefetched context.
 * Returns null if no data is available yet.
 */
export function getCachedContext(): PrefetchedContext | null {
  return cachedContext;
}

/**
 * Get context, waiting for prefetch if needed.
 * Use when you need the data immediately.
 */
export async function getContext(cwd?: string): Promise<PrefetchedContext> {
  // Return cache if fresh
  if (cachedContext && (Date.now() - cachedContext.lastFetched) < CACHE_TTL_MS) {
    return cachedContext;
  }

  // Wait for in-flight prefetch
  if (prefetchInFlight) {
    return prefetchInFlight;
  }

  // Fetch now
  return fetchContextInternal(cwd);
}

/**
 * Invalidate the cache (e.g., after a git operation).
 */
export function invalidateCache(): void {
  cachedContext = null;
}

/**
 * Get a formatted summary of prefetched context for injection.
 */
export function formatPrefetchSummary(): string | null {
  if (!cachedContext) return null;

  const parts: string[] = [];

  if (cachedContext.gitBranch) {
    parts.push(`Branch: ${cachedContext.gitBranch}`);
  }

  if (cachedContext.gitStatus) {
    const lines = cachedContext.gitStatus.split('\n');
    const modified = lines.filter(l => l.startsWith(' M') || l.startsWith('M ')).length;
    const added = lines.filter(l => l.startsWith('?')).length;
    const staged = lines.filter(l => l.startsWith('A ') || l.startsWith('M ')).length;
    if (modified + added + staged > 0) {
      parts.push(`Changes: ${modified} modified, ${added} untracked, ${staged} staged`);
    }
  }

  if (cachedContext.recentFiles && cachedContext.recentFiles.length > 0) {
    parts.push(`Recently modified: ${cachedContext.recentFiles.slice(0, 5).join(', ')}`);
  }

  return parts.length > 0 ? parts.join('\n') : null;
}
