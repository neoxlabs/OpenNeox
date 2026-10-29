/**
 * serviceConfigStoreCache — 全进程内每个 workspaceRoot 一个 ServiceConfigStore 实例.
 *
 * 为啥要 singleton:
 *   · multiple agent sessions in the same workspace 共享同一份 .neox/run-configs.json
 *   · cache 跨调用复用, 不必每次 spawn 都读盘
 *   · upsert/remove 走同一 in-memory cache, 立刻可见
 *
 * 调用方:
 *   · backgroundShellExecution: 起进程后查 store 自动 bindConfig
 *   · register_run_config tool: upsert
 *   · agenticRuntime sessionServicesSnapshot 计算时 list()
 *   · UI services panel via IPC bridge (renderer 不直接拿这个, 走 main 进程查询)
 */

import { ServiceConfigStore } from './serviceConfigStore.js';

const cache = new Map<string, ServiceConfigStore>();

export function getServiceConfigStore(workspaceRoot: string): ServiceConfigStore {
  let store = cache.get(workspaceRoot);
  if (!store) {
    store = new ServiceConfigStore(workspaceRoot);
    cache.set(workspaceRoot, store);
  }
  return store;
}

/** 测试 / hot-reload 用 — 清缓存让下次 get 重读文件. */
export function invalidateServiceConfigStoreCache(workspaceRoot?: string): void {
  if (workspaceRoot) {
    cache.get(workspaceRoot)?.invalidate();
  } else {
    for (const s of cache.values()) s.invalidate();
  }
}
