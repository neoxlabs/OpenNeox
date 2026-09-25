
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { getToolServices } from '../runtimeToolServices.js';

interface BashKillArgs {
  pid: number;
  /** SIGTERM(默认,2s 内转 SIGKILL)或 SIGKILL(立即)*/
  force?: boolean;
}

export const bashKillTool: Tool = {
  name: 'bash_kill',
  description: `Terminate a background shell process started with execute_shell(background=true).

Use this when:
- A long-running background task is no longer needed (e.g. user asked you to stop the dev server)
- A runaway process needs to be killed

Parameters:
- pid (required): OS process id
- force (optional): true = SIGKILL immediately; false (default) = SIGTERM, escalates to SIGKILL after 2s

Returns JSON with: { pid, status, killed, message }.`,
  group: 'agent',
  resultType: 'ephemeral',
  parallelSafety: 'safe',
  isReadOnly: false,
  aliases: ['KillShell', 'bash-kill', 'TaskStop', 'shell_kill', 'kill_shell'],

  parameters: {
    type: 'object',
    properties: {
      pid: {
        type: 'number',
        description: 'The OS process id of the background shell task',
      },
      force: {
        type: 'boolean',
        description: 'If true, send SIGKILL immediately. Default: false (graceful SIGTERM).',
      },
    },
    required: ['pid'],
  },

  async function(args: BashKillArgs): Promise<string> {
    const pid = Number(args?.pid);
    if (!Number.isFinite(pid) || pid <= 0) {
      return JSON.stringify({ error: `Invalid pid: ${args?.pid}` });
    }
    const force = args?.force === true;

    const services = getToolServices();
    const pm = services.processManager;
    const proc = pm.get(pid);
    if (!proc) {
      return JSON.stringify({
        pid,
        killed: false,
        error: `No tracked process with pid=${pid}. It may have already exited.`,
      });
    }
    if (proc.status !== 'running') {
      return JSON.stringify({
        pid,
        killed: false,
        status: proc.status,
        message: `Process ${pid} is not running (status=${proc.status}).`,
      });
    }

    // Background processes are started detached with process group → prefer killProcessGroup.
    // Foreground processes don't set up a group → fall back to direct kill.
    // terminatedBy='agent' — bash_kill 是 LLM agent 主动调的工具, 标记给 BG_NOTIFIER 用
    const ok = proc.background
      ? pm.killProcessGroup(pid, force ? 'SIGKILL' : 'SIGTERM', 'agent')
      : pm.kill(pid, force ? 'SIGKILL' : 'SIGTERM', /* force (escalate after 2s) */ !force, 'agent');

    const display = pm.snapshotForDisplay(pid);
    /* P0-6: kill 后服务状态必变, 永远塞 preamble (force-call consume 来推进 hash). */
    const preamble = pm.consumeServicesPreambleIfChanged() || pm.servicesStatusLine();
    return JSON.stringify({
      pid,
      command: proc.command,
      display_name: display?.display_name,
      config_id: proc.configId,
      port: proc.port,
      killed: ok,
      status: ok ? 'killed' : proc.status,
      services_status: preamble,
      message: ok
        ? `Sent ${force ? 'SIGKILL' : 'SIGTERM'} to pid ${pid} (${display?.display_name ?? proc.command.slice(0, 60)})`
        : `Failed to kill pid ${pid}. Process may have already exited.`,
    });
  },
};
