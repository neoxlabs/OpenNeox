import { useEffect, useState } from 'react';
import { sameWorkspace } from '../../utils/pathUtils';
import projCup from '../../media/clay/proj-cup.webp';
import projBulb from '../../media/clay/proj-bulb.webp';
import projRocket from '../../media/clay/proj-rocket.webp';
import projLeaf from '../../media/clay/proj-leaf.webp';
import projCube from '../../media/clay/proj-cube.webp';
import projBox from '../../media/clay/proj-box.webp';
import projPlanet from '../../media/clay/proj-planet.webp';
import projGear from '../../media/clay/proj-gear.webp';

export interface WorkProject {
  dir: string;
  name: string;
  icon: string;
  pinned: boolean;
  archived: boolean;
  createdAt: number;
}

export const PROJECT_ART: Record<string, string> = {
  cup: projCup, bulb: projBulb, rocket: projRocket, leaf: projLeaf, cube: projCube, box: projBox, planet: projPlanet, gear: projGear,
};
export const projectArt = (icon: string) => PROJECT_ART[icon] ?? projCup;

type Api = {
  workProjectList?: () => Promise<{ ok?: boolean; projects?: WorkProject[] }>;
  workProjectCreate?: (name: string) => Promise<{ ok?: boolean; project?: WorkProject; error?: string }>;
  workProjectUpdate?: (dir: string, patch: Partial<Pick<WorkProject, 'pinned' | 'archived' | 'icon' | 'name'>>) => Promise<{ ok?: boolean; project?: WorkProject; error?: string }>;
  workProjectAssignTask?: (sessionId: string, dir: string | null) => Promise<{ ok?: boolean; taskDir?: string | null; error?: string }>;
  uiStateGet?: (k: string) => Promise<{ value?: unknown }>;
  uiStateSet?: (k: string, v: unknown) => Promise<unknown>;
};
const api = (): Api => ((window as { neox?: Api }).neox ?? {});

/* ── 项目列表: 模块级缓存 + 订阅, 侧栏 / 浮层 / 总览页共用一份 ── */
let projects: WorkProject[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export async function refreshWorkProjects(): Promise<WorkProject[]> {
  try {
    const r = await api().workProjectList?.();
    if (r?.ok && Array.isArray(r.projects)) { projects = r.projects; emit(); }
  } catch { /* 读不到就沿用上一份 */ }
  return projects;
}

export function useWorkProjects(enabled = true): WorkProject[] {
  const [list, setList] = useState(projects);
  useEffect(() => {
    if (!enabled) return;
    const on = () => setList(projects);
    listeners.add(on);
    void refreshWorkProjects();
    return () => { listeners.delete(on); };
  }, [enabled]);
  return list;
}

export async function createWorkProject(name: string): Promise<WorkProject | null> {
  const r = await api().workProjectCreate?.(name);
  if (!r?.ok || !r.project) throw new Error(r?.error || '新建项目失败');
  await refreshWorkProjects();
  return r.project;
}

export async function updateWorkProject(dir: string, patch: Partial<Pick<WorkProject, 'pinned' | 'archived' | 'icon' | 'name'>>): Promise<WorkProject | null> {
  const r = await api().workProjectUpdate?.(dir, patch);
  if (!r?.ok) throw new Error(r?.error || '改项目失败');
  await refreshWorkProjects();
  if (r.project && filter && sameWorkspace(filter, dir) && r.project.dir !== dir) setWorkProjectFilter(r.project.dir);
  if (patch.archived && filter && sameWorkspace(filter, dir)) setWorkProjectFilter(null);
  return r.project ?? null;
}

export async function assignTaskToProject(sessionId: string, dir: string | null): Promise<string | null> {
  const r = await api().workProjectAssignTask?.(sessionId, dir);
  return r?.ok ? (r.taskDir ?? null) : null;
}

/* ── 「最近」正在看的项目 (null = 全部任务) ── */
const FILTER_KEY = 'work:project-filter';
let filter: string | null = null;
let filterLoaded = false;
const filterListeners = new Set<() => void>();

export function getWorkProjectFilter(): string | null { return filter; }

export function setWorkProjectFilter(dir: string | null): void {
  filter = dir;
  filterListeners.forEach((l) => l());
  void api().uiStateSet?.(FILTER_KEY, dir ?? '');
}

export function useWorkProjectFilter(): string | null {
  const [v, setV] = useState(filter);
  useEffect(() => {
    const on = () => setV(filter);
    filterListeners.add(on);
    if (!filterLoaded) {
      filterLoaded = true;
      void api().uiStateGet?.(FILTER_KEY).then((r) => {
        const val = typeof r?.value === 'string' && r.value ? r.value : null;
        if (val !== filter) { filter = val; filterListeners.forEach((l) => l()); }
      }).catch(() => { /* 默认全部 */ });
    }
    return () => { filterListeners.delete(on); };
  }, []);
  return v;
}

/** 任务属于哪个项目: 任务文件夹的上一级是项目文件夹; 还没开工的「<项目>/」就是项目本身 */
export function projectOfTask(taskDir: string | null | undefined, list: readonly WorkProject[]): WorkProject | undefined {
  if (!taskDir) return undefined;
  const pending = /[\\/]$/.test(taskDir);
  const trimmed = taskDir.replace(/[\\/]+$/, '');
  const dir = pending ? trimmed : trimmed.replace(/[\\/][^\\/]+$/, '');
  return list.find((p) => sameWorkspace(p.dir, dir));
}

/** 每个项目下的任务 (新的在前): 全部项目页 / 项目主页用 */
export function tasksByProject<T extends { id: string; taskDir?: string | null; updatedAt?: number; createdAt?: number }>(
  sessions: readonly T[],
  list: readonly WorkProject[],
): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const s of sessions) {
    const p = projectOfTask(s.taskDir, list);
    if (!p) continue;
    const arr = m.get(p.dir) ?? [];
    arr.push(s);
    m.set(p.dir, arr);
  }
  const ts = (s: T) => s.updatedAt ?? s.createdAt ?? 0;
  for (const arr of m.values()) arr.sort((a, b) => ts(b) - ts(a));
  return m;
}

/** 「10-13」/ 今天写时间 —— 跟侧栏「最近」同一种写法 */
export function shortDay(ts?: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  if (d.toDateString() === now.toDateString()) return `${p(d.getHours())}:${p(d.getMinutes())}`;
  const md = `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}-${md}`;
}

/** 浮层里的分组: 置顶 / 最近用过 (最多 3) / 其他 (按名称) —— 项目多了也找得到。归档的不出现 */
export function groupProjects(list: readonly WorkProject[], lastUsed: ReadonlyMap<string, number>): { pinned: WorkProject[]; recent: WorkProject[]; rest: WorkProject[] } {
  const live = list.filter((p) => !p.archived);
  const pinned = live.filter((p) => p.pinned).sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  const others = live.filter((p) => !p.pinned);
  const used = (p: WorkProject) => lastUsed.get(p.dir) ?? 0;
  const recent = [...others].filter((p) => used(p) > 0).sort((a, b) => used(b) - used(a)).slice(0, 3);
  const rest = others.filter((p) => !recent.includes(p)).sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  return { pinned, recent, rest };
}
