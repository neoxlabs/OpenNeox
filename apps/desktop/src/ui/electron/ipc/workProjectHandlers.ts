import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, type Dirent } from 'node:fs';
import path from 'node:path';
import { ipcMain } from './ipcMainBridged.js';
import { getDatabase } from '@neoxlabs/platform/platform/database.js';
import { ensureModeHome } from '@neoxlabs/core/runtime/modeHome.js';
import { isInsideDir } from '../services/workTaskDir.js';

const MARKER = '.neox-project.json';
/** 新项目轮流用的陶土图标 (renderer media/clay/proj-*.webp) */
export const PROJECT_ICONS = ['cup', 'bulb', 'rocket', 'leaf', 'cube', 'box', 'planet', 'gear'] as const;

export interface WorkProject {
  dir: string;
  name: string;
  icon: string;
  pinned: boolean;
  archived: boolean;
  createdAt: number;
}

/** 项目口径 (work:Q-11) —— 同一个客户第二份材料不用再重说一遍。
 *  存在标记文件里, 由 writeInstructions 写进 .neox/INSTRUCTIONS.md; runtime 往上找项目指令时
 *  自动带上, 不另接注入。 */
export interface WorkProjectProfile {
  /** 给谁看 */
  audience?: string;
  /** 什么口吻 */
  tone?: string;
  /** 照哪个模板/格式 */
  template?: string;
  /** 禁写项: 不能出现的说法、数字、承诺 */
  forbidden?: string;
}

interface Marker { icon?: string; pinned?: boolean; archived?: boolean; createdAt?: number; profile?: WorkProjectProfile }

function readMarker(dir: string): Marker | null {
  try { return JSON.parse(readFileSync(path.join(dir, MARKER), 'utf8')) as Marker; } catch { return null; }
}

function toProject(dir: string, m: Marker): WorkProject {
  return {
    dir,
    name: path.basename(dir),
    icon: m.icon && (PROJECT_ICONS as readonly string[]).includes(m.icon) ? m.icon : PROJECT_ICONS[0],
    pinned: m.pinned === true,
    archived: m.archived === true,
    createdAt: m.createdAt ?? 0,
  };
}

export function listWorkProjects(home = ensureModeHome('work')): WorkProject[] {
  let names: string[] = [];
  try { names = readdirSync(home); } catch { return []; }
  const out: WorkProject[] = [];
  for (const n of names) {
    if (n.startsWith('.')) continue;
    const dir = path.join(home, n);
    const m = readMarker(dir);
    if (m) out.push(toProject(dir, m));
  }
  return out;
}

/** 项目名就是文件夹名: 去掉文件名不认的字符, 最多 40 字 */
export function cleanProjectName(raw: string): string {
  const s = String(raw ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
  return Array.from(s).slice(0, 40).join('').trim();
}

/** 落在工作目录第一层的项目文件夹才认 (挡掉渲染层传来的任意路径) */
function projectDirOrThrow(dir: string): string {
  const home = ensureModeHome('work');
  const d = path.resolve(String(dir ?? ''));
  if (path.dirname(d) !== path.resolve(home) || !readMarker(d)) throw new Error('不是工作目录下的项目');
  return d;
}

/* ── 项目说明 + 资料 ──
 * 说明原文存 .neox/notes.md; 给 agent 看的是 .neox/INSTRUCTIONS.md (说明 + 资料清单)。
 * runtime 的项目指令会往上级目录找 .neox/INSTRUCTIONS.md (kernel/core/projectInstructions.ts),
 * 项目里的任务文件夹就在项目文件夹下面, 所以每个任务自动带上, 不用另接注入。 */
const NOTES = path.join('.neox', 'notes.md');
const INSTRUCTIONS = path.join('.neox', 'INSTRUCTIONS.md');
const MATERIALS = '资料';

/** 四项口径的字段与上限 —— 太长会挤占项目指令的 20k 预算 */
export const PROFILE_FIELDS = ['audience', 'tone', 'template', 'forbidden'] as const;
const PROFILE_MAX = 200;

/** 单字段清洗: 去换行/多余空白, 截断 */
function cleanProfileValue(raw: unknown): string {
  return String(raw ?? '').replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, PROFILE_MAX);
}

/** 只留填了的项 —— 全空返回 undefined, 标记文件里就不写 profile */
export function cleanProfile(raw: unknown): WorkProjectProfile | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const src = raw as Record<string, unknown>;
  const out: WorkProjectProfile = {};
  for (const k of PROFILE_FIELDS) {
    const v = cleanProfileValue(src[k]);
    if (v) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

export interface ProjectMaterial { name: string; path: string; isDir: boolean; count?: number; mtime: number }

function readNotes(dir: string): string {
  try { return readFileSync(path.join(dir, NOTES), 'utf8'); } catch { return ''; }
}

function listMaterials(dir: string): ProjectMaterial[] {
  const root = path.join(dir, MATERIALS);
  let names: string[] = [];
  try { names = readdirSync(root); } catch { return []; }
  const out: ProjectMaterial[] = [];
  for (const n of names) {
    if (n.startsWith('.')) continue;
    const p = path.join(root, n);
    try {
      const st = statSync(p);
      const isDir = st.isDirectory();
      let count: number | undefined;
      if (isDir) { try { count = readdirSync(p).filter((x) => !x.startsWith('.')).length; } catch { /* 读不了就不写个数 */ } }
      out.push({ name: n, path: p, isDir, count, mtime: st.mtimeMs });
    } catch { /* 坏链接跳过 */ }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** 说明或资料变了就重写给 agent 看的那份。profile = 项目口径 (受众/口吻/模板/禁写项) */
export function composeInstructions(
  name: string,
  notes: string,
  materialsDir: string,
  materials: readonly ProjectMaterial[],
  profile?: WorkProjectProfile,
): string {
  const parts = [`# 项目：${name}`, '这个任务属于上面这个项目。下面是项目的长期约定和资料，做这个项目里的任何任务都照着来。'];
  if (notes.trim()) parts.push('## 项目说明', notes.trim());
  const p = cleanProfile(profile);
  if (p) {
    const rows: string[] = [];
    if (p.audience) rows.push(`- 受众：${p.audience}`);
    if (p.tone) rows.push(`- 口吻：${p.tone}`);
    if (p.template) rows.push(`- 模板：${p.template}`);
    if (p.forbidden) rows.push(`- 禁写：${p.forbidden}`);
    parts.push(
      '## 项目口径（做这个项目的任务直接用，不要再问用户）',
      rows.join('\n'),
      '以上口径来自项目设定（source=project）。本次任务的说法与它们冲突时以本次任务为准；没提到的项按这里的来，不要重复问用户。',
    );
  }
  if (materials.length) {
    parts.push('## 资料', `资料放在 ${materialsDir}${path.sep} ，需要时先去看：`, materials.map((m) => `- ${m.name}${m.isDir ? '/' : ''}`).join('\n'));
  }
  return parts.join('\n\n') + '\n';
}

function writeInstructions(dir: string): void {
  const notes = readNotes(dir);
  const mats = listMaterials(dir);
  const profile = readMarker(dir)?.profile;
  const file = path.join(dir, INSTRUCTIONS);
  if (!notes.trim() && mats.length === 0 && !cleanProfile(profile)) {
    try { writeFileSync(file, ''); } catch { /* 没建过就算了 */ }
    return;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, composeInstructions(path.basename(dir), notes, path.join(dir, MATERIALS), mats, profile));
}

/** 项目里一共多少个文件 (任务文件夹里的成品 + 资料), 不进 .neox, 最多数到 5000 */
function countFiles(dir: string): number {
  let n = 0;
  const walk = (d: string, depth: number) => {
    if (n >= 5000 || depth > 4) return;
    let ents: Dirent[] = [];
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) walk(path.join(d, e.name), depth + 1);
      else if (e.isFile()) n++;
    }
  };
  walk(dir, 0);
  return n;
}

function copyInto(src: string, destDir: string): void {
  let dest = path.join(destDir, path.basename(src));
  const ext = path.extname(dest);
  const base = dest.slice(0, dest.length - ext.length);
  for (let i = 2; existsSync(dest); i++) dest = `${base} (${i})${ext}`;
  cpSync(src, dest, { recursive: true });
}

function notifySessionsChanged(): void {
  void import('../mobile-bridge/index.js').then((m) => m.notifyDesktopSessionsChanged()).catch(() => { /* 下次刷新也会到 */ });
}

export function registerWorkProjectIpcHandlers(): void {
  ipcMain.handle('code-project:create', async (_e, rawName: string) => {
    try {
      const name = cleanProjectName(rawName);
      if (!name) return { ok: false, error: '项目名不能为空' };
      const dir = path.join(ensureModeHome('code'), name);
      if (existsSync(dir)) return { ok: false, error: '编码目录里已有同名文件夹' };
      mkdirSync(dir, { recursive: true });
      try {
        const { execFileSync } = await import('node:child_process');
        execFileSync('git', ['init', '-q'], { cwd: dir, timeout: 10_000, stdio: 'ignore' });
      } catch { /* 没装 git 也能用, 只是不是仓库 */ }
      return { ok: true, path: dir };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  });

  ipcMain.handle('work-project:list', async () => {
    try { return { ok: true, projects: listWorkProjects() }; } catch (e: any) { return { ok: false, error: e?.message ?? String(e), projects: [] }; }
  });

  /* 已有同名文件夹 (比如之前手动建的「Q3 报告」) 就把它认成项目, 不另建 */
  ipcMain.handle('work-project:create', async (_e, rawName: string) => {
    try {
      const name = cleanProjectName(rawName);
      if (!name) return { ok: false, error: '项目名不能为空' };
      const home = ensureModeHome('work');
      const dir = path.join(home, name);
      if (existsSync(dir) && !statSync(dir).isDirectory()) return { ok: false, error: '已有同名文件' };
      const existing = readMarker(dir);
      if (existing) return { ok: true, project: toProject(dir, existing) };
      mkdirSync(dir, { recursive: true });
      const used = new Set(listWorkProjects(home).map((p) => p.icon));
      const icon = PROJECT_ICONS.find((i) => !used.has(i)) ?? PROJECT_ICONS[listWorkProjects(home).length % PROJECT_ICONS.length]!;
      const marker: Marker = { icon, createdAt: Date.now() };
      writeFileSync(path.join(dir, MARKER), JSON.stringify(marker, null, 2));
      return { ok: true, project: toProject(dir, marker) };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  });

  /* 置顶 / 归档 / 换图标 / 改名。改名 = 改文件夹名, 项目里任务的 task_dir 跟着换前缀 */
  ipcMain.handle('work-project:update', async (_e, dir: string, patch: { pinned?: boolean; archived?: boolean; icon?: string; name?: string }) => {
    try {
      let d = projectDirOrThrow(dir);
      const m = readMarker(d) ?? {};
      if (typeof patch?.pinned === 'boolean') m.pinned = patch.pinned;
      if (typeof patch?.archived === 'boolean') m.archived = patch.archived;
      if (patch?.icon && (PROJECT_ICONS as readonly string[]).includes(patch.icon)) m.icon = patch.icon;
      writeFileSync(path.join(d, MARKER), JSON.stringify(m, null, 2));
      if (patch?.name !== undefined) {
        const name = cleanProjectName(patch.name);
        if (!name) return { ok: false, error: '项目名不能为空' };
        const next = path.join(path.dirname(d), name);
        if (next !== d) {
          if (existsSync(next)) return { ok: false, error: '已有同名文件夹' };
          renameSync(d, next);
          getDatabase().rebaseSessionTaskDirs(d + path.sep, next + path.sep);
          d = next;
          notifySessionsChanged();
        }
      }
      return { ok: true, project: toProject(d, m) };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  });

  /* 项目主页要的: 说明原文 / 资料 / 文件数 */
  ipcMain.handle('work-project:detail', async (_e, dir: string) => {
    try {
      const d = projectDirOrThrow(dir);
      return { ok: true, project: toProject(d, readMarker(d) ?? {}), notes: readNotes(d), materials: listMaterials(d), fileCount: countFiles(d), profile: readMarker(d)?.profile ?? {} };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  });

  ipcMain.handle('work-project:save-notes', async (_e, dir: string, notes: string) => {
    try {
      const d = projectDirOrThrow(dir);
      mkdirSync(path.join(d, '.neox'), { recursive: true });
      writeFileSync(path.join(d, NOTES), String(notes ?? ''));
      writeInstructions(d);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  });

  /* 项目口径: 受众 / 口吻 / 模板 / 禁写项。存标记文件, 并重写给 agent 看的 INSTRUCTIONS.md,
   * 项目里每个任务下一轮就自动带上 (见文件头注释)。 */
  ipcMain.handle('work-project:save-profile', async (_e, dir: string, profile: WorkProjectProfile) => {
    try {
      const d = projectDirOrThrow(dir);
      const m = readMarker(d) ?? {};
      const cleaned = cleanProfile(profile);
      if (cleaned) m.profile = cleaned;
      else delete m.profile;
      writeFileSync(path.join(d, MARKER), JSON.stringify(m, null, 2));
      writeInstructions(d);
      return { ok: true, profile: cleaned ?? {} };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  });

  /* 加资料: 传了路径 (拖进来的) 就拷这些, 没传就弹系统选文件 */
  ipcMain.handle('work-project:add-materials', async (event, dir: string, paths?: string[]) => {
    try {
      const d = projectDirOrThrow(dir);
      let list = Array.isArray(paths) ? paths.filter((p) => typeof p === 'string' && p) : [];
      if (list.length === 0) {
        /* electron 用时才取 (本文件也会在纯 Node 的桥里加载) */
        const { dialog, BrowserWindow } = await import('electron');
        const win = event?.sender ? BrowserWindow.fromWebContents(event.sender) : null;
        const opts = { properties: ['openFile' as const, 'openDirectory' as const, 'multiSelections' as const], title: '添加项目资料' };
        const picked = await (win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts));
        if (picked.canceled) return { ok: false, canceled: true };
        list = picked.filePaths;
      }
      const root = path.join(d, MATERIALS);
      mkdirSync(root, { recursive: true });
      for (const p of list) {
        /* 本来就在资料夹里的不重复拷 */
        if (path.dirname(path.resolve(p)) === root) continue;
        copyInto(p, root);
      }
      writeInstructions(d);
      return { ok: true, materials: listMaterials(d) };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  });

  /* 新建任务时选着项目: 定下这个任务落在哪个项目里。任务文件夹首条消息时才建 (workTaskDir.ts),
   * 这里只记「<项目>/」(以分隔符结尾 = 还没建)。已经开工的任务不挪 (文件夹和历史里的路径都在原处) */
  ipcMain.handle('work-project:assign-task', async (_e, sessionId: string, dir: string | null) => {
    try {
      const db = getDatabase();
      const cur = db.getSessionTaskDir(sessionId);
      if (cur && !/[\\/]$/.test(cur)) return { ok: false, error: 'already-started' };
      const next = dir ? projectDirOrThrow(dir) + path.sep : null;
      if (next && !isInsideDir(next.slice(0, -1), ensureModeHome('work'))) return { ok: false, error: '不是工作目录下的项目' };
      db.setSessionTaskDir(sessionId, next);
      notifySessionsChanged();
      return { ok: true, taskDir: next };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  });
}
