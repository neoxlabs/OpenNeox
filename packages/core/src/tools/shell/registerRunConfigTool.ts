/**
 * register_run_config — 声明一个可复用的 RunConfig (服务条目).
 *
 *   场景:
 *     · agent 跑起了一个 dev server, 想给它命名 + 把命令落盘, 之后能 manage_service.start 复用
 *     · 用户在 UI 上点"新建" 等价调用
 *
 *   写入 .neox/run-configs.json. 不启动进程, 只是登记元数据.
 *
 *   要启动: 用 execute_shell(command, bg=true) — 命令 + cwd 一致时会自动绑定到这个 config.
 *   要从一个已运行 ad-hoc 进程升级: 用 adopt 工具.
 */

import * as path from 'node:path';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { getServiceConfigStore } from '../../runtime/services/serviceConfigStoreCache.js';
import { getWorkspaceRootFromContext } from '@neoxlabs/kernel/tools/workspaceContext.js';

interface Args {
  id: string;
  name?: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  port?: number;
  autoOpenSurface?: boolean;
  pinned?: boolean;
}

export const registerRunConfigTool: Tool = {
  name: 'register_run_config',
  description: `Declare a reusable RunConfig (named service entry) in this workspace.

Writes to .neox/run-configs.json. Does NOT start the process — pure metadata registration.

Use when:
- You just got a dev server running and want to give it a stable name + reusable command
- User asks to "save this as a config" so it can be restarted later from the Services panel
- Setting up multiple services (backend + frontend + worker) up-front

Parameters:
- id (required): stable id, e.g. 'backend' / 'frontend-dev'. Used to look up later.
- name: display name. Defaults to id.
- command (required): the shell command, e.g. 'mvn spring-boot:run' or 'npm run dev'
- cwd: workspace-relative or absolute path. Defaults to workspace root.
- env: extra env vars, e.g. {"PORT":"8088"}. Use \${env:NAME} placeholders for secrets.
- port: declared port. Used for healthcheck + auto web-surface preview.
- autoOpenSurface: when true, after start auto-open a web Surface to localhost:\${port}
- pinned: pin in Services panel (default false)

Returns JSON: { ok, config }.

To launch this service:
  execute_shell({command: '<same command>', background: true})
  → will auto-bind to this config (Services panel shows it as Configured, not Ad-hoc).

To attach an already-running ad-hoc pid to a new config: use \`service_adopt\`.`,
  group: 'agent',
  resultType: 'ephemeral',
  parallelSafety: 'safe',
  isReadOnly: false,
  aliases: ['RegisterRunConfig', 'declare_service', 'service_register'],

  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Stable config id (e.g. "backend")' },
      name: { type: 'string', description: 'Display name. Defaults to id.' },
      command: { type: 'string', description: 'Shell command to run' },
      cwd: { type: 'string', description: 'Working directory (workspace-relative or absolute).' },
      env: { type: 'object', description: 'Environment variables for this service' },
      port: { type: 'number', description: 'Declared port (for healthcheck / web preview)' },
      autoOpenSurface: { type: 'boolean', description: 'Auto-open web Surface after start' },
      pinned: { type: 'boolean', description: 'Pin in Services panel' },
    },
    required: ['id', 'command'],
  },

  async function(args: Args): Promise<string> {
    if (!args?.id || !args?.command) {
      return JSON.stringify({ ok: false, error: 'id and command are required' });
    }
    const workspaceRoot = getWorkspaceRootFromContext();
    if (!workspaceRoot) {
      return JSON.stringify({ ok: false, error: 'workspace root not in context' });
    }
    const resolvedCwd = args.cwd
      ? (path.isAbsolute(args.cwd) ? args.cwd : path.resolve(workspaceRoot, args.cwd))
      : workspaceRoot;

    try {
      const store = getServiceConfigStore(workspaceRoot);
      const config = store.upsert({
        id: args.id,
        name: args.name || args.id,
        command: args.command,
        cwd: resolvedCwd,
        env: args.env,
        port: args.port,
        autoOpenSurface: args.autoOpenSurface,
        pinned: args.pinned,
        createdBy: 'agent',
      });
      return JSON.stringify({
        ok: true,
        config,
        hint: `Saved to .neox/run-configs.json. Start with execute_shell({command:'${config.command}', background:true}) — will auto-bind.`,
      });
    } catch (err: any) {
      return JSON.stringify({ ok: false, error: err?.message || String(err) });
    }
  },
};
