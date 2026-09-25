/**
 * Per-file in-memory locking serializes edit, write_file, and batch writes
 * within one process. It protects concurrent tool calls while leaving
 * cross-process coordination to the operating system.
 */

import path from 'node:path';

/* path → Promise chain. 给每个文件维护一条 await 链, 后来者排在 head.then() 后跑. */
const fileLocks = new Map<string, Promise<void>>();

/** 标准化路径作 key — case-insensitive 在 macOS / Windows. */
function normalizeKey(absPath: string): string {
  /* path.resolve 处理掉 ./..  + symlink 不 resolve (intentional — symlink 是不同 inode 应单独锁) */
  const normalized = path.resolve(absPath);
  return process.platform === 'win32' || process.platform === 'darwin'
    ? normalized.toLowerCase()
    : normalized;
}

export async function withFileWriteLock<T>(
  absPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = normalizeKey(absPath);
  const prev = fileLocks.get(key) ?? Promise.resolve();

  /* 链尾追加: 当前 fn 在 prev resolve 后才跑. catch 是为了 prev fn 抛错不卡住后续. */
  let resolveSelf!: () => void;
  const self = new Promise<void>((res) => { resolveSelf = res; });
  fileLocks.set(key, prev.then(() => self).catch(() => self));

  try {
    await prev.catch(() => {/* 上一个 fn 抛错跟我们无关, 继续 */});
    return await fn();
  } finally {
    resolveSelf();
    /* 链尾如果还是我们就清掉 — 节省 Map 长期占内存 */
    if (fileLocks.get(key) === prev.then(() => self).catch(() => self) ||
        fileLocks.get(key) === self) {
      /* 上面 then() 又生成新 Promise, 实际清理时 get 可能不严格等价. 用 setTimeout 0
         让链尾稳定后再判 — 当前 in-flight 总数低时即可清 */
      setTimeout(() => {
        if (!fileLocks.get(key) || fileLocks.get(key) === self) {
          fileLocks.delete(key);
        }
      }, 0).unref?.();
    }
  }
}

/** 诊断: 返回当前持锁的文件路径列表. /diag 用. */
export function getActiveLockedFiles(): string[] {
  return [...fileLocks.keys()];
}
