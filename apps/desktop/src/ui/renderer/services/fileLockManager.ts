/**
 * fileLockManager — 跨 Surface 文件并发编辑锁 (singleton, renderer 内).
 *
 * 场景:
 *   user 在 session A 里把 budget.csv 当 Sheet surface 打开编辑, 同时另一个会话 B
 *   把 budget.csv 当 Code surface 打开. 两边各自编辑 → 各自 save → 互相覆盖.
 *
 * 设计:
 *   · Map<absPath, { ownerSurfaceId, acquiredAt }>
 *   · acquire(path, surfaceId) → bool:
 *       - 没人持有 → 写入返 true
 *       - 已被同 surfaceId 持有 → 续约 ts 返 true
 *       - 被别人持有 → 返 false
 *   · release(path, surfaceId): 仅当 ownerSurfaceId 匹配才释放, 防一边 unmount 把别人锁清掉
 *   · whoOwns(path) → ownerSurfaceId | null: UI 显示 "已被另一会话编辑"
 *   · forceTakeOver(path, surfaceId): 强制接管, 用户在 UI 上点 "强制接管" 才调
 *
 * 不持久化 — renderer 重启 / window 重 mount 自然清空, 锁是 in-session 概念.
 * 不跨 BrowserWindow — 多 Window 各自独立 (这是 V1 限制, 后续可走 IPC 同步).
 */

export interface FileLock {
  ownerSurfaceId: string;
  acquiredAt: number;
}

const locks = new Map<string, FileLock>();
const listeners = new Set<(path: string) => void>();

/** 申请锁. 已被自己持有 → 续约 (更新 acquiredAt) 返 true. */
export function acquire(absPath: string, surfaceId: string): boolean {
  const existing = locks.get(absPath);
  if (existing) {
    if (existing.ownerSurfaceId === surfaceId) {
      existing.acquiredAt = Date.now();
      return true;
    }
    return false;
  }
  locks.set(absPath, { ownerSurfaceId: surfaceId, acquiredAt: Date.now() });
  notify(absPath);
  return true;
}

/** 释放锁. 必须匹配 ownerSurfaceId 才释放, 防一边 unmount 把别人锁清掉. */
export function release(absPath: string, surfaceId: string): void {
  const existing = locks.get(absPath);
  if (!existing) return;
  if (existing.ownerSurfaceId !== surfaceId) return;
  locks.delete(absPath);
  notify(absPath);
}

/** 当前持有人 — UI 显示 "已被另一会话编辑". null = 没人持有. */
export function whoOwns(absPath: string): string | null {
  return locks.get(absPath)?.ownerSurfaceId ?? null;
}

/** 强制接管 — 用户在冲突 UI 上点 "强制接管" 才调; 不做权限检查. */
export function forceTakeOver(absPath: string, surfaceId: string): void {
  const existing = locks.get(absPath);
  if (existing) {
    /* 通知原持有人锁丢了, 让它进入 read-only 状态 */
    notify(absPath);
  }
  locks.set(absPath, { ownerSurfaceId: surfaceId, acquiredAt: Date.now() });
  notify(absPath);
}

/** 监听某文件锁变化 — UI 用 (申请失败时显示 / 锁被强夺时进 read-only). */
export function subscribeLock(listener: (path: string) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notify(path: string): void {
  for (const l of listeners) {
    try { l(path); } catch { /* swallow — UI listener 出错不能传染回锁本身 */ }
  }
}

/** 测试 / 开发用 — 清空所有锁. 生产代码不调. */
export function _clearAllLocksForTest(): void {
  locks.clear();
}
