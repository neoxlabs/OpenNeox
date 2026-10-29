/**
 * useSurfaceFileLock — Surface viewer 接入 fileLockManager 的 React hook.
 *
 * 行为:
 *   1. mount 时 acquire(path, surfaceId). 拿到锁 → owned=true.
 *   2. 拿不到 (被别的 surface 持有) → owned=false, conflictWith=ownerSurfaceId, UI 显示
 *      "已被另一会话编辑, [强制接管]" banner.
 *   3. 用户点强制接管 → 调 takeOver(), 原持有者锁丢, 通过 subscribeLock 收到通知,
 *      自己变 owned=false (即"对方接管了, 我变 read-only").
 *   4. unmount 自动 release (仅在 owned=true 时, 避免被接管后误清新持有者的锁).
 *
 * 设计原则:
 *   · acquire 失败不阻止 viewer 渲染 / 编辑 — 跟 VSCode "另一窗口已打开" 等同, 只警告.
 *     真正的"阻止 save 覆盖"由 EditorService 的 conflict detection 兜底 (磁盘 mtime 变了
 *     就弹 conflict banner). 锁是"防误编辑", 不是"防误覆盖".
 *   · 接管时不做权限检查 — 单机 desktop 本身就是一个用户.
 */

import { useEffect, useState, useCallback } from 'react';
import { acquire, release, whoOwns, forceTakeOver, subscribeLock } from '../services/fileLockManager';

export interface SurfaceFileLockState {
  /** 当前是否持有锁 — true = 可正常编辑; false = 显示 read-only / 接管 banner */
  owned: boolean;
  /** 谁持有锁 (surfaceId) — 显示给用户 "已被另一会话编辑 (会话 abc...)" */
  conflictWith: string | null;
  /** 强制接管 — 用户主动点按钮才调 */
  takeOver(): void;
}

/**
 * @param absPath  绝对路径; 空 (例如 inline surface) 时不参与锁 → owned=true 默认
 * @param surfaceId  当前 surface 唯一 id (Surface.id 直接用)
 */
export function useSurfaceFileLock(absPath: string | null | undefined, surfaceId: string): SurfaceFileLockState {
  const [state, setState] = useState<{ owned: boolean; conflictWith: string | null }>(() => {
    if (!absPath) return { owned: true, conflictWith: null };
    const ok = acquire(absPath, surfaceId);
    return { owned: ok, conflictWith: ok ? null : whoOwns(absPath) };
  });

  useEffect(() => {
    if (!absPath) return;
    /* effect 内再 acquire 一次 — 首屏 useState init 时已 acquire, 但 React Strict
     *  Mode dev 会双调度, useState init 跑两次的话第一次会被第二次盖. effect 里 idempotent. */
    const ok = acquire(absPath, surfaceId);
    setState({ owned: ok, conflictWith: ok ? null : whoOwns(absPath) });

    /* 订阅锁变化 — 别人 takeOver 把我锁夺走时, 收到通知更新成 owned=false */
    const unsub = subscribeLock((changedPath) => {
      if (changedPath !== absPath) return;
      const cur = whoOwns(absPath);
      setState({ owned: cur === surfaceId, conflictWith: cur === surfaceId ? null : cur });
    });

    return () => {
      unsub();
      /* 仅自己仍持有时 release — 被接管后 ownerSurfaceId 已不是自己, release 是 no-op
       *  (fileLockManager.release 内部已校验 owner 匹配), 保险起见 if 一下少一次调用 */
      if (whoOwns(absPath) === surfaceId) release(absPath, surfaceId);
    };
  }, [absPath, surfaceId]);

  const takeOver = useCallback(() => {
    if (!absPath) return;
    forceTakeOver(absPath, surfaceId);
    setState({ owned: true, conflictWith: null });
  }, [absPath, surfaceId]);

  return { ...state, takeOver };
}
