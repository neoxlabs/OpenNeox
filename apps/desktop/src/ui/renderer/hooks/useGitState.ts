/* ============================================================
 * useGitState — 订阅 gitStateStore 的 React hook
 *   组件挂载时订阅 cwd 对应的 GitState, 卸载或 cwd 切换时 unsubscribe.
 *   多个组件用同一 cwd 时共享同一份模型和同一条主进程订阅.
 *
 * useGitFileBadge — 文件树每一行只订阅自己那个路径的角标:
 *   git 状态变化只重渲角标真变了的那几行, 不重渲整棵树。
 * ============================================================ */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { getGitBadge, subscribeGitBadge, subscribeGitState, type GitState } from '../state/gitStateStore';

const INITIAL: GitState = {
  isGitRepo: false,
  branch: '',
  ahead: 0,
  behind: 0,
  dirty: false,
  files: [],
  lastFetchAt: 0,
  loaded: false,
  status: null,
  error: '',
};

export function useGitState(cwd: string | undefined): GitState {
  const [state, setState] = useState<GitState>(INITIAL);
  useEffect(() => {
    if (!cwd) { setState(INITIAL); return; }
    const unsub = subscribeGitState(cwd, setState);
    return unsub;
  }, [cwd]);
  return state;
}

export function useGitFileBadge(cwd: string | undefined, absPath: string): string | undefined {
  const subscribe = useCallback(
    (fn: () => void) => (cwd ? subscribeGitBadge(cwd, absPath, fn) : () => {}),
    [cwd, absPath],
  );
  const get = useCallback(() => (cwd ? getGitBadge(cwd, absPath) : undefined), [cwd, absPath]);
  return useSyncExternalStore(subscribe, get, get);
}
