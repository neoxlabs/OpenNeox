/**
 * autoRestartManager — bg 进程崩溃自愈.
 *
 *   触发: ProcessManager process:exit 事件, 满足条件就调 serviceLauncher.start.
 *
 *   条件全满足才重启:
 *     1. proc.configId 有 (绑了 RunConfig)
 *     2. config.autoRestart === true (opt-in)
 *     3. exitCode != 0 (正常退出不重启, 假设是用户预期)
 *     4. !proc.userKilled (用户主动 stop 不重启)
 *     5. 退避: 10s 窗口内连续 3 次失败 → 给定 → 标记给定不再重试
 *
 *   退避 state: per-configId 维护一个 sliding window 计数. 重启成功不清, 30s
 *   后无新失败自动清零. 用户手动 Stop → 也清零 + 标记 给定 = false (可重试).
 *
 *   依赖: serviceConfigStoreCache (查 config) + serviceLauncher (start) + ProcessManager.
 *   实例化: main 进程 bootstrap 时调 attachAutoRestart(workspaceRoot).
 */

import { processManager } from '@neoxlabs/platform/platform/processManager.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { getServiceConfigStore } from './serviceConfigStoreCache.js';

const RESTART_WINDOW_MS = 10_000;
const MAX_RESTARTS_PER_WINDOW = 3;
const RESTART_DELAY_MS = 800;

interface FailureBucket {
  failures: number[]; /* timestamps ms */
  givenUp: boolean;
  /** 重启倒计时 timer, 用户 stop 时取消 */
  pendingTimer?: ReturnType<typeof setTimeout>;
}

const buckets = new Map<string, FailureBucket>(); /* keyed by configId */

let attached = false;

/**
 * 挂上 ProcessManager 监听器. main 进程 bootstrap 时调一次即可.
 *   workspaceRoot 从 proc.cwd 推断 — 多 workspace 同时开也兼容.
 */
export function attachAutoRestart(): void {
  if (attached) return;
  attached = true;

  processManager.on('process:exit', async (proc) => {
    /* 1. 必须绑过 config */
    const configId = proc.configId;
    if (!configId) return;

    /* 2. 用户主动 stop 不重启 */
    if (proc.userKilled) {
      const b = buckets.get(configId);
      if (b?.pendingTimer) clearTimeout(b.pendingTimer);
      buckets.delete(configId);
      return;
    }

    /* 3. exitCode 0 不重启 (假设是 expected 终止) */
    if (proc.exitCode === 0) return;

    const workspaceRoot = proc.workspaceRoot || proc.cwd;
    let config;
    try {
      const store = getServiceConfigStore(workspaceRoot);
      config = store.get(configId);
    } catch {
      return;
    }
    if (!config?.autoRestart) return;

    /* 5. 退避判定 */
    const now = Date.now();
    let bucket = buckets.get(configId);
    if (!bucket) {
      bucket = { failures: [], givenUp: false };
      buckets.set(configId, bucket);
    }
    if (bucket.givenUp) {
      cliLogger.warn('AUTO_RESTART', `Skip ${configId} (已 give up, 用户 Stop+Start 清状态)`);
      return;
    }
    /* prune 窗口外的失败 */
    bucket.failures = bucket.failures.filter(t => now - t < RESTART_WINDOW_MS);
    bucket.failures.push(now);
    if (bucket.failures.length > MAX_RESTARTS_PER_WINDOW) {
      bucket.givenUp = true;
      cliLogger.error('AUTO_RESTART', `配置 ${configId} 在 ${RESTART_WINDOW_MS}ms 内崩 ${bucket.failures.length} 次, 放弃自愈`);
      return;
    }

    cliLogger.info('AUTO_RESTART', `配置 ${configId} 崩了 (exit ${proc.exitCode}), ${RESTART_DELAY_MS}ms 后自愈第 ${bucket.failures.length} 次`);
    bucket.pendingTimer = setTimeout(async () => {
      bucket!.pendingTimer = undefined;
      try {
        /* dynamic import 避免循环依赖 */
        const { startServiceByConfig } = await import('./serviceLauncher.js');
        const wsRoot = workspaceRoot;
        const result = await startServiceByConfig(wsRoot, configId);
        if (!result.ok) {
          cliLogger.warn('AUTO_RESTART', `自愈失败 ${configId}: ${result.error}`);
        }
      } catch (err: any) {
        cliLogger.warn('AUTO_RESTART', `自愈调用异常 ${configId}: ${err?.message}`);
      }
    }, RESTART_DELAY_MS);
  });

  /* 用户 Start → 清退避 + 给定状态. 走 process:start 事件兜底. */
  processManager.on('process:start', (proc) => {
    if (!proc.configId) return;
    const b = buckets.get(proc.configId);
    if (b) {
      b.givenUp = false;
      b.failures = [];
      if (b.pendingTimer) clearTimeout(b.pendingTimer);
      b.pendingTimer = undefined;
    }
  });
}

/** 给 UI / 测试用 — 查某 config 当前的重启状态. */
export function getRestartState(configId: string): {
  count: number;
  givenUp: boolean;
} {
  const b = buckets.get(configId);
  if (!b) return { count: 0, givenUp: false };
  const now = Date.now();
  const recent = b.failures.filter(t => now - t < RESTART_WINDOW_MS).length;
  return { count: recent, givenUp: b.givenUp };
}

/** 测试清理. */
export function _resetAutoRestartForTest(): void {
  buckets.clear();
}
