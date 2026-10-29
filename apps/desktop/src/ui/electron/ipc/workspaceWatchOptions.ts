
import { isWatchIgnoredDirSegment, WATCH_IGNORE_DIRS } from '@neoxlabs/kernel/platform/watchIgnoreSpec.js';

export type WorkspaceWatchBackend = 'fs-watch-recursive' | 'parcel' | 'none';

/** Windows 的 recursive fs.watch 就是 ReadDirectoryChangesW, 整树 1 句柄. */
export function preferNativeRecursiveFsWatch(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32';
}

/** 后端优先级。末尾一定是 'none' —— 降级是**显式**的, 不存在"悄悄换成全树轮询"。 */
export function workspaceWatchBackendOrder(platform: NodeJS.Platform = process.platform): WorkspaceWatchBackend[] {
  if (preferNativeRecursiveFsWatch(platform)) {
    return ['fs-watch-recursive', 'parcel', 'none'];
  }
  return ['parcel', 'none'];
}

export type WorkspaceFsEventKind = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';
export type ParcelWatchEventType = 'create' | 'update' | 'delete';

/**
 * parcel create/update/delete → 资源管理器 IPC 事件。
 * delete 时路径已不在, 无法区分文件/目录, 发 unlink; FileExplorer 刷新 parent 即可。
 */
export function translateParcelWatchEvent(
  type: ParcelWatchEventType,
  isDirectory: boolean,
): WorkspaceFsEventKind {
  if (type === 'create') return isDirectory ? 'addDir' : 'add';
  if (type === 'update') return 'change';
  return 'unlink';
}

/** 高频抖动 / 缓存 / 构建产物 —— 唯一真相源在 kernel (`watchIgnoreSpec`)。
 *  agent 侧 (core WatchCoordinator) 与 UI 侧共用同一份, 免得两侧漂移。 */
export const WORKSPACE_WATCH_IGNORE_DIRS: readonly string[] = WATCH_IGNORE_DIRS;

export function workspaceWatchParcelIgnoreGlobs(): string[] {
  const globs: string[] = [];
  for (const dir of WORKSPACE_WATCH_IGNORE_DIRS) {
    globs.push(`**/${dir}`, `**/${dir}/**`);
  }
  globs.push(
    '**/win-unpacked', '**/win-unpacked/**',
    '**/win-arm64-unpacked', '**/win-arm64-unpacked/**',
    '**/resources/node-runtime', '**/resources/node-runtime/**',
    '**/resources/node-runtime-active', '**/resources/node-runtime-active/**',
    '**/*.asar',
    '**/*.log', '**/*.tmp', '**/*.swp', '**/*.swo',
    '**/.DS_Store',
  );
  return globs;
}

export function watchPathLooksIgnored(filePath: string): boolean {
  const n = filePath.replace(/\\/g, '/');
  if (/\.(asar|log|tmp|swp|swo)$/i.test(n) || n.endsWith('/.DS_Store')) return true;
  if (n.includes('/resources/node-runtime')) return true;
  return n
    .split('/')
    .some((seg) => isWatchIgnoredDirSegment(seg) || /^(mac|win|linux)-(arm64|x64)(-unpacked)?$/.test(seg));
}

export function translateNativeFsWatchEvent(
  eventType: string,
  exists: boolean,
  isDirectory: boolean,
): WorkspaceFsEventKind {
  if (eventType === 'change') return 'change';
  if (exists) return isDirectory ? 'addDir' : 'add';
  return 'unlink';
}

/** 同一路径 50ms 内多次 rename/change 合成一次再 IPC, 避免 Flutter 热重载打满主线程. */
export const NATIVE_WATCH_COALESCE_MS = 50;

/**
 * 一批事件里的路径数上限。超过就**按父目录折叠**成一条 change, 不再逐路径 stat。
 *
 * 为什么必须有这个上限: 合批回调里每个路径都要 `existsSync` + `statSync`(同步!) 才能判
 * add/unlink/change, 而 `npm install` / Flutter 热重载这类操作一次能写出上万个文件 ——
 * 同步 stat 风暴会把主线程整秒钉死 (用户感受就是"打字卡住几秒")。
 * 折叠成父目录后语义不丢: 渲染层对任何事件都是 `refreshDir(parent)`, 重新列目录即可看到
 * 新增/删除。
 */
export const NATIVE_WATCH_MAX_PATHS_PER_FLUSH = 200;

export interface NativeWatchFlush {
  /** 需要上报的路径 (已去重)。collapsed=true 时是**父目录**, 按 change 处理即可。 */
  paths: string[];
  /** true 表示原始路径数超过上限, 已折叠到父目录。 */
  collapsed: boolean;
  /** 折叠时被丢弃的原始路径数 (用于日志/护栏)。 */
  droppedPaths: number;
}

export function createNativeWatchCoalescer(
  flush: (batch: NativeWatchFlush) => void,
  delayMs: number = NATIVE_WATCH_COALESCE_MS,
  maxPathsPerFlush: number = NATIVE_WATCH_MAX_PATHS_PER_FLUSH,
): { push: (filePath: string) => void; dispose: () => void } {
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fire = () => {
    timer = null;
    if (pending.size === 0) return;
    const all = [...pending];
    pending.clear();
    if (all.length <= maxPathsPerFlush) {
      flush({ paths: all, collapsed: false, droppedPaths: 0 });
      return;
    }
    const parents = new Set<string>();
    for (const p of all) {
      const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
      if (idx > 0) parents.add(p.slice(0, idx));
      if (parents.size >= maxPathsPerFlush) break;
    }
    flush({ paths: [...parents], collapsed: true, droppedPaths: all.length });
  };
  return {
    push(filePath: string) {
      pending.add(filePath);
      if (timer != null) return;
      timer = setTimeout(fire, delayMs);
    },
    dispose() {
      if (timer != null) clearTimeout(timer);
      timer = null;
      pending.clear();
    },
  };
}
