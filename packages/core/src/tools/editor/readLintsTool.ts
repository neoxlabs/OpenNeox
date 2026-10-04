/**
 * read_lints — Cursor-style: 读当前 IDE (Monaco) 诊断, 不是跑 npm run lint.
 */

import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { getDiagnosticsExecutor } from './diagnosticsExecutorRegistry.js';

interface ReadLintsArgs {
  paths?: string[];
  path?: string;
  limit?: number;
}

export const readLintsTool: Tool = {
  name: 'read_lints',
  description:
    'Read current IDE diagnostics (Monaco markers / TypeScript / Neox inspection) for open or given files. '
    + 'Prefer this after edits to see red/yellow squiggles without running a full project lint. '
    + 'Returns path, line, severity, message. Empty list = no markers in scope (file may need to be open in the editor).',
  group: 'agent',
  resultType: 'contextual',
  parallelSafety: 'safe',
  isReadOnly: true,
  capabilities: ['editor'],
  aliases: ['get_diagnostics', 'read_diagnostics', 'ReadLints'],

  parameters: {
    type: 'object',
    properties: {
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional absolute or workspace-relative file paths to filter. Omit = all models with markers.',
      },
      path: {
        type: 'string',
        description: 'Single path shorthand (same as paths:[path]).',
      },
      limit: {
        type: 'number',
        description: 'Max diagnostics to return (default 80).',
      },
    },
  },

  async function(args: ReadLintsArgs): Promise<string> {
    const executor = getDiagnosticsExecutor();
    if (!executor) {
      return JSON.stringify({
        error: 'IDE diagnostics bridge unavailable (desktop UI not connected).',
        next: 'Open the file in the Neox IDE editor, or use run_lint / execute_shell for project lint scripts.',
      });
    }

    const paths: string[] = [];
    if (typeof args?.path === 'string' && args.path.trim()) paths.push(args.path.trim());
    if (Array.isArray(args?.paths)) {
      for (const p of args.paths) {
        if (typeof p === 'string' && p.trim()) paths.push(p.trim());
      }
    }

    try {
      const items = await executor({
        paths: paths.length > 0 ? paths : undefined,
        limit: typeof args?.limit === 'number' ? args.limit : 80,
      });
      return JSON.stringify({
        count: items.length,
        diagnostics: items,
        note: items.length === 0
          ? 'No IDE markers in scope. Ensure the file is open (or was recently open) in the editor so Monaco/TS can publish diagnostics.'
          : undefined,
      });
    } catch (err: any) {
      return JSON.stringify({
        error: err?.message || String(err),
        next: 'Retry after focusing the IDE editor, or fall back to run_lint.',
      });
    }
  },
};
