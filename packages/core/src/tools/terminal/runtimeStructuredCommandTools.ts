import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { runStructuredCommandFromRuntimeTools, type StructuredCommandArgs } from './structuredCommand.js';
import { createStructuredCommandTools } from './structuredCommandTools.js';

type RunCommand = (
  command: string,
  args: string[],
  cwd: string,
  options?: { timeoutMs?: number; signal?: AbortSignal }
) => Promise<{ stdout: string; stderr: string; exitCode: number; durationMs: number }>;

interface RuntimeStructuredCommandToolDeps {
  resolveWorkspacePath: (requestedPath?: string) => string;
  runCommand: RunCommand;
}

const MAX_COMMAND_OUTPUT_CHARS = 12000;
const MAX_ERROR_SNIPPET_CHARS = 4000;

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  return { text: `${text.slice(0, maxChars)}\n... (truncated)`, truncated: true };
}

export function createRuntimeStructuredCommandTools({
  resolveWorkspacePath,
  runCommand,
}: RuntimeStructuredCommandToolDeps): { runTests: Tool; runLint: Tool; runFormat: Tool } {
  async function runStructuredCommand(
    toolName: string,
    kind: 'test' | 'lint' | 'format',
    args: StructuredCommandArgs,
    toolCallId?: string,
  ): Promise<string> {
    return runStructuredCommandFromRuntimeTools({
      toolName,
      kind,
      args,
      resolveWorkspacePath,
      runCommand,
      truncateText,
      maxCommandOutputChars: MAX_COMMAND_OUTPUT_CHARS,
      maxErrorSnippetChars: MAX_ERROR_SNIPPET_CHARS,
      toolCallId,
    });
  }

  return createStructuredCommandTools({
    runStructuredCommand: (toolName, kind, args, toolCallId) => runStructuredCommand(toolName, kind, args, toolCallId),
  });
}
