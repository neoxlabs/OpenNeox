import { cliLogger } from '../platform/cliLogger.js';
import type { StreamEvent } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { buildToolCallLifecycleEvents } from './runnerEventBuilders.js';
import { parseToolArguments, type ParsedToolArguments } from './toolArgsParser.js';

type ToolCallLike = {
  id: string;
  function: {
    name: string;
    arguments?: string;
  };
};

export function logParallelToolCallSummary(toolCalls: ToolCallLike[]): void {
  if (toolCalls.length <= 1) {
    return;
  }

  const toolNames = toolCalls
    .filter((toolCall): toolCall is ToolCallLike => !!toolCall?.function?.name)
    .map((toolCall) => toolCall.function.name);
  const uniqueTools = [...new Set(toolNames)];
  if (uniqueTools.length === 1 && toolNames.length > 1) {
    cliLogger.info('RUNNER', `🔄 Parallel calls: ${toolNames.length}x ${uniqueTools[0]} (different parameters)`);
    return;
  }

  cliLogger.info('RUNNER', `🔄 Parallel calls: ${toolNames.join(', ')}`);
}

export function buildParsedArgsByToolId(
  toolCalls: ToolCallLike[],
): Map<string, ParsedToolArguments> {
  const parsedArgsByToolId = new Map<string, ParsedToolArguments>();
  for (const toolCall of toolCalls) {
    if (!toolCall?.function) continue;
    parsedArgsByToolId.set(toolCall.id, parseToolArguments(toolCall.function.arguments, toolCall.function.name));
  }
  return parsedArgsByToolId;
}

export function buildToolCallLifecycleBatch(options: {
  toolCalls: ToolCallLike[];
  parsedArgsByToolId: Map<string, ParsedToolArguments>;
}): {
  events: StreamEvent[];
  toolCallCount: number;
} {
  const events: StreamEvent[] = [];
  for (const toolCall of options.toolCalls) {
    if (!toolCall?.function) continue;
    const parsedArgs = options.parsedArgsByToolId.get(toolCall.id);
    const isValidJson = parsedArgs?.ok ?? false;
    const rawArguments = toolCall.function.arguments || '';

    if (!isValidJson) {
      logger.toolError(
        toolCall.function.name,
        `Invalid JSON arguments (${parsedArgs?.reason || 'parse failed'}): ${rawArguments.substring(0, 200)}...`,
      );
    } else if (parsedArgs?.repaired) {
      cliLogger.warn('RUNNER', 'Tool arguments repaired from non-standard JSON', {
        tool: toolCall.function.name,
        callId: toolCall.id,
      });
    }

    events.push(
      ...buildToolCallLifecycleEvents({
        id: toolCall.id,
        name: toolCall.function.name,
        arguments: rawArguments,
        success: isValidJson,
      }),
    );
  }

  return {
    events,
    toolCallCount: options.toolCalls.length,
  };
}
