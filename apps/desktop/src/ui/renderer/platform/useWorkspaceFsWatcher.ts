/**
 * useWorkspaceFsWatcher — 把 main 进程 watcher 推过来的 fs 事件转 publish 到 FILES_TOPIC.
 *
 * 链路:
 *   Finder/外部工具改文件
 *     → main @parcel/watcher (失败才 chokidar polling; 禁止 chokidar native)
 *     → IPC 'workspace:fs-event' 推回当前 webContents
 *     → 本 hook 收事件 → bus.publisher(FILES_TOPIC).onChanged/onCreated/onDeleted
 *     → FileExplorer 的 useTopicSubscription(FILES_TOPIC) refreshDir(parent)
 *     → 文件树自动重新拉目录, 用户看到新文件
 *
 * 单次启动 / 切 workspace 时 stop 旧 watcher 起新的 — main 已经做了 sender 级 dedupe,
 * 但 renderer 这里也保证显式 stop 一次, 避免 reload 时残留.
 */

import { useEffect } from 'react';
import { useService } from './useService.js';
import { MESSAGE_BUS } from '../../../ide/index.js';
import { FILES_TOPIC } from '../../../ide/vfs/types.js';

interface NeoxWorkspaceWatcherApi {
  workspaceWatchStart?: (root: string) => Promise<{ ok: boolean; error?: string; root?: string }>;
  workspaceWatchStop?: () => Promise<{ ok: boolean }>;
  onWorkspaceFsEvent?: (cb: (e: { kind: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'; path: string }) => void) => (() => void) | undefined;
}

export function useWorkspaceFsWatcher(workspacePath: string | undefined): void {
  const bus = useService(MESSAGE_BUS);

  useEffect(() => {
    if (!workspacePath) return;
    const neox = (window as unknown as { neox?: NeoxWorkspaceWatcherApi }).neox;
    if (!neox?.workspaceWatchStart || !neox?.onWorkspaceFsEvent) return;

    let unsubscribe: (() => void) | null = null;
    let disposed = false;

    /* 订阅事件 → publish FILES_TOPIC. 提早挂监听, 避免 watch-start resolve 之前丢事件. */
    unsubscribe = neox.onWorkspaceFsEvent((event) => {
      if (disposed) return;
      const publisher = bus.publisher(FILES_TOPIC);
      const payload = { path: event.path, source: 'external' as const };
      switch (event.kind) {
        case 'add':
        case 'addDir':
          publisher.onCreated(payload);
          break;
        case 'change':
          publisher.onChanged(payload);
          break;
        case 'unlink':
        case 'unlinkDir':
          publisher.onDeleted(payload);
          break;
      }
    }) ?? null;

    void neox.workspaceWatchStart(workspacePath).catch((err) => {
      console.warn('[useWorkspaceFsWatcher] watch-start failed:', err);
    });

    return () => {
      disposed = true;
      unsubscribe?.();
      void neox.workspaceWatchStop?.().catch(() => { /* ignore */ });
    };
  }, [workspacePath, bus]);
}
