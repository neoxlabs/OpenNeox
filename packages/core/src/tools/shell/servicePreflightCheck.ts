/**
 * Service Pre-flight Check — 在后台命令启动前做端口冲突检测
 *
 * 从命令推断目标端口 → lsof 查端口 → 有占用就返回格式化消息给 LLM。
 * 不做硬拦截（返回 null 放行），只在有冲突时返回警告消息让 LLM 决策。
 *
 * 注意：这个检测是**快速**的（单次 lsof，~50ms），不会拖慢正常执行。
 */

import { execSync } from 'child_process';
import type { ProcessManager } from '@neoxlabs/platform/platform/processManager.js';
import type { PlatformLogger } from '@neoxlabs/platform/platform/services.js';
import { inferTargetPort } from './serviceScanTool.js';
import { formatServiceAlreadyRunning } from './executeShellMessages.js';

interface PortOccupant {
  pid: number;
  command: string;
}

/**
 * 快速检测目标端口是否被占用
 * @returns 占用者信息，或 null（端口空闲）
 */
function checkPort(port: number): PortOccupant | null {
  try {
    const raw = execSync(
      `lsof -i :${port} -sTCP:LISTEN -t 2>/dev/null`,
      { timeout: 2000, encoding: 'utf8' },
    ).trim();

    if (!raw) return null;

    // lsof -t 只输出 pid，取第一个
    const pid = parseInt(raw.split('\n')[0], 10);
    if (!pid || isNaN(pid)) return null;

    // 获取命令
    let command = '';
    try {
      command = execSync(`ps -p ${pid} -o args= 2>/dev/null`, {
        timeout: 1000, encoding: 'utf8',
      }).trim();
    } catch { /* ignore */ }

    return { pid, command: command || `<pid ${pid}>` };
  } catch {
    return null;
  }
}

/**
 * 结构化的端口冲突信息 —— 给 UI 用。
 *
 * LLM 那条路要的是一段能读懂的文字 (preflightServiceCheck), UI 要的是可以据此渲染
 * "端口 X 被 Y 占用, 要不要接管/换端口" 的字段。同一份探测, 两种出口, 不重复实现。
 */
export interface PortConflict {
  port: number;
  pid: number;
  command: string;
  /** 占用者是不是 Neox 自己在管的进程 —— 是的话 UI 可以直接给"停掉它再起"的按钮 */
  tracked: boolean;
}

export function inspectPortConflict(
  command: string,
  processManager: ProcessManager,
): PortConflict | null {
  const port = inferTargetPort(command);
  if (!port) return null;
  const occupant = checkPort(port);
  if (!occupant) return null;
  return {
    port,
    pid: occupant.pid,
    command: occupant.command,
    tracked: !!processManager.get(occupant.pid),
  };
}

/**
 * 后台命令启动前的 pre-flight 检查。
 *
 * @returns 格式化的警告消息（LLM 应该据此决策），或 null（放行）
 */
export function preflightServiceCheck(
  command: string,
  processManager: ProcessManager,
  logger: PlatformLogger,
): string | null {
  const port = inferTargetPort(command);
  if (!port) return null; // 无法推断端口，放行

  const occupant = checkPort(port);
  if (!occupant) return null; // 端口空闲，放行

  // 是 Neox 自己管理的进程？
  const tracked = !!processManager.get(occupant.pid);

  logger.info('SHELL', `⚠️ Pre-flight: port ${port} occupied by pid=${occupant.pid} (tracked=${tracked})`);

  return formatServiceAlreadyRunning(
    { workspaceRoot: '', command },
    occupant.pid,
    port,
    occupant.command,
    tracked,
  );
}
