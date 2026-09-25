/**
 * serviceLauncher — 从 RunConfig 启动一个服务的总入口.
 *
 * 跟 agent execute_shell(bg=true) 走完全同款的 pipeline (端口探测 / EADDRINUSE 自愈 /
 * 自动 bindConfig / healthcheck), 只是入口是 UI 按钮调而不是 LLM 调.
 *
 * 用法 (main process IPC handler):
 *   const result = await startServiceByConfig(workspaceRoot, configId);
 *
 * 流程:
 *   1. 查 ServiceConfig
 *   2. 解析 cwd (相对 → 绝对)
 *   3. 复用 runBackgroundShellCommand (它会自动 bindConfig 因为命令 + cwd 匹配)
 *   4. 返回结果 (含 pid / 状态)
 */

import { getServiceConfigStore } from './serviceConfigStoreCache.js';
import { runBackgroundShellCommand } from '../../tools/shell/backgroundShellExecution.js';
import { formatBackgroundProcessDuplicate } from '../../tools/shell/executeShellMessages.js';
import { createNodeServices } from '@neoxlabs/platform/platform/nodeServices.js';
import type { PlatformServices } from '@neoxlabs/platform/platform/services.js';
import type { TrackedProcess } from '@neoxlabs/platform/platform/processManager.js';
import * as path from 'node:path';

export interface ServiceLaunchResult {
  ok: boolean;
  output?: string;
  error?: string;
  pid?: number;
  reused?: boolean;
  /** 端口被占导致没起 —— UI 据此渲染"被谁占了 + 下一步怎么办", 而不是干扔一句 EADDRINUSE */
  portConflict?: {
    port: number;
    pid: number;
    command: string;
    /** true = 占用者也是 Neox 管的进程, UI 可以直接给"停掉它并启动"按钮 */
    tracked: boolean;
  };
}

export async function startServiceByConfig(
  workspaceRoot: string,
  configId: string,
  /** UI 触发时显式带过来的 sessionId, 用于 shell_output_stream 推流路由.
   *  agent / autoRestart 路径可不传 (走 ALS 解析). 用户从 UI 点 Start 必须传 — 否则
   *  shell_output_stream callback 在 activeSessions 为空时直接 drop, 日志面板永远空. */
  streamSessionId?: string,
): Promise<ServiceLaunchResult> {
  if (!workspaceRoot || !configId) {
    return { ok: false, error: 'workspaceRoot and configId required' };
  }
  const store = getServiceConfigStore(workspaceRoot);
  /* 跨进程缓存陷阱: 这个函数可能从 server 进程被 SDK 调到, 但 .neox/run-configs.json
   * 刚刚才被 electron-main 进程的 IPC handler 写入. server 这边的 store 缓存还是 boot 时
   * 读到的老内容, store.get() 命中 cache 直接返回 undefined → UI 立刻看到 "RunConfig not found".
   * 强制 invalidate 让下一次 list() 重读盘. 单文件读 < 1ms, 启动场景不在乎. */
  store.invalidate();
  const config = store.get(configId);
  if (!config) {
    return { ok: false, error: `RunConfig '${configId}' not found` };
  }
  const cwd = path.isAbsolute(config.cwd)
    ? config.cwd
    : path.resolve(workspaceRoot, config.cwd);

  /* 拼 env prefix — execute_shell 跟 RunConfig.env 走的同款 normalize-match,
   * 这里我们要保证起的命令 + cwd 跟 RunConfig 严格一致, 这样 backgroundShellExecution
   * 内的 store.findByCommandCwd 能命中自动 bindConfig. */
  const envPrefix = config.env
    ? Object.entries(config.env)
        .map(([k, v]) => `${k}=${shellQuote(v)}`)
        .join(' ') + ' '
    : '';
  const fullCommand = envPrefix + config.command;

  const services = createNodeServices();
  const runningForConfig = newestRunning(services.processManager.findByConfigId(configId));
  if (runningForConfig) {
    services.processManager.bindConfig(runningForConfig.pid, configId, config.name);
    return reusedLaunchResult(services, workspaceRoot, fullCommand, runningForConfig);
  }

  const runningForCommand = newestRunning(services.processManager.findByCommandCwd(fullCommand, cwd));
  if (runningForCommand) {
    services.processManager.bindConfig(runningForCommand.pid, configId, config.name);
    return reusedLaunchResult(services, workspaceRoot, fullCommand, runningForCommand);
  }

  {
    const { inspectPortConflict } = await import('../../tools/shell/servicePreflightCheck.js');
    const conflict = inspectPortConflict(fullCommand, services.processManager);
    if (conflict) {
      return {
        ok: false,
        error: `端口 ${conflict.port} 已被占用 (pid=${conflict.pid})`,
        portConflict: conflict,
      };
    }
  }

  try {
    const result = await runBackgroundShellCommand({
      command: fullCommand,
      workspaceRoot,
      cwd,
      streamSessionId,
      shellOption: true,
      services,
      logger: services.logger,
      getBackgroundTaskCallback: () => null,
    });
    return { ok: true, output: result };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

function newestRunning(processes: TrackedProcess[]): TrackedProcess | undefined {
  return processes
    .filter((p) => p.status === 'running')
    .sort((a, b) => b.startTime.getTime() - a.startTime.getTime())[0];
}

function reusedLaunchResult(
  services: PlatformServices,
  workspaceRoot: string,
  command: string,
  process: TrackedProcess,
): ServiceLaunchResult {
  const runtime = Math.floor((Date.now() - process.startTime.getTime()) / 1000);
  const bgCount = services.processManager.getBackgroundRunning().length;
  const output = formatBackgroundProcessDuplicate(
    { workspaceRoot, command },
    process.pid,
    runtime,
    bgCount,
  );
  const preamble = services.processManager.consumeServicesPreambleIfChanged();
  return {
    ok: true,
    pid: process.pid,
    reused: true,
    output: preamble ? `${preamble}\n${output}` : output,
  };
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_:.,/=+\-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
