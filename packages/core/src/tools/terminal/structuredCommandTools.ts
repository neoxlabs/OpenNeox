import { ToolCategory } from '@neoxlabs/kernel/types/permissions.js';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import type { StructuredCommandArgs } from './structuredCommand.js';

export function createStructuredCommandTools(params: {
  runStructuredCommand: (
    toolName: string,
    kind: 'test' | 'lint' | 'format',
    args: StructuredCommandArgs,
    toolCallId?: string,
  ) => Promise<string>;
}): {
  runTests: Tool;
  runLint: Tool;
  runFormat: Tool;
} {
  const sharedParameters = {
    type: 'object' as const,
    properties: {
      preset: {
        type: 'string',
        description: 'Command preset (npm|pnpm|yarn|bun|pytest|go|cargo|make|maven|gradle|flutter). Python projects use "pytest" for all three tools (test→pytest, lint→ruff check, format→ruff format). Omit to auto-detect from the project files in cwd.',
      },
      command: {
        type: 'string',
        description: 'Explicit command (overrides preset)',
      },
      extra_args: {
        type: 'array',
        items: { type: 'string' },
        description: 'Additional args for the command',
      },
      cwd: {
        type: 'string',
        description: 'Working directory (default: workspace root)',
      },
      timeout_ms: {
        type: 'number',
        description: 'Timeout in milliseconds (default: 300000)',
      },
    },
  };

  const sharedPermission = {
    category: ToolCategory.EXECUTE,
    allowInAskMode: false,
  };

  const runTests: Tool = {
    name: 'run_tests',
    description: 'Run project tests with a structured command',
    parameters: sharedParameters,
    permission: sharedPermission,
    async function(args, context) {
      return params.runStructuredCommand('run_tests', 'test', args as StructuredCommandArgs, (context as any)?.toolCallId);
    },
  };

  const runLint: Tool = {
    name: 'run_lint',
    description: 'Run project lint with a structured command',
    parameters: sharedParameters,
    permission: sharedPermission,
    async function(args, context) {
      return params.runStructuredCommand('run_lint', 'lint', args as StructuredCommandArgs, (context as any)?.toolCallId);
    },
  };

  const runFormat: Tool = {
    name: 'run_format',
    description: 'Run project formatting with a structured command',
    parameters: sharedParameters,
    permission: sharedPermission,
    async function(args, context) {
      return params.runStructuredCommand('run_format', 'format', args as StructuredCommandArgs, (context as any)?.toolCallId);
    },
  };

  return {
    runTests,
    runLint,
    runFormat,
  };
}
