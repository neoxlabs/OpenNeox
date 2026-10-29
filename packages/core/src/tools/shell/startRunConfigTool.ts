
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { getWorkspaceRootFromContext } from '@neoxlabs/kernel/tools/workspaceContext.js';

interface Args {
  id: string;
}

export const startRunConfigTool: Tool = {
  name: 'start_run_config',
  description: `Start a saved service from the Services panel by its config id (same path as the panel's Start button).

Use after register_run_config to verify the saved command really starts. Returns the first seconds of output:
if the process already exited, read the error, fix the config with register_run_config (same id), and start again.
If it is still running, confirm it is ready (bash_output on the pid, or curl its port) before telling the user it works.`,
  group: 'agent',
  resultType: 'contextual',
  parallelSafety: 'unsafe',
  isReadOnly: false,
  aliases: ['service_start', 'run_config_start'],
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Config id in .neox/run-configs.json' },
    },
    required: ['id'],
  },

  async function(args: Args, ctx?: { sessionId?: string }): Promise<string> {
    if (!args?.id) return JSON.stringify({ ok: false, error: 'id is required' });
    const workspaceRoot = getWorkspaceRootFromContext();
    if (!workspaceRoot) return JSON.stringify({ ok: false, error: 'workspace root not in context' });
    const { startServiceByConfig } = await import('../../runtime/services/serviceLauncher.js');
    const result = await startServiceByConfig(workspaceRoot, args.id, ctx?.sessionId);
    if (!result.ok) return JSON.stringify({ ok: false, error: result.error, portConflict: result.portConflict });
    return result.output ?? JSON.stringify(result);
  },
};
