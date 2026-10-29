import { useSyncExternalStore } from 'react';
import { getGlobalLanguage } from '../hooks/useI18n';
import {
  getBackgroundTasks,
  hasServiceSnapshot,
  subscribeBackgroundTasks,
  worthSurfacing,
  type BackgroundTask,
} from './backgroundTasksStore';
import { getPanelLayout, setPanelLayout } from './panelLayoutStore';
import { getSurfaces } from './surfaceStore';

/* ── 自动显示方式 ─────────────────────────────────────────────────────── */

export type ServiceAutoShowMode = 'push' | 'float' | 'off';

export const DEFAULT_SERVICE_AUTO_SHOW_MODE: ServiceAutoShowMode = 'push';

const MODE_KEY = 'neox:services.autoShowMode';
const VALID_MODES: readonly ServiceAutoShowMode[] = ['push', 'float', 'off'];

function readMode(): ServiceAutoShowMode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    return VALID_MODES.includes(v as ServiceAutoShowMode)
      ? (v as ServiceAutoShowMode)
      : DEFAULT_SERVICE_AUTO_SHOW_MODE;
  } catch {
    /* 隐私窗口 / 读不到站点数据: 按默认 (右侧推开) 走, 不影响使用 */
    return DEFAULT_SERVICE_AUTO_SHOW_MODE;
  }
}

let currentMode: ServiceAutoShowMode = readMode();
const modeListeners = new Set<() => void>();

export function getServiceAutoShowMode(): ServiceAutoShowMode {
  return currentMode;
}

export function setServiceAutoShowMode(next: ServiceAutoShowMode): void {
  if (!VALID_MODES.includes(next) || next === currentMode) return;
  currentMode = next;
  try { localStorage.setItem(MODE_KEY, next); } catch { /* 存不下也照常生效, 只是重启回默认 */ }
  for (const fn of modeListeners) fn();
}

export function subscribeServiceAutoShowMode(fn: () => void): () => void {
  modeListeners.add(fn);
  return () => { modeListeners.delete(fn); };
}

/** 设置页的入口 —— 跟 panelLayoutStore 一样按机器存 (这是"我习惯怎么摆", 跟聊什么无关) */
export function useServiceAutoShowMode(): ServiceAutoShowMode {
  return useSyncExternalStore(
    subscribeServiceAutoShowMode,
    getServiceAutoShowMode,
    getServiceAutoShowMode,
  );
}

/* ── 快照 → 该弹谁 ───────────────────────────────────────────────────── */

export interface AutoShowTracker {
  /** 第一份快照只是基线 —— 应用启动时已经在跑的服务不该一开就弹一串面板 */
  primed: boolean;
  /** 已经自动打开过的 pid, 一个只弹一次 */
  announced: Set<number>;
}

export function createAutoShowTracker(): AutoShowTracker {
  return { primed: false, announced: new Set<number>() };
}

let defaultTracker: AutoShowTracker = createAutoShowTracker();

/** 这个进程值不值得自动弹面板 —— 身份判定不在这里, 见 backgroundTasksStore 的注释 */
function autoShowable(task: BackgroundTask, now: number): boolean {
  if (task.status !== 'running') return false;
  /* agent-task 是子 agent 的任务, 不是服务; free-shell 是用户自己敲的独立终端 */
  if (task.kind === 'agent-task' || task.kind === 'free-shell') return false;
  return worthSurfacing(task, now);
}

export function planAutoShow(
  tracker: AutoShowTracker,
  tasks: BackgroundTask[],
  now = Date.now(),
): BackgroundTask[] {
  if (!tracker.primed) {
    tracker.primed = true;
    for (const task of tasks) {
      if (task.status === 'running') tracker.announced.add(task.pid);
    }
    return [];
  }
  const due: BackgroundTask[] = [];
  for (const task of tasks) {
    if (tracker.announced.has(task.pid)) continue;
    if (!autoShowable(task, now)) continue;
    tracker.announced.add(task.pid);
    due.push(task);
  }
  return due;
}

/* ── 打开什么 ────────────────────────────────────────────────────────── */

/**
 * 一个服务对应哪些 surface 事件。
 *
 *   服务面板 (日志) 永远开; 有端口时再开一个浏览器预览页 —— 但**只在面板还空着**的时候
 *   (includePreview)。面板里已经开着别的产出时, 用户正在看东西, 多塞两个标签就是打扰;
 *   "新开标签不抢焦点"说的正是这种时候只多一个标签、不把人家正在看的换掉。
 *
 *   预览页不带 revealPanel: 它排在服务面板后面, 焦点留在日志那一页。
 */
export function buildAutoShowEvents(
  task: BackgroundTask,
  opts: { includePreview: boolean; zh?: boolean },
): Array<Record<string, unknown>> {
  const zh = opts.zh ?? getGlobalLanguage() === 'zh';
  const events: Array<Record<string, unknown>> = [];
  if (opts.includePreview && typeof task.port === 'number' && task.port > 0) {
    const url = `http://localhost:${task.port}`;
    events.push({
      kind: 'web',
      source: { type: 'url', url },
      title: `localhost:${task.port}`,
      pinned: true,
      byUser: false,
      revealPanel: false,
    });
  }
  events.push({
    kind: 'services',
    source: { type: 'inline', content: '' },
    title: zh ? '服务' : 'Services',
    pinned: true,
    metadata: { selectedPid: task.pid },
    byUser: false,
    /* 这就是"自动显示"本身: 面板要展开并停在服务这一页 */
    revealPanel: true,
  });
  return events;
}

export interface AutoShowDeps {
  mode: ServiceAutoShowMode;
  now?: number;
  /** 面板里是不是已经开着别的产出 —— 是的话不额外开预览页 */
  panelHasOtherSurfaces: boolean;
  dispatch: (detail: Record<string, unknown>) => void;
  /** float 模式: 把版面切成悬浮 (注入进来, 便于单测) */
  enterFloatLayout?: () => void;
}

/**
 * 一份快照进来后做什么。返回这一轮真正自动打开的服务 (测试和排查都用它)。
 *
 *   服务退出 (completed / failed / killed) 在这里没有任何分支 —— 面板停在"已退出",
 *   由用户自己决定什么时候关。
 */
export function applySnapshot(
  tasks: BackgroundTask[],
  deps: AutoShowDeps,
  tracker: AutoShowTracker = defaultTracker,
): BackgroundTask[] {
  const due = planAutoShow(tracker, tasks, deps.now);
  if (deps.mode === 'off' || due.length === 0) return [];
  if (deps.mode === 'float') deps.enterFloatLayout?.();
  for (const task of due) {
    for (const ev of buildAutoShowEvents(task, { includePreview: !deps.panelHasOtherSurfaces })) {
      try { deps.dispatch(ev); } catch { /* 单条失败不影响下一个服务 */ }
    }
  }
  return due;
}

/* ── 接到真实世界 ────────────────────────────────────────────────────── */

function dispatchOpenSurface(detail: Record<string, unknown>): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('neox:open-surface', { detail }));
}

function enterFloatLayout(): void {
  /* 版面「悬浮」= Surface 浮在对话上 (SurfaceFloatFrame), 不挤窄对话。用户在这一项里
   * 选了悬浮, 就是明确要这种显示方式; 已经是悬浮就不再动。 */
  if (getPanelLayout() !== 'float') setPanelLayout('float');
}

let wired: (() => void) | null = null;

/**
 * 开始监听服务快照。由 NeoxRuntimeBridge 在挂载时调一次, 返回解绑函数。
 *
 *   getSessionId: 当前会话 id —— 用来判断"面板里是不是已经开着别的产出"。
 */
export function initServiceAutoShow(
  opts: { getSessionId?: () => string | undefined } = {},
): () => void {
  if (wired) return wired;

  const run = (): void => {
    const tasks = getBackgroundTasks();
    /* 还没收到过任何快照时不当作基线 —— 否则第一份真快照里的存量服务会被当成
     * "新起的"全弹一遍。注意判据是"收到过快照", 不是"列表非空": 一份空快照就是明确的
     * 基线 (此刻一个服务都没有), 之后起来的第一条才该弹。 */
    if (!defaultTracker.primed && !hasServiceSnapshot()) return;
    const sid = opts.getSessionId?.();
    const openSurfaces = sid ? getSurfaces(sid) : [];
    applySnapshot(tasks, {
      mode: getServiceAutoShowMode(),
      panelHasOtherSurfaces: openSurfaces.length > 0,
      dispatch: dispatchOpenSurface,
      enterFloatLayout,
    });
  };

  const off = subscribeBackgroundTasks(run);
  run();
  wired = () => {
    off();
    wired = null;
    defaultTracker = createAutoShowTracker();
  };
  return wired;
}

/** 调试 / 测试用 */
export function resetServiceAutoShowForTest(): void {
  defaultTracker = createAutoShowTracker();
  wired?.();
  wired = null;
  currentMode = readMode();
}
