import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';


export const DB_OPEN_LOCK_SUFFIX = '.openlock';
/** 超过这个时长的锁一律视为僵死 (可能是跨机器共享目录 / PID 复用)。 */
export const DEFAULT_DB_OPEN_LOCK_STALE_MS = 10 * 60_000;

export type DbOpenLockHolder = {
  pid: number;
  host: string;
  ts: number;
  note?: string;
};

export class DbOpenLockTimeoutError extends Error {
  readonly lockPath: string;
  readonly holder: DbOpenLockHolder | null;
  readonly waitedMs: number;

  constructor(lockPath: string, holder: DbOpenLockHolder | null, waitedMs: number) {
    const who = holder
      ? `持有者 pid=${holder.pid} host=${holder.host} 开始于 ${new Date(holder.ts).toISOString()}`
      : '持有者信息不可读';
    super(
      `另一个 Neox 进程正在打开/迁移会话库，已等待 ${Math.round(waitedMs / 1000)}s (${lockPath}; ${who})。` +
      '请等它完成后重试；如果确认那个进程已经退出，可以删除该锁文件后重新启动。',
    );
    this.name = 'DbOpenLockTimeoutError';
    this.lockPath = lockPath;
    this.holder = holder;
    this.waitedMs = waitedMs;
  }
}

/** 同步等待 —— 打开库是同步流程 (constructor), 不能用 await。 */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) { /* 极老运行时兜底: 自旋 */ }
  }
}

function readHolder(lockPath: string): DbOpenLockHolder | null {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8').trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DbOpenLockHolder>;
    if (typeof parsed.pid !== 'number' || typeof parsed.ts !== 'number') return null;
    return {
      pid: parsed.pid,
      host: typeof parsed.host === 'string' ? parsed.host : '',
      ts: parsed.ts,
      note: typeof parsed.note === 'string' ? parsed.note : undefined,
    };
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    /* EPERM = 进程在, 只是不是当前用户 —— 仍然算活着 */
    return err?.code === 'EPERM';
  }
}

/** 锁是否已僵死。同机 + PID 不在 → 立即可接管；其余情况按锁龄判断。 */
export function isDbOpenLockStale(
  lockPath: string,
  opts: { staleMs?: number; now?: number } = {},
): boolean {
  const staleMs = opts.staleMs ?? DEFAULT_DB_OPEN_LOCK_STALE_MS;
  const now = opts.now ?? Date.now();
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(lockPath).mtimeMs;
  } catch {
    return false; /* 不存在 —— 不 stale, 让 acquire 去创建 */
  }
  const holder = readHolder(lockPath);
  if (!holder) return now - mtimeMs > staleMs;
  if (holder.host === os.hostname() && !pidAlive(holder.pid)) return true;
  return now - holder.ts > staleMs;
}

const activeReleases = new Set<() => void>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  /* 正常退出时释放；kill -9 / abort 不会走到这里, 靠下一次启动的 stale 判定接管。 */
  process.once('exit', () => {
    for (const release of [...activeReleases]) {
      try { release(); } catch { /* ignore */ }
    }
  });
}

export function dbOpenLockPath(dbPath: string): string {
  return `${dbPath}${DB_OPEN_LOCK_SUFFIX}`;
}

export function acquireDbOpenLock(
  dbPath: string,
  opts: { timeoutMs?: number; pollMs?: number; staleMs?: number; note?: string } = {},
): () => void {
  const lockPath = dbOpenLockPath(dbPath);
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const pollMs = opts.pollMs ?? 50;
  const staleMs = opts.staleMs ?? DEFAULT_DB_OPEN_LOCK_STALE_MS;
  const startedAt = Date.now();
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });

  let lastHolder: DbOpenLockHolder | null = null;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      const holder: DbOpenLockHolder = {
        pid: process.pid,
        host: os.hostname(),
        ts: Date.now(),
        note: opts.note,
      };
      try {
        fs.writeFileSync(fd, JSON.stringify(holder));
      } finally {
        fs.closeSync(fd);
      }
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        activeReleases.delete(release);
        try {
          const current = readHolder(lockPath);
          /* 只删自己的锁 —— 期间可能已被 stale 接管给了别的进程 */
          if (current && current.pid === process.pid && current.ts === holder.ts) {
            fs.unlinkSync(lockPath);
          }
        } catch { /* ignore */ }
      };
      activeReleases.add(release);
      installExitHook();
      return release;
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err;
      lastHolder = readHolder(lockPath);
      if (isDbOpenLockStale(lockPath, { staleMs })) {
        try { fs.unlinkSync(lockPath); } catch { /* 别人先删了 / 权限, 下一轮再看 */ }
        continue;
      }
      const elapsed = Date.now() - startedAt;
      if (elapsed >= timeoutMs) throw new DbOpenLockTimeoutError(lockPath, lastHolder, elapsed);
      sleepSync(Math.min(pollMs, Math.max(10, timeoutMs - elapsed)));
    }
  }
}

export function withDbOpenLock<T>(
  dbPath: string,
  fn: () => T,
  opts: { timeoutMs?: number; pollMs?: number; staleMs?: number; note?: string } = {},
): T {
  const release = acquireDbOpenLock(dbPath, opts);
  try {
    return fn();
  } finally {
    release();
  }
}
