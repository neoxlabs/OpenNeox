import { useEffect, useRef } from 'react';
import type { TimelineEntry } from '../../../utils/workspaceUtils';
import { useRecentArtifacts, type RecentArtifact } from './useRecentArtifacts';
import { useSurfaces } from '../../../state/surfaceStore';
import { openSurfaceFromPath } from '../../../state/openSurfaceFromPath';

const RANK: Array<[RegExp, number]> = [
  [/\.(pptx?|docx?|xlsx?|mp4|mov|webm|pdf)$/i, 3],
  [/\.(png|jpe?g|svg|gif|webp|csv)$/i, 2],
  [/\.(md|markdown|html?)$/i, 1],
];
const rankOf = (p: string): number => RANK.find(([re]) => re.test(p))?.[1] ?? 0;

/** 纯函数 (单测入口): 这一轮该自动打开哪个成品; 不该开返回 null */
export function pickDeliverableToOpen(
  artifacts: RecentArtifact[],
  turnStartedAt: number,
  surfaceTouchedThisTurn: boolean,
): string | null {
  if (surfaceTouchedThisTurn) return null;
  const fresh = artifacts.filter((a) => !a.deleted && a.ts >= turnStartedAt && rankOf(a.path) > 0);
  if (fresh.length === 0) return null;
  fresh.sort((a, b) => rankOf(b.path) - rankOf(a.path) || b.ts - a.ts);
  return fresh[0]!.path;
}

/** 这个面板是不是我们自动打开的那份 —— 产物路径可能是相对的, 面板里存的是绝对路径, 按结尾比 */
function isAutoOpened(paths: Set<string>, s: unknown): boolean {
  const p = String((s as { source?: { path?: unknown } })?.source?.path ?? '').replace(/\\/g, '/');
  if (!p) return false;
  for (const x of paths) {
    const q = x.replace(/\\/g, '/');
    if (p === q || p.endsWith('/' + q) || q.endsWith('/' + p)) return true;
  }
  return false;
}

export function useAutoOpenDeliverable(opts: {
  enabled: boolean;
  sessionId: string | null;
  entries: TimelineEntry[];
  workspacePath?: string;
  streaming: boolean;
}): void {
  const { enabled, sessionId, entries, workspacePath, streaming } = opts;
  const artifacts = useRecentArtifacts({ sessionId, entries, workspacePath });
  const surfaces = useSurfaces(sessionId);
  const turnStartRef = useRef<{ sid: string | null; at: number } | null>(null);
  /* 这一轮已经自动开过的成品 (路径 + 档次): 过程中只往更像交付物的换, 不来回跳 */
  const openedRef = useRef<{ sid: string | null; at: number; paths: Set<string>; rank: number } | null>(null);

  useEffect(() => {
    const start = turnStartRef.current;
    if (!enabled || !streaming || !sessionId || !start || start.sid !== sessionId) return;
    if (!openedRef.current || openedRef.current.sid !== sessionId || openedRef.current.at !== start.at) {
      openedRef.current = { sid: sessionId, at: start.at, paths: new Set(), rank: 0 };
    }
    const opened = openedRef.current;
    const pick = pickDeliverableToOpen(artifacts.filter((a) => !opened.paths.has(a.path)), start.at, false);
    if (!pick || rankOf(pick) < opened.rank) return;
    /* agent 自己刚在右栏展示 / 刷新过东西 (例如 PPT 实时预览) → 不抢 */
    const now = Date.now();
    const agentShowing = surfaces.some((s) => {
      const t = s.updatedAt ?? s.createdAt ?? 0;
      return t >= start.at && now - t < 15_000 && !isAutoOpened(opened.paths, s);
    });
    if (agentShowing) return;
    opened.paths.add(pick);
    opened.rank = rankOf(pick);
    openSurfaceFromPath({ sessionId, path: pick, workspacePath });
  }, [artifacts, streaming, enabled, sessionId, surfaces, workspacePath]);

  useEffect(() => {
    if (streaming) {
      if (!turnStartRef.current || turnStartRef.current.sid !== sessionId) {
        turnStartRef.current = { sid: sessionId, at: Date.now() };
      }
      return;
    }
    const start = turnStartRef.current;
    turnStartRef.current = null;
    /* 切会话造成的 streaming 翻转不算"这一轮结束" */
    if (!enabled || !sessionId || !start || start.sid !== sessionId) return;
    const opened = openedRef.current?.at === start.at ? openedRef.current : null;
    /* 过程中自动开过的不算 agent 展示过 —— 收尾时最终成品若更像交付物, 照样换过去 */
    const touched = surfaces.some((s) => (s.updatedAt ?? s.createdAt ?? 0) >= start.at
      && !(opened && isAutoOpened(opened.paths, s)));
    const path = pickDeliverableToOpen(artifacts.filter((a) => !opened?.paths.has(a.path)), start.at, touched);
    if (path) openSurfaceFromPath({ sessionId, path, workspacePath });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在 streaming 翻转时判一次
  }, [streaming]);
}
