import type { ToolCall as ParallelToolCall } from './parallelExecutor.js';
import type { ParsedToolArguments } from './toolArgsParser.js';

type ExecutableToolCallLike = {
  id: string;
  function: {
    name: string;
    arguments?: string;
  };
  [key: string]: any;
};

export function buildParallelToolCalls(options: {
  executableToolCalls: ExecutableToolCallLike[];
  parsedArgsByToolId: Map<string, ParsedToolArguments>;
}): ParallelToolCall[] {
  return options.executableToolCalls.map((toolCall) => ({
    ...toolCall, // Keep extra runtime fields (e.g. __kimi_builtin, thoughtSignature)
    id: toolCall.id,
    type: 'function' as const,
    function: {
      name: toolCall.function.name,
      arguments: (() => {
        const parsedArgs = options.parsedArgsByToolId.get(toolCall.id);
        if (!parsedArgs?.ok) {
          return toolCall.function.arguments || '';
        }
        return JSON.stringify(parsedArgs.args);
      })(),
    },
  }));
}
