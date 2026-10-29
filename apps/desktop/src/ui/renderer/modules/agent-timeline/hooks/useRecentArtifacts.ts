
import { useMemo } from 'react';
import { getWriteDeclarations, type WriteDeclaration } from '@neoxlabs/kernel/core/writeLedger.js';
import type { TimelineEntry } from '../../../utils/workspaceUtils';
import { isPseudoEllipsisPath, resolveWorkspacePath } from '../../../utils/pathUtils';
import { extractWriteDeclarationsFromTimelineEntries } from '../turnWriteDeclarations';

/** 一次最多留这么多条 —— 右栏只是入口, 不是文件管理器 */
const MAX_ARTIFACTS = 6;

/** 什么算"产物": 有成品形态、用户会想打开看的东西。.ts/.tsx/.css 这些是源码, 不算。 */
const ARTIFACT_EXT = /\.(pptx?|pptm|ppsx?|docx?|xlsx?|xlsm|csv|pdf|md|markdown|html?|svg|png|jpe?g|gif|webp|bmp|mp3|wav|mp4|mov|zip)$/i;

const NOISE_DIR = /(^|[/\\])(node_modules|\.git|\.neox|\.neox-tmp|__pycache__|dist|build|out|coverage|\.next|\.turbo|\.cache|target|Pods|vendor)([/\\]|$)/;
const NOISE_BUNDLE = /\.(app|framework|dSYM|xcarchive|asar\.unpacked)[/\\]/i;

export interface RecentArtifact {
  path: string;
  ts: number;
  /** 删除的产物仍然列出来(带标记), 否则"东西没了"这件事在 UI 上完全不可见 */
  deleted: boolean;
}

function isArtifactPath(p: string): boolean {
  if (!p) return false;
  if (NOISE_DIR.test(p) || NOISE_BUNDLE.test(p)) return false;
  return ARTIFACT_EXT.test(p);
}

/**
 * 工作区归属 —— 只列这个工作区里的文件。
 *
 * 跟老行为同口径 (老实现靠"watcher 只盯工作区根"天然做到), 但现在是显式判据:
 * 图片模式把成品写进 userData/neox-artifacts、agent 顺手写的 /tmp 临时文件, 都不该
 * 出现在「在 <项目>」这一栏旁边。
 */
function inWorkspace(p: string, workspacePath?: string): boolean {
  if (!workspacePath) return true;
  const ws = workspacePath.replace(/[/\\]+$/, '');
  if (!ws) return true;
  /* macOS 默认大小写不敏感、Windows 一定不敏感 —— 跟 relativeToWorkspace 同口径。 */
  const lower = p.toLowerCase();
  const wsLower = ws.toLowerCase();
  return lower === wsLower
    || lower.startsWith(`${wsLower}/`)
    || lower.startsWith(`${wsLower}\\`);
}

const EMPTY_DECLS: WriteDeclaration[] = [];

/**
 * 把声明折叠成"每个路径一条, 取最后一次写入", 再过滤 / 排序 / 截断。
 *
 * 纯函数 (单测入口)。折叠规则跟 foldWriteDeclarations 一致:
 * rename 删 from 留 to, 其余按路径后写覆盖; delete 保留但标记 deleted。
 */
export function pickRecentArtifacts(
  decls: WriteDeclaration[],
  opts: { workspacePath?: string; limit?: number } = {},
): RecentArtifact[] {
  const limit = opts.limit ?? MAX_ARTIFACTS;
  const byPath = new Map<string, RecentArtifact>();

  for (const d of decls) {
    if (d.op === 'rename' && d.from) {
      byPath.delete(resolveWorkspacePath(d.from, opts.workspacePath));
    }
    for (const raw of d.paths) {
      const p = resolveWorkspacePath(raw, opts.workspacePath);
      if (isPseudoEllipsisPath(p)) continue;
      if (!isArtifactPath(p) || !inWorkspace(p, opts.workspacePath)) continue;
      /* 重新 set 让它挪到队尾 —— Map 保插入序, 天然 LRU
       * (同一个 pptx 被写 20 次只算一条, 时间取最后一次) */
      byPath.delete(p);
      byPath.set(p, { path: p, ts: d.ts, deleted: d.op === 'delete' });
    }
  }

  return [...byPath.values()].sort((a, b) => b.ts - a.ts).slice(0, limit);
}

export interface UseRecentArtifactsOptions {
  sessionId: string | null;
  entries: TimelineEntry[];
  workspacePath?: string;
}

export function useRecentArtifacts({
  sessionId,
  entries,
  workspacePath,
}: UseRecentArtifactsOptions): RecentArtifact[] {
  /* 回放是 O(entries), 跟主时间线的 map 同一量级; 右栏只在可见时才挂载。
   *
   * 不做"只处理新增尾巴"的增量缓存: prependOlderTimelineEntries 会往**头部**插,
   * 增量口径会被它悄悄搞错 (少算 / 多算都难发现)。entries 每次流式追加都是新数组,
   * 这里就是每轮重算一次, 跟 mapTimelineEntriesToRows 同样的代价。 */
  const replayed = useMemo(
    () => (sessionId && entries.length > 0
      ? extractWriteDeclarationsFromTimelineEntries(entries, sessionId, workspacePath)
      : EMPTY_DECLS),
    [sessionId, entries, workspacePath],
  );

  return useMemo(() => {
    const live = sessionId ? getWriteDeclarations(sessionId) : EMPTY_DECLS;
    return pickRecentArtifacts([...replayed, ...live], { workspacePath });
  }, [replayed, sessionId, workspacePath]);
}
