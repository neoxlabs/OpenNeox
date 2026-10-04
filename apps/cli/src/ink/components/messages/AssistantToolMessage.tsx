/**
 * AssistantToolMessage - 助理模式工具事件渲染组件
 */

import React from 'react';
import { Box, Text } from '../../../../vendor/ink/src/index.js';

export interface AssistantToolMessageProps {
  type:
    | 'assistant_spawn'
    | 'assistant_delegate'
    | 'assistant_query'
    | 'assistant_message'
    | 'assistant_wait'
    | 'assistant_terminate';
  text: string;
  details?: string;
  timestamp?: Date;
  toolName?: string;
  targetAgentId?: string;
  taskId?: string;
  result?: 'success' | 'error' | 'pending';
  sourceLabel?: string;
}

const ASSISTANT_TOOL_CONFIG: Record<
  string,
  { icon: string; color: 'cyan' | 'yellow' | 'blue' | 'magenta' | 'green' | 'red'; label: string }
> = {
  assistant_spawn: { icon: '+', color: 'cyan', label: 'spawn' },
  assistant_delegate: { icon: '»', color: 'yellow', label: 'delegate_task' },
  assistant_query: { icon: '?', color: 'blue', label: 'query_agent' },
  assistant_message: { icon: '>', color: 'magenta', label: 'send_message' },
  assistant_wait: { icon: '…', color: 'yellow', label: 'wait_result' },
  assistant_terminate: { icon: 'x', color: 'red', label: 'terminate_agent' },
};

export const AssistantToolMessage: React.FC<AssistantToolMessageProps> = ({
  type,
  text,
  details,
  timestamp,
  toolName,
  targetAgentId,
  taskId,
  result,
  sourceLabel,
}) => {
  const config = ASSISTANT_TOOL_CONFIG[type] || { icon: '>', color: 'blue' as const, label: 'assistant' };

  const resultColor = result === 'success' ? 'green' : result === 'error' ? 'red' : 'yellow';
  const resultIcon = result === 'success' ? '✓' : result === 'error' ? 'x' : '…';

  const hasAgentOrTask = targetAgentId || taskId;

  return (
    <Box flexDirection="column">
      <Box>
        <Text>{config.icon} </Text>
        <Text color={config.color} bold>
          {toolName || config.label}
        </Text>
        {sourceLabel && <Text dimColor> ({sourceLabel})</Text>}
        {result && (
          <Text color={resultColor}>
            {' '}
            {resultIcon}
          </Text>
        )}
      </Box>

      {hasAgentOrTask && (
        <Box>
          <Text dimColor>└─ </Text>
          {targetAgentId && (
            <Text>
              <Text dimColor>Agent: </Text>
              <Text color="cyan">{targetAgentId}</Text>
            </Text>
          )}
          {taskId && (
            <Text>
              <Text dimColor> Task: </Text>
              <Text color="yellow">{taskId}</Text>
            </Text>
          )}
        </Box>
      )}

      <Box>
        <Text dimColor>{hasAgentOrTask ? '   ' : '└─ '}</Text>
        <Text wrap="wrap">{text}</Text>
      </Box>

      {details && (
        <Box flexDirection="column">
          {details.split('\n').map((line, i) => (
            <Box key={i}>
              <Text dimColor>   </Text>
              <Text dimColor wrap="wrap">
                {line}
              </Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
};
