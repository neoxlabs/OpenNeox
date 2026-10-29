/**
 * workspaceFsEventLog — 单例事件流, 缓存 renderer 收到的 workspace fs 事件.
 *
 * 【2026-07 WriteLedger 定型】本 log **只服务 viewer 热重载** (PPT/文档被真改后刷新).
 * 「本轮改动」membership 由 WriteDeclaration / WriteLedger 决定, **禁止**再用
 * getFsEventsBetween 时间窗猜哪些路径算 Agent 本轮作品.
 *
 * Shell 进程树写回收 (shell_proc) 可短暂借用本 log 的时间切片, 但结果必须立刻
 * 写成 WriteDeclaration / entry.declaredPaths, 聚合层仍只认声明.
 *
 * 事件缓存
 * --------
 * 每条: { path (绝对), kind, ts }. 环形 buffer 上限 2000.
 *
 * lockfile / 噪音过滤
 * -------------------
 * .~xxx.pptx · ~$xxx.docx · .DS_Store · node_modules 等收事件时砍.
 *
 * 生命周期
 * --------
 * 单例; session 切换时 clearFsEventLog().
 */

export type FsEventKind = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';

export interface WorkspaceFsEvent {
  path: string; /* 绝对路径 */
  kind: FsEventKind;
  ts: number; /* ms epoch */
}

const MAX_EVENTS = 2000;

/* 过滤: 编辑器 lockfile 一律不进 log — 那是打开 pptx/docx 的 side effect, 不是 agent 产物 */
function isEditorLockfile(pathStr: string): boolean {
  if (!pathStr) return false;
  const base = pathStr.split(/[\\/]/).pop() || '';
  /* WPS: .~xxx.pptx · MS Office: ~$xxx.docx / ~$xxx.xlsx · Vim swap: .foo.swp */
  return base.startsWith('.~') || base.startsWith('~$') || /\.swp$|\.swo$|~$/.test(base);
}

/* 目录 / 顶级噪音文件 — 也一律不进 log */
function isPathNoise(pathStr: string): boolean {
  if (!pathStr) return true;
  const parts = pathStr.split(/[\\/]/);
  const base = parts[parts.length - 1] || '';
  if (base === '.DS_Store' || base === 'Thumbs.db' || base === 'desktop.ini') return true;
  /* 命中任一路径段是 node_modules / .git / dist / build 直接跳 */
  for (const p of parts) {
    if (p === 'node_modules' || p === '.git' || p === '.neox' || p === 'dist' || p === 'build') return true;
  }
  return false;
}

const buffer: WorkspaceFsEvent[] = [];
type Listener = (ev: WorkspaceFsEvent) => void;
const listeners = new Set<Listener>();
let wired = false;

function push(ev: WorkspaceFsEvent): void {
  if (isEditorLockfile(ev.path) || isPathNoise(ev.path)) return;
  buffer.push(ev);
  if (buffer.length > MAX_EVENTS) buffer.splice(0, buffer.length - MAX_EVENTS);
  for (const cb of listeners) {
    try { cb(ev); } catch { /* listener 挂了不能带崩其他 */ }
  }
}

/**
 * 挂 IPC 订阅. 幂等 · 单例. 在 renderer 早期调一次 (譬如 NeoxRuntimeBridge / App 顶层),
 * 不要挂在 React 组件的 useEffect 里 (组件重挂载 → 双订阅).
 */
export function wireWorkspaceFsEventLog(): void {
  if (wired) return;
  wired = true;
  const neox = (window as unknown as { neox?: {
    onWorkspaceFsEvent?: (cb: (e: { kind: FsEventKind; path: string }) => void) => (() => void) | undefined;
  } }).neox;
  if (!neox?.onWorkspaceFsEvent) return;
  neox.onWorkspaceFsEvent((e) => {
    push({ path: e.path, kind: e.kind, ts: Date.now() });
  });
}

/** 拿指定时间窗口内的事件 (含端点). shell_proc 回收用; 禁止作 turn membership. */
export function getFsEventsBetween(startTs: number, endTs: number): WorkspaceFsEvent[] {
  return buffer.filter((e) => e.ts >= startTs && e.ts <= endTs);
}

export function registerFsEventTestHook(): void {
  if (!import.meta.env.DEV) return;
  (window as unknown as Record<string, unknown>).__neoxFsEventTestHook = {
    inject: (events: Array<{ path: string; kind: FsEventKind }>) => {
      for (const e of events) push({ path: e.path, kind: e.kind, ts: Date.now() });
      return buffer.length;
    },
    size: () => buffer.length,
  };
}

/** 拿全部 (debug). */
export function getAllFsEvents(): WorkspaceFsEvent[] {
  return buffer.slice();
}

/** 订阅实时流. 返 unsubscribe. */
export function subscribeFsEvents(cb: Listener): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** 清缓存 (session 切换 / 测试用). */
export function clearFsEventLog(): void {
  buffer.length = 0;
}
