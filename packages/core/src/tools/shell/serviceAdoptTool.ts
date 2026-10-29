/**
 * service_adopt — LLM 接管系统中已有的进程
 *
 * 用户在自己终端里启动了 `npm run dev`，LLM 通过 service_scan 发现后，
 * 调 service_adopt 把它纳入 Neox processManager 管理：
 *   - 注册到 processManager → BackgroundTasksBar 能看到
 *   - 开始监控输出（通过 /proc/<pid>/fd 或轮询 lsof）
 *   - 绑定到 BackgroundTaskNotifier → 进程退出时 agent 收到通知
 *   - 之后就能用 bash_output / bash_kill 正常操作
 *
 * 也支持"接管并重启"模式：kill 旧进程 → 用 execute_shell(background=true) 重新起
 * 这样 Neox 从一开始就有完整的 PTY 输出流。
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { getToolServices } from '../runtimeToolServices.js';
import { getBackgroundTaskNotifier } from '../../runtime/shell/backgroundTaskNotifier.js';
import { getBackgroundTaskCallback } from './shellUiCallbacks.js';

interface AdoptArgs {
  pid: number;
  /** 可选：如果不传，自动通过 ps 获取 */
  command?: string;
  /** 接管模式：'attach' = 纳入管理保持运行(默认)，'restart' = kill 旧的然后提示 LLM 重新启动 */
  mode?: 'attach' | 'restart';
}

/** 通过 ps 获取进程的命令行和工作目录 */
function getProcessInfo(pid: number): { command: string; cwd: string; alive: boolean } | null {
  try {
    // 检查进程是否存活
    process.kill(pid, 0);
  } catch {
    return null;
  }

  let command = '';
  let cwd = '';

  try {
    command = execSync(`ps -p ${pid} -o args= 2>/dev/null`, {
      timeout: 2000, encoding: 'utf8',
    }).trim();
  } catch { /* ignore */ }

  try {
    // macOS: lsof -p <pid> -Fn | grep ^n.*cwd 不太好使，用 pwdx / proc
    if (process.platform === 'linux') {
      cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
    } else {
      // macOS: lsof -a -p <pid> -d cwd -Fn
      const raw = execSync(`lsof -a -p ${pid} -d cwd -Fn 2>/dev/null`, {
        timeout: 2000, encoding: 'utf8',
      });
      const match = raw.match(/\nn(.+)/);
      if (match) cwd = match[1];
    }
  } catch { /* ignore */ }

  return { command: command || `<unknown pid=${pid}>`, cwd: cwd || process.cwd(), alive: true };
}

/** 尝试读取进程最近的 stdout（best-effort） */
function tryReadRecentOutput(pid: number): string {
  try {
    if (process.platform === 'linux') {
      // Linux: /proc/<pid>/fd/1 是 stdout
      const fd1 = `/proc/${pid}/fd/1`;
      if (fs.existsSync(fd1)) {
        const stat = fs.statSync(fd1);
        if (stat.isFile() || stat.isSymbolicLink()) {
          const buf = Buffer.alloc(4096);
          const fd = fs.openSync(fd1, 'r');
          const bytesRead = fs.readSync(fd, buf, 0, 4096, Math.max(0, stat.size - 4096));
          fs.closeSync(fd);
          return buf.slice(0, bytesRead).toString('utf8');
        }
      }
    }
    // macOS: 没有好的方法直接读已运行进程的 stdout
    // 只能靠 adopt 后的轮询
    return '';
  } catch {
    return '';
  }
}

// ============================================================================
// Tool 定义
// ============================================================================

export const serviceAdoptTool: Tool = {
  name: 'service_adopt',
  description: `Take over management of an existing system process (not started by Neox).

USE THIS AFTER service_scan discovers a process you want to manage. Two modes:

**attach mode (default)**:
- Registers the process in Neox's process manager
- Enables bash_output(pid) and bash_kill(pid) for that process
- BackgroundTasksBar in the UI will show it
- When the process exits, you'll receive a <background-task-notification>
- Note: output capture is limited for already-running processes (no PTY). For full output, use restart mode.

**restart mode**:
- Kills the existing process gracefully (SIGTERM, escalates to SIGKILL after 3s)
- Returns instructions to re-launch with execute_shell(background=true) for full PTY output
- This is the recommended mode when you need to see the full output stream

When to use each mode:
- attach: You just need to monitor/kill the process, or confirm it's healthy
- restart: You need full output (logs, errors), or the process needs a config change

Parameters:
- pid (required): The OS process ID from service_scan
- command (optional): Override the command string (auto-detected from ps if omitted)
- mode (optional): 'attach' (default) or 'restart'`,
  group: 'agent',
  resultType: 'contextual',
  parallelSafety: 'safe',
  isReadOnly: false,
  aliases: ['adopt_service', 'takeover_process', 'attach_process'],

  parameters: {
    type: 'object',
    properties: {
      pid: {
        type: 'number',
        description: 'OS process ID to adopt (from service_scan results)',
      },
      command: {
        type: 'string',
        description: 'Override command string. Auto-detected from ps if omitted.',
      },
      mode: {
        type: 'string',
        enum: ['attach', 'restart'],
        description: 'attach = keep running & manage; restart = kill & re-launch. Default: attach.',
      },
    },
    required: ['pid'],
  },

  async function(args: AdoptArgs): Promise<string> {
    const pid = Number(args?.pid);
    if (!Number.isFinite(pid) || pid <= 0) {
      return JSON.stringify({ error: `Invalid pid: ${args?.pid}` });
    }

    const mode = args?.mode || 'attach';
    const services = getToolServices();
    const pm = services.processManager;

    // 已经被追踪？
    const existing = pm.get(pid);
    if (existing) {
      return JSON.stringify({
        pid,
        status: 'already_tracked',
        command: existing.command,
        process_status: existing.status,
        message: `Process pid=${pid} is already tracked by Neox. Use bash_output(${pid}) to read output, bash_kill(${pid}) to stop.`,
      });
    }

    // 获取进程信息
    const info = getProcessInfo(pid);
    if (!info) {
      return JSON.stringify({
        pid,
        status: 'not_found',
        error: `Process pid=${pid} is not alive. It may have already exited.`,
      });
    }

    const command = args?.command || info.command;

    // ==================== restart 模式 ====================
    if (mode === 'restart') {
      try {
        process.kill(pid, 'SIGTERM');
      } catch { /* ignore */ }

      // 等进程退出，最多 3s
      let exited = false;
      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 200));
        try { process.kill(pid, 0); } catch { exited = true; break; }
      }

      // 还没退就 SIGKILL
      if (!exited) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
        await new Promise(r => setTimeout(r, 500));
      }

      return JSON.stringify({
        pid,
        status: 'killed_for_restart',
        command,
        cwd: info.cwd,
        message: `Process pid=${pid} has been terminated. Now re-launch with:\n` +
          `  execute_shell(command="${command}", background=true)\n` +
          `This gives you full PTY output capture and lifecycle management.`,
        suggested_action: {
          tool: 'execute_shell',
          args: { command, background: true },
        },
      });
    }

    // ==================== attach 模式 ====================

    // 注册到 processManager — 内部做父子去重, 若新 pid 是已 tracked 祖先的后代会返回祖先 record
    const registered = pm.register({
      pid,
      command,
      cwd: info.cwd,
      workspaceRoot: info.cwd,
      /* 用户自己起的进程, 我们只是纳管以便在面板里看到它 —— 退出 Neox 时不许杀它.
       * 见 TrackedProcess.origin. */
      origin: 'adopted',
      background: true,
    });

    // 命中父子去重: register 返了另一个 pid → 这个 child 已隐式归属祖先 service, 不要再独立追踪
    if (registered.pid !== pid) {
      return JSON.stringify({
        pid,
        status: 'merged_into_ancestor',
        ancestor_pid: registered.pid,
        ancestor_command: registered.command,
        message: `Process pid=${pid} is a descendant of already-tracked pid=${registered.pid} ` +
          `(${registered.command.substring(0, 60)}). Skipped adopting separately — ` +
          `use bash_output(${registered.pid}) / bash_kill(${registered.pid}) to manage the service.`,
      });
    }

    // 绑定到 BackgroundTaskNotifier — 进程退出时 agent 收到通知
    const notifier = getBackgroundTaskNotifier();
    notifier.attach(pm);
    notifier.trackPid(pid, command);

    // 通知 UI (BackgroundTasksBar)
    const bgCallback = getBackgroundTaskCallback();
    bgCallback?.onAdd?.(command, pid);

    // 开始轮询进程存活状态（因为我们没有进程的 exit 事件句柄）
    const pollAlive = setInterval(() => {
      try {
        process.kill(pid, 0);
      } catch {
        // 进程已退出
        clearInterval(pollAlive);
        pm.markCompleted(pid, 0); // 无法获得 exit code，假设 0
        notifier.notifyTerminated(pid, 0, false);
      }
    }, 2000);

    // 5分钟后停止轮询（安全阀），让 GC 回收
    setTimeout(() => clearInterval(pollAlive), 5 * 60 * 1000);

    // 尝试读取已有输出
    const recentOutput = tryReadRecentOutput(pid);
    if (recentOutput) {
      pm.appendOutput(pid, recentOutput);
    }

    return JSON.stringify({
      pid,
      status: 'adopted',
      command,
      cwd: info.cwd,
      tracked: true,
      has_output: recentOutput.length > 0,
      message: `Process pid=${pid} is now under Neox management.\n` +
        `• bash_output(${pid}) — read output\n` +
        `• bash_kill(${pid}) — terminate\n` +
        `• BackgroundTasksBar will show it in the UI\n` +
        `• You'll receive <background-task-notification> when it exits\n` +
        (recentOutput.length === 0
          ? `Note: Limited output capture for adopted processes. For full PTY output, consider mode='restart'.`
          : `Captured ${recentOutput.length} bytes of recent output.`),
    });
  },
};
