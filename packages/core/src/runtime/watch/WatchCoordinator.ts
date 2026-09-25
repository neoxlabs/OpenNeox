
import * as fsSync from 'fs';
import * as path from 'path';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
/* 忽略目录清单的**唯一真相源**在 kernel —— 与 desktop 资源管理器 watcher 共用同一份,
 * 免得两侧漂移成"agent 能看见、界面看不见"(见 watchIgnoreSpec 头注释)。 */
import { isWatchIgnoredDirSegment, WATCH_IGNORE_DIRS, WATCH_IGNORE_DIR_SUFFIXES } from '@neoxlabs/kernel/platform/watchIgnoreSpec.js';
import type * as parcelWatcher from '@parcel/watcher';
/* @parcel/watcher 的纯 JS 外壳 (normalizeOptions + createWrapper), 不含 native。
 * 编译版要靠它把 sidecar watcher.node 包成正常 API。 */
import * as parcelWrapper from '@parcel/watcher/wrapper.js';
import type { ParcelSubscribe } from '@neoxlabs/platform';

/**
 * worker 线程里由入口注入 —— 订阅转给主线程代办 (见 hostedWatcher.ts: watcher.node 的
 * 原生层是全进程共享的, 被回收的 worker 会在里面留下悬空回调, 把整个进程带走)。
 */
let subscribeOverride: ParcelSubscribe | null = null;

export function setWatchSubscribeOverride(subscribe: ParcelSubscribe | null): void {
  subscribeOverride = subscribe;
}

export async function loadParcelWatcher(): Promise<typeof parcelWatcher> {
  if (typeof (process.versions as any)?.bun === 'string') {
    try {
      const sidecar = path.join(path.dirname(process.execPath), 'watcher.node');
      if (fsSync.existsSync(sidecar)) {
        const { createRequire } = await import('node:module');
        const req = createRequire(import.meta.url);
        const binding = req(sidecar);
        const { createWrapper } = parcelWrapper;
        cliLogger.info('WATCH', `sidecar watcher.node loaded (${sidecar})`);
        return createWrapper(binding) as typeof parcelWatcher;
      }
      cliLogger.warn('WATCH', `编译版但没找到 sidecar watcher.node (${sidecar}) — 文件监听会降级`);
    } catch (err: any) {
      cliLogger.warn('WATCH', `sidecar watcher.node 加载失败, 回落包内路径: ${err?.message ?? err}`);
    }
  }
  return import('@parcel/watcher');
}

// ─── Smart watch candidate helpers (供外部 bridge 用) ────────────────────────
//
// 旧 chokidar 时代这两个函数用来限缩 chokidar 的 add() 范围, 防 fd 爆.
// 换 @parcel/watcher 后 fd 不再是问题, 但消费者 (semantic/embedding 索引)
// 仍想知道 "哪些子目录算项目核心" — 用于 startup 扫描 / progress 估算等场景.
// 不再在 WatchCoordinator 内部使用.

const SMART_WATCH_DIRS = [
  'src', 'app', 'apps', 'lib', 'libs', 'packages', 'modules', 'services', 'docs', 'scripts',
  'config', 'configs', 'server', 'client', 'clients', 'backend', 'frontend', 'cmd', 'crates', 'examples',
];

const SMART_WATCH_FILES = [
  'package.json', 'tsconfig.json', 'tsconfig.base.json', 'pnpm-workspace.yaml', 'turbo.json',
  'vite.config.ts', 'vite.config.js', 'README.md', 'Cargo.toml', 'go.mod', 'pyproject.toml',
];

const SMART_WATCH_ROOT_BUDGET = 24;
const SMART_WATCH_CUSTOM_ROOT_BUDGET = 8;
const PROACTIVE_SMART_ROOT_THRESHOLD = 4;

export interface SmartWatchRootOptions {
  budget?: number;
  customBudget?: number;
}

function scoreSmartCandidate(rootDir: string, candidatePath: string): number {
  const rel = path.relative(rootDir, candidatePath).replace(/\\/g, '/');
  if (!rel || rel === '.') return -1000;
  if (!rel.includes('/')) {
    const dIdx = SMART_WATCH_DIRS.indexOf(rel);
    if (dIdx >= 0) return dIdx;
    const fIdx = SMART_WATCH_FILES.indexOf(rel);
    if (fIdx >= 0) return 100 + fIdx;
    return 200 + rel.length;
  }
  return 400 + rel.split('/').length * 10 + rel.length;
}

function pathLooksIgnored(p: string): boolean {
  const segments = p.split(path.sep).filter(Boolean);
  for (const seg of segments) {
    if (isWatchIgnoredDirSegment(seg)) return true;
  }
  return false;
}

/** 返回 root 下"看起来像项目核心"的目录 / 关键文件列表 (绝对路径).
 *  入选优先级: SMART_WATCH_DIRS 命中 > SMART_WATCH_FILES 命中 > 其他顶层条目 (custom).
 *  options.budget 默认 24, customBudget 默认 8 (custom 类型上限).
 *  ignored 目录 (node_modules/.git/...) 永不返回. root 自身不在返回内. */
export function computeSmartWorkspaceWatchRoots(
  rootDir: string,
  options?: SmartWatchRootOptions,
): string[] {
  const root = path.resolve(rootDir);
  const budget = Math.max(1, options?.budget ?? SMART_WATCH_ROOT_BUDGET);
  const customBudget = Math.max(0, Math.min(budget, options?.customBudget ?? SMART_WATCH_CUSTOM_ROOT_BUDGET));
  const candidates = new Map<string, string>();

  const push = (p: string) => {
    if (pathLooksIgnored(p)) return;
    candidates.set(p.replace(/\\/g, '/'), p);
  };

  for (const name of SMART_WATCH_DIRS) {
    const fp = path.join(root, name);
    try { if (fsSync.statSync(fp).isDirectory()) push(fp); } catch { /* skip */ }
  }
  for (const name of SMART_WATCH_FILES) {
    const fp = path.join(root, name);
    try { if (fsSync.statSync(fp).isFile()) push(fp); } catch { /* skip */ }
  }
  try {
    for (const entry of fsSync.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isFile()) continue;
      push(path.join(root, entry.name));
    }
  } catch { /* skip */ }

  const sorted = [...candidates.values()].sort((a, b) => {
    const d = scoreSmartCandidate(root, a) - scoreSmartCandidate(root, b);
    return d !== 0 ? d : a.localeCompare(b);
  });

  const selected: string[] = [];
  let customCount = 0;
  for (const candidate of sorted) {
    if (selected.length >= budget) break;
    const score = scoreSmartCandidate(root, candidate);
    const isCustom = score >= 200;
    if (isCustom && customCount >= customBudget) continue;
    selected.push(candidate);
    if (isCustom) customCount++;
  }
  return selected;
}

/** rootDir 是否应该优先用 smart 模式 — 当 SMART_WATCH_DIRS 命中达到阈值时. */
export function shouldPreferSmartWorkspaceWatchRoots(rootDir: string): boolean {
  const root = path.resolve(rootDir);
  let hits = 0;
  for (const name of SMART_WATCH_DIRS) {
    try {
      if (fsSync.statSync(path.join(root, name)).isDirectory()) {
        if (++hits >= PROACTIVE_SMART_ROOT_THRESHOLD) return true;
      }
    } catch { /* skip */ }
  }
  return false;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type WatchEventKind = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';

export interface WatchEvent {
  kind: WatchEventKind;
  /** 绝对路径 */
  filePath: string;
  /** 相对于 workspace root 的路径 */
  relativePath: string;
  timestamp: number;
}

export type WatchSubscriberCallback = (events: WatchEvent[]) => void;

export interface WatchSubscriberOptions {
  /** 订阅者名称（调试用） */
  name: string;
  /** 只关心特定类型的事件，默认全部 */
  kinds?: WatchEventKind[];
  /** 仅监听这些根目录；不传则监听整个 workspace root */
  watchRoots?: string[];
  /** 自定义文件过滤，返回 true 表示需要此事件 */
  fileFilter?: (relativePath: string, kind: WatchEventKind) => boolean;
  /** 独立 debounce 窗口 ms，默认 300 */
  debounceMs?: number;
}

// ─── Default ignore patterns ──────────────────────────────────────────────────

/** 一级目录黑名单 — 任意层级出现即忽略整个子树. 定义在 kernel/watchIgnoreSpec (单一真相源),
 *  传给 parcel/watcher 时转 '**\/<name>/**'. */
const DEFAULT_IGNORED_DIRS = WATCH_IGNORE_DIRS;

/** macOS bundle / archive 目录后缀 — segment endsWith 命中即忽略整个子树.
 *  parcel/watcher 没原生 endsWith glob, 转 '**\/*<suffix>/**' picomatch 支持。 */
const DEFAULT_IGNORED_DIR_SUFFIXES = WATCH_IGNORE_DIR_SUFFIXES;

const DEFAULT_IGNORED_EXTENSIONS = [
  '.log', '.tmp', '.swp', '.swo',
  /* archive */
  '.asar', '.dmg', '.iso', '.pkg', '.deb', '.rpm',
  '.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar',
  '.jar', '.war', '.ear', '.apk', '.aab', '.ipa',
  /* 大体量二进制 */
  '.mp4', '.mov', '.avi', '.mkv', '.webm',
  '.psd', '.ai', '.sketch',
  '.sqlite', '.db', '.mdb',
];

const DEFAULT_IGNORED_FILES = ['.DS_Store'];

/** 把上面四组黑名单转成 parcel/watcher 的 ignore (picomatch glob) 列表. */
function buildDefaultIgnoreGlobs(extra: string[] = []): string[] {
  const globs: string[] = [];
  for (const dir of DEFAULT_IGNORED_DIRS) {
    globs.push(`**/${dir}`, `**/${dir}/**`);
  }
  for (const suf of DEFAULT_IGNORED_DIR_SUFFIXES) {
    /* '*.app' 整目录 + 其下任意 */
    globs.push(`**/*${suf}`, `**/*${suf}/**`);
  }
  for (const ext of DEFAULT_IGNORED_EXTENSIONS) {
    globs.push(`**/*${ext}`);
  }
  for (const file of DEFAULT_IGNORED_FILES) {
    globs.push(`**/${file}`);
  }
  for (const e of extra) {
    /* 调用方传相对路径 → 转 glob. 已经带通配符就原样保留. */
    if (e.includes('*') || e.includes('?')) globs.push(e);
    else globs.push(e, `${e}/**`);
  }
  return globs;
}

// ─── Subscriber ───────────────────────────────────────────────────────────────

interface Subscriber {
  id: number;
  options: WatchSubscriberOptions;
  callback: WatchSubscriberCallback;
  buffer: WatchEvent[];
  timer: ReturnType<typeof setTimeout> | null;
  /** 预算化过的 watchRoots (绝对路径, 规范化) — 用于 dispatch 时的子目录过滤. */
  normalizedRoots: string[] | null;
}

// ─── WatchCoordinator ─────────────────────────────────────────────────────────

export class WatchCoordinator {
  private subscription: parcelWatcher.AsyncSubscription | null = null;
  private subscribers = new Map<number, Subscriber>();
  private nextId = 1;
  private rootDir: string | null = null;
  private started = false;
  private startupPromise: Promise<void> | null = null;
  private extraIgnorePatterns: string[] = [];

  /** 文件监听是否降级(原生 watcher 加载/订阅失败)。降级后订阅者收不到 fs 事件。 */
  private degraded = false;
  private degradedReason: string | null = null;

  /** 文件监听是否处于降级状态(供上层 UI / 健康检查查询) */
  isDegraded(): boolean { return this.degraded; }
  /** 降级原因(未降级返回 null) */
  getDegradedReason(): string | null { return this.degradedReason; }

  /**
   * 启动 watcher。整个生命周期只需调用一次。
   *
   * 注意: parcel/watcher subscribe 是 async, 但本方法保持同步签名以兼容老调用方.
   * 真实 subscription 在后台建立, dispatch 在它 ready 后开始; 中间到达的事件
   * 由 parcel 自己 buffer (FSEvents/inotify 内核级 queue).
   */
  start(rootDir: string, options?: { extraIgnore?: string[] }): void {
    if (this.started) {
      if (this.rootDir === rootDir) return;
      void this.stop().then(() => this.start(rootDir, options));
      return;
    }

    this.rootDir = path.resolve(rootDir);
    this.started = true;
    if (options?.extraIgnore) {
      this.extraIgnorePatterns.push(...options.extraIgnore);
    }

    /* parcel/watcher.subscribe 是 async. 把 promise 留着 — stop() 要等它 settle 才能干净 unsubscribe. */
    this.startupPromise = this.startSubscription();
  }

  private async startSubscription(): Promise<void> {
    if (!this.rootDir) return;
    try {
      const ignore = buildDefaultIgnoreGlobs(this.extraIgnorePatterns);
      // 懒加载原生 watcher — 加载失败 (编译版没嵌入 / 平台不支持) 时本 try 兜底, server 不受影响, 仅文件监听降级
      const subscribe: ParcelSubscribe = subscribeOverride ?? (await loadParcelWatcher()).subscribe;
      this.subscription = await subscribe(
        this.rootDir,
        (err, events) => {
          if (err) {
            console.error('[WatchCoordinator] parcel watcher error:', err);
            return;
          }
          for (const ev of events) {
            this.dispatch(this.translateEvent(ev));
          }
        },
        { ignore },
      );
      // 订阅成功 — 清除任何历史降级标记
      this.degraded = false;
      this.degradedReason = null;
      cliLogger.debug('WatchCoordinator', 'subscribed', {
        rootDir: this.rootDir,
        ignoreGlobs: ignore.length,
      });
    } catch (e: any) {
      // 降级不再静默:console.error 会被 Ink/patch-console 吞掉 → 用户与排障都看不到。
      // 同步写日志文件(cliLogger)并标记 degraded, 让"文件监听失效"可被本地定位。
      this.degraded = true;
      this.degradedReason = e?.message ?? String(e);
      console.error('[WatchCoordinator] failed to subscribe', e);
      cliLogger.warn('WATCH', `⚠️ File watcher subscribe failed — file watching DEGRADED (subscribers will not receive fs events)`, {
        rootDir: this.rootDir,
        error: this.degradedReason,
        stack: e?.stack,
      });
    }
  }

  /** parcel event ({path, type:create|update|delete}) → 内部 WatchEvent.
   *  file vs dir 区分: create/update 用 statSync 试; delete 时文件已没, 默认按 file 处理
   *  (空 dir 删除事件无法精准还原, 但项目里几乎不存在空目录被独立处理的场景). */
  private translateEvent(ev: parcelWatcher.Event): WatchEvent | null {
    const abs = path.resolve(ev.path);
    if (!this.rootDir) return null;
    const root = this.rootDir.replace(/\\/g, '/');
    const normalizedAbs = abs.replace(/\\/g, '/');
    const relativePath = normalizedAbs.startsWith(root + '/')
      ? normalizedAbs.slice(root.length + 1)
      : normalizedAbs;

    let kind: WatchEventKind;
    switch (ev.type) {
      case 'create': {
        const isDir = safeIsDirectory(abs);
        kind = isDir ? 'addDir' : 'add';
        break;
      }
      case 'update':
        kind = 'change';
        break;
      case 'delete':
        kind = 'unlink';
        break;
      default:
        return null;
    }
    return { kind, filePath: abs, relativePath, timestamp: Date.now() };
  }

  private dispatch(event: WatchEvent | null): void {
    if (!event) return;
    for (const sub of this.subscribers.values()) {
      // kind 过滤
      if (sub.options.kinds && !sub.options.kinds.includes(event.kind)) continue;
      // watchRoots 过滤 (sub 只关心特定子目录)
      if (sub.normalizedRoots && !this.eventInRoots(event, sub.normalizedRoots)) continue;
      // 自定义文件过滤
      if (sub.options.fileFilter && !sub.options.fileFilter(event.relativePath, event.kind)) continue;
      sub.buffer.push(event);
      this.scheduleFlush(sub);
    }
  }

  private eventInRoots(event: WatchEvent, roots: string[]): boolean {
    return isEventInWatchScope(event.filePath, roots, this.rootDir);
  }

  /**
   * 订阅文件变更事件。返回订阅 ID，用于 unsubscribe。
   */
  subscribe(callback: WatchSubscriberCallback, options: WatchSubscriberOptions): number {
    const id = this.nextId++;
    const normalizedRoots = options.watchRoots && options.watchRoots.length > 0
      ? options.watchRoots.map((r) => path.resolve(r).replace(/\\/g, '/'))
      : null;
    const sub: Subscriber = {
      id,
      options,
      callback,
      buffer: [],
      timer: null,
      normalizedRoots,
    };
    this.subscribers.set(id, sub);
    return id;
  }

  /**
   * 取消订阅
   */
  unsubscribe(id: number): void {
    const sub = this.subscribers.get(id);
    if (sub) {
      if (sub.timer) clearTimeout(sub.timer);
      this.subscribers.delete(id);
      if (this.subscribers.size === 0) {
        void this.stop();
      }
    }
  }

  /**
   * 停止 watcher 并清理所有订阅
   */
  async stop(): Promise<void> {
    this.started = false;
    for (const sub of this.subscribers.values()) {
      if (sub.timer) clearTimeout(sub.timer);
    }
    this.subscribers.clear();
    /* 等启动 promise settle 再 unsubscribe — 否则可能 unsubscribe 一个还没 attach 的 subscription. */
    if (this.startupPromise) {
      try { await this.startupPromise; } catch { /* startup 已 log, 继续清理 */ }
      this.startupPromise = null;
    }
    if (this.subscription) {
      try { await this.subscription.unsubscribe(); } catch (e) {
        console.error('[WatchCoordinator] unsubscribe failed', e);
      }
      this.subscription = null;
    }
    this.rootDir = null;
    this.extraIgnorePatterns = [];
  }

  /** 是否正在运行 */
  isRunning(): boolean { return this.started; }

  /** 当前 workspace root */
  getRoot(): string | null { return this.rootDir; }

  /** 获取当前订阅者数量（调试用） */
  subscriberCount(): number { return this.subscribers.size; }

  private scheduleFlush(sub: Subscriber): void {
    if (sub.timer) return;
    const ms = sub.options.debounceMs ?? 300;
    sub.timer = setTimeout(() => {
      sub.timer = null;
      const events = sub.buffer.splice(0);
      if (events.length > 0) {
        try {
          sub.callback(events);
        } catch (err) {
          console.error(`[WatchCoordinator] subscriber "${sub.options.name}" error:`, err);
        }
      }
    }, ms);
  }
}

function safeIsDirectory(absPath: string): boolean {
  try { return fsSync.statSync(absPath).isDirectory(); } catch { return false; }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let _instance: WatchCoordinator | null = null;

export function getWatchCoordinator(): WatchCoordinator {
  if (!_instance) {
    _instance = new WatchCoordinator();
  }
  return _instance;
}

/**
 * 重置单例（测试用）
 */
export async function resetWatchCoordinator(): Promise<void> {
  if (_instance) {
    await _instance.stop();
    _instance = null;
  }
}

export function isEventInWatchScope(
  filePath: string,
  roots: string[],
  rootDir: string | null | undefined,
): boolean {
  const p = filePath.replace(/\\/g, '/');
  for (const r of roots) {
    if (p === r || p.startsWith(r + '/')) return true;
  }
  const root = rootDir?.replace(/\\/g, '/');
  if (root && p.startsWith(root + '/') && !p.slice(root.length + 1).includes('/')) {
    return true;
  }
  return false;
}
