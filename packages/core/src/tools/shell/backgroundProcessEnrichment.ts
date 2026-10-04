
import type { ProcessManager } from '@neoxlabs/platform/platform/processManager.js';
import type { PlatformLogger } from '@neoxlabs/platform/platform/services.js';
import { getServiceConfigStore } from '../../runtime/services/serviceConfigStoreCache.js';

export type EnrichBackgroundProcessOptions = {
  pid: number;
  command: string;
  /** 项目根 (`.neox/run-configs.json` 所在) — 别跟 cwd 混, 见 backgroundShellExecution 注释 */
  workspaceRoot: string;
  /** 进程实际 spawn 目录, 默认 = workspaceRoot */
  spawnCwd?: string;
  processManager: ProcessManager;
  logger: PlatformLogger;
};

/* 端口探测节奏: dev server (vite/next) 2s 内起端口, Spring Boot/JVM 类要 10-30s。
 * 旧路径只在 2s 探一次 → JVM 服务永远探不到。改成多轮退避, 探到即停。 */
const PORT_PROBE_DELAYS_MS = [2_000, 6_000, 15_000, 30_000];

const enrichmentAttachedTo = new WeakSet<object>();

/**
 * 把 enrichment 接到 ProcessManager 的 process:start 上 —— server bootstrap 调一次。
 *
 * 这是"不可能漏"的那一半: 任何执行路径只要 register 了一个后台进程, enrichment 必然跑,
 * 无论它是 shellWorkerClient、backgroundShellExecution, 还是超时被领养的前台命令。
 *
 * 跳过两类:
 *   · free-shell   —— 用户的交互 zsh 不是服务
 *   · origin=adopted —— 进程本来就在跑, 端口/配置由 service_adopt 自己填
 */
export function attachServiceEnrichment(processManager: ProcessManager, logger: PlatformLogger): void {
  if (enrichmentAttachedTo.has(processManager)) return;
  enrichmentAttachedTo.add(processManager);
  processManager.on('process:start', (proc) => {
    if (!proc.background) return;
    if (proc.kind === 'free-shell') return;
    if (proc.origin === 'adopted') return;
    enrichBackgroundProcess({
      pid: proc.pid,
      command: proc.command,
      workspaceRoot: proc.workspaceRoot || proc.cwd,
      spawnCwd: proc.cwd,
      processManager,
      logger,
    });
  });
}

/**
 * 后台进程注册后的服务化 enrichment (fire-and-forget, 全程不抛):
 *   1. RunConfig auto-bind: command+cwd 精确命中 `.neox/run-configs.json` → bindConfig
 *   2. healthcheck: bound config 配了 healthcheck → 启动 5s 周期探针
 *   3. 端口探测: 多轮退避探 LISTEN 端口 (覆盖 JVM 慢启动), 探到写回 setPort
 *   4. adoptable: 探到端口 或 命令匹配 dev pattern → markAdoptable
 */
export function enrichBackgroundProcess(opts: EnrichBackgroundProcessOptions): void {
  const { pid, command, workspaceRoot, processManager, logger } = opts;
  if (!pid || pid <= 0) return;
  const spawnCwd = opts.spawnCwd ?? workspaceRoot;

  /* 1+2. auto-bind + healthcheck */
  void (async () => {
    try {
      const store = getServiceConfigStore(workspaceRoot);
      const matched = store.findByCommandCwd(command, spawnCwd);
      if (matched) {
        processManager.bindConfig(pid, matched.id, matched.name);
        if (matched.healthcheck) {
          const { startHealthCheck } = await import('../../runtime/services/healthChecker.js');
          startHealthCheck(processManager, pid, matched);
        }
      }
    } catch (err: any) {
      logger.warn('SHELL', `RunConfig auto-bind 失败 (不影响进程启动): ${err?.message}`);
    }
  })();

}
