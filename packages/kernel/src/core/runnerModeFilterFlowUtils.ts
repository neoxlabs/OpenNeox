import { cliLogger } from '../platform/cliLogger.js';
import type { StreamEvent } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { buildToolOutputEvents } from './runnerEventBuilders.js';
import { filterToolCallsByMode } from './runnerModeFilterUtils.js';

type ToolCallLike = {
  id: string;
  function: {
    name: string;
    arguments?: string;
  };
  [key: string]: any;
};

type MemoryLike = {
  addToolResult: (id: string, name: string, output: string) => void;
};

export function applyModeFilterWithEvents(options: {
  toolCalls: ToolCallLike[];
  allowedToolNames: Set<string>;
  currentMode: string;
  memory: MemoryLike;
}): {
  executableToolCalls: ToolCallLike[];
  events: StreamEvent[];
} {
  const filteredByMode = filterToolCallsByMode({
    toolCalls: options.toolCalls,
    allowedToolNames: options.allowedToolNames,
    currentMode: options.currentMode,
  });

  const events: StreamEvent[] = [];
  for (const blockedCall of filteredByMode.blockedToolCalls) {
    logger.toolError(blockedCall.toolCall.function.name, blockedCall.denialOutput);
    const [toolOutputEvent, legacyToolOutputEvent] = buildToolOutputEvents({
      id: blockedCall.toolCall.id,
      name: blockedCall.toolCall.function.name,
      output: blockedCall.denialOutput,
      success: false,
    });
    events.push(toolOutputEvent, legacyToolOutputEvent);
    options.memory.addToolResult(
      blockedCall.toolCall.id,
      blockedCall.toolCall.function.name,
      blockedCall.denialOutput,
    );
    cliLogger.info(
      'PERMISSION',
      `Tool blocked by mode: ${blockedCall.toolCall.function.name} - ${blockedCall.denialOutput}`,
    );
  }

  return {
    executableToolCalls: filteredByMode.executableToolCalls,
    events,
  };
}
