
import * as path from 'node:path';

export type GitStatusInvalidation = 'hard' | 'soft';

export interface GitStatusComputed<T> {
  value: T;
  /** 仓库根 —— 写操作按它把同仓的其它 cwd 一起失效 */
  root: string;
  /** 需要监听的 .git 元数据目录 (gitDir / commonDir), 不是仓库就空 */
  metaDirs: string[];
}

export interface GitRepoWatch {
  setMetaDirs(dirs: string[]): void;
  dispose(): void;
}

export interface GitStatusCacheDeps<T> {
  compute(cwd: string): Promise<GitStatusComputed<T>>;
  /** 结果签名 —— 变了才通知 */
  signature(value: T): string;
  /** 签名变了 (含第一次): 给值盖版本号之类, 返回要存下的值 */
  stamp?(value: T, prev: T | undefined): T;
  /** 后台 / 补跑重算后签名变了。cwds = 调用方传进来过的原始字符串 (渲染层按它精确匹配) */
  onChanged(cwds: string[], root: string, value: T, prev: T): void;
  watch?(cwd: string, onEvent: (source: 'tree' | 'meta') => void): GitRepoWatch;
  now?(): number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(t: unknown): void;
}

export interface GitStatusCacheTuning {
  minGapMs: number;
  gapFactor: number;
  maxGapMs: number;
  /** 事件停下来多久再算 (合并一次保存触发的多个事件) */
  debounceMs: number;
  minTtlMs: number;
  ttlFactor: number;
  /** 没人 retain 之后多久回收 (含 watcher) —— 留一段是为了切走再切回不必冷启动 */
  disposeMs: number;
  /** 自己算完之后多久内的 .git 元数据事件视为自己引起的 */
  selfEventTailMs: number;
}

const DEFAULT_TUNING: GitStatusCacheTuning = {
  minGapMs: 1000,
  gapFactor: 8,
  maxGapMs: 30_000,
  debounceMs: 300,
  minTtlMs: 60_000,
  ttlFactor: 60,
  disposeMs: 5 * 60_000,
  selfEventTailMs: 150,
};

interface Entry<T> {
  key: string;
  aliases: Set<string>;
  value?: T;
  root: string;
  sig: string;
  computedAt: number;
  lastDurationMs: number;
  lastRequestAt: number;
  /** 有几个界面在看 (渲染层订阅计数)。0 = 事件来了只标脏, 不后台算 */
  retain: number;
  dirty: 'none' | GitStatusInvalidation;
  inflight: Promise<T> | null;
  rerun: boolean;
  lastComputeEndAt: number;
  timer: unknown;
  watch: GitRepoWatch | null;
}

function normKey(p: string): string {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

function isInside(child: string, parent: string): boolean {
  if (!parent) return false;
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export class GitStatusCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly tuning: GitStatusCacheTuning;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;

  constructor(private readonly deps: GitStatusCacheDeps<T>, tuning?: Partial<GitStatusCacheTuning>) {
    this.tuning = { ...DEFAULT_TUNING, ...tuning };
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  async get(cwd: string, opts?: { fresh?: boolean }): Promise<T> {
    this.sweep();
    const e = this.entry(cwd);
    e.lastRequestAt = this.now();
    if (opts?.fresh) e.dirty = 'hard';
    if (e.value !== undefined && e.dirty !== 'hard' && !this.ttlExpired(e)) {
      if (e.dirty === 'none' || e.timer != null || e.inflight) return e.value;
    }
    return this.run(e);
  }

  /** 我们自己的 git 写操作之后调: 下一次 get 必须重算, 有人在看就立刻算并通知 */
  invalidate(cwd: string, level: GitStatusInvalidation = 'hard'): void {
    const k = normKey(cwd);
    for (const e of this.entries.values()) {
      /* 写操作的 cwd 可能是仓库里的子目录 / 同仓的另一个工作区 —— 同根的都算 */
      const root = e.root ? normKey(e.root) : '';
      if (e.key === k || (root && (isInside(k, root) || isInside(root, k)))) this.markDirty(e, level);
    }
  }

  /** 界面开始看这个仓库: 之后的事件会触发后台重算 + 通知 */
  retain(cwd: string): void {
    this.sweep();
    const e = this.entry(cwd);
    e.retain++;
    e.lastRequestAt = this.now();
    /* 没人看期间攒下的脏: 现在有人看了, 排一轮 */
    if (e.dirty !== 'none' && e.value !== undefined) this.markDirty(e, e.dirty);
  }

  release(cwd: string): void {
    const e = this.entries.get(normKey(cwd));
    if (!e) return;
    e.retain = Math.max(0, e.retain - 1);
    e.lastRequestAt = this.now();
    if (e.retain === 0 && e.timer != null) { this.clearTimer(e.timer); e.timer = null; }
    this.sweep();
  }

  dispose(): void {
    for (const e of this.entries.values()) this.drop(e);
    this.entries.clear();
  }

  /** 测试/诊断用 */
  size(): number { return this.entries.size; }

  // ───────────────────────────── internals ─────────────────────────────

  private entry(cwd: string): Entry<T> {
    const key = normKey(cwd);
    let e = this.entries.get(key);
    if (!e) {
      e = {
        key, aliases: new Set(), root: '', sig: '', computedAt: 0, lastDurationMs: 0,
        lastRequestAt: 0, retain: 0, dirty: 'none', inflight: null, rerun: false, lastComputeEndAt: 0,
        timer: null, watch: null,
      };
      this.entries.set(key, e);
      const entry = e;
      e.watch = this.deps.watch?.(key, (source) => {
        if (source === 'meta' && (entry.inflight || this.now() - entry.lastComputeEndAt < this.tuning.selfEventTailMs)) return;
        this.markDirty(entry, 'soft');
      }) ?? null;
    }
    e.aliases.add(cwd);
    return e;
  }

  private ttlExpired(e: Entry<T>): boolean {
    const ttl = Math.max(this.tuning.minTtlMs, this.tuning.ttlFactor * e.lastDurationMs);
    return this.now() - e.computedAt >= ttl;
  }

  private gapMs(e: Entry<T>): number {
    return Math.min(this.tuning.maxGapMs, Math.max(this.tuning.minGapMs, this.tuning.gapFactor * e.lastDurationMs));
  }

  private markDirty(e: Entry<T>, level: GitStatusInvalidation): void {
    if (e.dirty !== 'hard') e.dirty = level;
    /* 算着的时候: hard 让这一轮算完立刻补跑 (调用方等的是写操作之后的状态);
     * soft 不补跑 —— fs 事件风暴里每轮都会撞上新事件, 补跑就等于无节流死循环,
     * 留到这一轮结束后按节流间隔排 (见 run 的 finally)。 */
    if (e.inflight) { if (e.dirty === 'hard') e.rerun = true; return; }
    if (e.retain <= 0) return;               /* 没人在看: 只标脏, 下次 get 再算 */
    if (e.timer != null) {
      if (level !== 'hard') return;          /* 已排队的 soft 重算保持节流 */
      this.clearTimer(e.timer);
      e.timer = null;
    }
    const wait = level === 'hard'
      ? 0
      : Math.max(this.tuning.debounceMs, e.lastComputeEndAt + this.gapMs(e) - this.now());
    e.timer = this.setTimer(() => {
      e.timer = null;
      if (e.dirty === 'none' || this.entries.get(e.key) !== e) return;
      void this.run(e).catch(() => { /* compute 失败已把 dirty 置回 hard, 下一次 get 重来 */ });
    }, wait);
  }

  private run(e: Entry<T>): Promise<T> {
    if (e.inflight) {
      if (e.dirty === 'hard') e.rerun = true;
      return e.inflight;
    }
    if (e.timer != null) { this.clearTimer(e.timer); e.timer = null; }
    const loop = async (): Promise<T> => {
      let computed: GitStatusComputed<T>;
      do {
        e.rerun = false;
        e.dirty = 'none';
        const t0 = this.now();
        try {
          computed = await this.deps.compute(e.key);
        } catch (err) {
          e.dirty = 'hard';                  /* 没算成: 下一次 get 必须重来 */
          throw err;
        }
        e.lastDurationMs = this.now() - t0;
      } while (e.rerun);
      return this.commit(e, computed);
    };
    const p = loop().finally(() => {
      e.inflight = null;
      e.lastComputeEndAt = this.now();
      /* 算的过程中来过 soft 事件: 按节流间隔再排一轮 */
      if (e.dirty === 'soft' && this.entries.get(e.key) === e) this.markDirty(e, 'soft');
    });
    e.inflight = p;
    return p;
  }

  private commit(e: Entry<T>, c: GitStatusComputed<T>): T {
    const prev = e.value;
    const sig = this.deps.signature(c.value);
    e.root = c.root;
    e.computedAt = this.now();
    e.watch?.setMetaDirs(c.metaDirs);
    if (prev !== undefined && sig === e.sig) return prev;
    const next = this.deps.stamp ? this.deps.stamp(c.value, prev) : c.value;
    e.value = next;
    e.sig = sig;
    /* 第一次算出来不通知: 调用方本来就在等这个结果 */
    if (prev !== undefined) {
      try { this.deps.onChanged([...e.aliases], e.root, next, prev); } catch { /* 通知失败不影响结果 */ }
    }
    return next;
  }

  private drop(e: Entry<T>): void {
    if (e.timer != null) this.clearTimer(e.timer);
    e.timer = null;
    e.watch?.dispose();
    e.watch = null;
  }

  private sweep(): void {
    const t = this.now();
    for (const [k, e] of this.entries) {
      if (!e.inflight && e.retain <= 0 && t - e.lastRequestAt > this.tuning.disposeMs) {
        this.drop(e);
        this.entries.delete(k);
      }
    }
  }
}
