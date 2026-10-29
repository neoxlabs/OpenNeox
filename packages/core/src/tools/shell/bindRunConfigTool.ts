/**
 * bind_run_config — 把一个已经在 Neox 跟踪里的 pid 绑定到一个 RunConfig (命名服务).
 *
 *   用法:
 *     1. agent 调 execute_shell(bg=true) 跑 'npm run dev' → pid=12345 (Ad-hoc)
 *     2. agent 觉得这是个值得长期持有的服务, 调:
 *        register_run_config({id:'frontend', command:'npm run dev', cwd:'.'})
 *        bind_run_config({pid:12345, config_id:'frontend'})
 *     3. 之后 Services panel 显示为 Configured (绿色, 跟 config 同名).
 *
 *   跟 service_adopt 的区别:
 *     · service_adopt: 接管 *Neox 外部* 的进程 (用户在终端起的). 涉及 register + notifier.
 *     · bind_run_config: 给 *已 Neox 跟踪的* 进程加 configId 元数据. 纯元数据操作.
 *
 *   不存在的 pid / 不存在的 config_id → 返 error.
 */

import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { getToolServices } from '../runtimeToolServices.js';
import { getServiceConfigStore } from '../../runtime/services/serviceConfigStoreCache.js';
import { getWorkspaceRootFromContext } from '@neoxlabs/kernel/tools/workspaceContext.js';

interface Args {
  pid: number;
  config_id: string;
}

export const bindRunConfigTool: Tool = {
  name: 'bind_run_config',
  description: `Attach a running, Neox-tracked process to a RunConfig (name it).

Use after \`execute_shell(bg=true)\` when you want to promote an ad-hoc background process
to a named service. The Services panel will then display it as Configured (green).

Parameters:
- pid (required): the pid from execute_shell or service_scan (must already be Neox-tracked)
- config_id (required): the id of an existing RunConfig (created via register_run_config)

If the process isn't tracked: use service_adopt first.
If the config doesn't exist: use register_run_config first.

Returns JSON: { ok, pid, config_id, name, message }.`,
  group: 'agent',
  resultType: 'ephemeral',
  parallelSafety: 'safe',
  isReadOnly: false,
  aliases: ['BindRunConfig', 'attach_to_config', 'service_link'],

  parameters: {
    type: 'object',
    properties: {
      pid: { type: 'number', description: 'OS process id (must already be Neox-tracked)' },
      config_id: { type: 'string', description: 'Existing RunConfig id' },
    },
    required: ['pid', 'config_id'],
  },

  async function(args: Args): Promise<string> {
    const pid = Number(args?.pid);
    if (!Number.isFinite(pid) || pid <= 0) {
      return JSON.stringify({ ok: false, error: `Invalid pid: ${args?.pid}` });
    }
    const configId = (args?.config_id || '').trim();
    if (!configId) {
      return JSON.stringify({ ok: false, error: 'config_id is required' });
    }

    const services = getToolServices();
    const pm = services.processManager;
    const proc = pm.get(pid);
    if (!proc) {
      return JSON.stringify({
        ok: false,
        error: `pid=${pid} not tracked by Neox. Use service_adopt({pid:${pid}}) first if it's an external process.`,
      });
    }

    const workspaceRoot = getWorkspaceRootFromContext();
    if (!workspaceRoot) {
      return JSON.stringify({ ok: false, error: 'workspace root not in context' });
    }
    const store = getServiceConfigStore(workspaceRoot);
    const config = store.get(configId);
    if (!config) {
      return JSON.stringify({
        ok: false,
        error: `RunConfig '${configId}' not found. Use register_run_config to create it first.`,
      });
    }

    pm.bindConfig(pid, config.id, config.name);
    const preamble = pm.consumeServicesPreambleIfChanged() || pm.servicesStatusLine();
    return JSON.stringify({
      ok: true,
      pid,
      config_id: config.id,
      name: config.name,
      services_status: preamble,
      message: `pid=${pid} bound to config '${config.id}' (${config.name}). Services panel will show as Configured.`,
    });
  },
};
