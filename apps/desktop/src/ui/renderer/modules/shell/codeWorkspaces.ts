import { useEffect, useState } from 'react';
import { sameWorkspace } from '../../utils/pathUtils';

export const WS_COLORS = ['#2f6bff', '#2f9e5b', '#d97706', '#8b5cf6', '#e5484d', '#0ea5a4'] as const;

export interface CodeWorkspace {
  /** 主项目路径 (工作区的 key) */
  primary: string;
  name: string;
  /** 全部项目, 主项目在第一个 */
  roots: string[];
  color: string;
}

type Api = {
  listWorkspaces?: () => Promise<Array<{ path: string; name: string; rootCount: number; saved: boolean }>>;
  getWorkspaceRoots?: (p: string) => Promise<string[]>;
  setWorkspaceRoots?: (p: string, roots: string[]) => Promise<string[]>;
  setWorkspaceName?: (p: string, name: string) => Promise<string>;
  uiStateGet?: (k: string) => Promise<{ value?: unknown }>;
  uiStateSet?: (k: string, v: unknown) => Promise<unknown>;
};
const api = (): Api => ((window as { neox?: Api }).neox ?? {});
const META_KEY = 'code:ws-meta';
interface Meta { color?: string; name?: string }

let cache: CodeWorkspace[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

async function readMeta(): Promise<Record<string, Meta>> {
  try {
    const r = await api().uiStateGet?.(META_KEY);
    return r?.value && typeof r.value === 'object' ? (r.value as Record<string, Meta>) : {};
  } catch { return {}; }
}
const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** 只有多于一个项目的才算工作区 (单个项目就是项目本身) */
export async function refreshCodeWorkspaces(): Promise<CodeWorkspace[]> {
  try {
    const list = (await api().listWorkspaces?.()) ?? [];
    const meta = await readMeta();
    const multi = list.filter((w) => (w.rootCount ?? 1) > 1);
    const out: CodeWorkspace[] = [];
    for (const [i, w] of multi.entries()) {
      const roots = (await api().getWorkspaceRoots?.(w.path).catch(() => null)) ?? [w.path];
      if (roots.length < 2) continue;
      const m = meta[w.path] ?? {};
      out.push({ primary: w.path, name: m.name || `${w.name || baseName(w.path)} 等 ${roots.length} 个`, roots, color: m.color ?? WS_COLORS[i % WS_COLORS.length]! });
    }
    cache = out;
    emit();
  } catch { /* 读不到沿用上一份 */ }
  return cache;
}

export function useCodeWorkspaces(enabled = true): CodeWorkspace[] {
  const [v, setV] = useState(cache);
  useEffect(() => {
    if (!enabled) return;
    const on = () => setV(cache);
    listeners.add(on);
    void refreshCodeWorkspaces();
    return () => { listeners.delete(on); };
  }, [enabled]);
  return v;
}

/** 这个项目在哪个工作区里 */
export function workspaceOf(projectPath: string, list: readonly CodeWorkspace[]): CodeWorkspace | undefined {
  return list.find((w) => w.roots.some((r) => sameWorkspace(r, projectPath)));
}

/**
 * 写一个工作区: 名字 / 颜色 / 项目 (第一个是主项目)。
 * 同一个项目只在一个工作区里 —— 被拉进来的项目先从别的工作区里移出。
 * 返回每个被改到的主项目和它的新根, 调用方据此同步当前工作区 (appStore.applyWorkspacePatch)。
 */
export async function saveCodeWorkspace(
  ws: { primary?: string; name: string; color: string; roots: string[] },
): Promise<Array<{ primary: string; roots: string[]; name?: string }>> {
  const roots = ws.roots.filter((r, i, a) => a.findIndex((x) => sameWorkspace(x, r)) === i);
  if (roots.length === 0) return [];
  const primary = roots[0]!;
  const changed: Array<{ primary: string; roots: string[]; name?: string }> = [];
  /* 先从别的工作区里摘掉 (主项目换了的话, 旧主项目那份也清掉) */
  for (const other of cache) {
    if (ws.primary && sameWorkspace(other.primary, ws.primary)) {
      if (!sameWorkspace(other.primary, primary)) {
        await api().setWorkspaceRoots?.(other.primary, [other.primary]);
        changed.push({ primary: other.primary, roots: [other.primary] });
      }
      continue;
    }
    if (sameWorkspace(other.primary, primary)) continue;
    const kept = other.roots.filter((r) => !roots.some((x) => sameWorkspace(x, r)));
    if (kept.length !== other.roots.length) {
      const next = kept.length > 0 && sameWorkspace(kept[0]!, other.primary) ? kept : [other.primary];
      await api().setWorkspaceRoots?.(other.primary, next);
      changed.push({ primary: other.primary, roots: next });
    }
  }
  const persisted = (await api().setWorkspaceRoots?.(primary, roots)) ?? roots;
  changed.push({ primary, roots: persisted });
  const meta = await readMeta();
  if (ws.primary && !sameWorkspace(ws.primary, primary)) delete meta[ws.primary];
  meta[primary] = { color: ws.color, name: ws.name.trim() || undefined };
  await api().uiStateSet?.(META_KEY, meta);
  await refreshCodeWorkspaces();
  return changed;
}

/** 解散: 主项目只剩自己, 其它项目都还在 */
export async function dissolveCodeWorkspace(primary: string): Promise<Array<{ primary: string; roots: string[] }>> {
  await api().setWorkspaceRoots?.(primary, [primary]);
  const meta = await readMeta();
  delete meta[primary];
  await api().uiStateSet?.(META_KEY, meta);
  await refreshCodeWorkspaces();
  return [{ primary, roots: [primary] }];
}

/** 新工作区默认用一个还没被用的颜色 */
export function nextWorkspaceColor(list: readonly CodeWorkspace[]): string {
  return WS_COLORS.find((c) => !list.some((w) => w.color === c)) ?? WS_COLORS[list.length % WS_COLORS.length]!;
}
