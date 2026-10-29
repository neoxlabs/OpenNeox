import React from 'react';
import { Box, Text } from '../../../../vendor/ink/src/index.js';
import type { Message } from '@neoxlabs/kernel/types/index.js';

export interface ToolResultMessageProps {
  message: Message;
  toolName?: string;
  timestamp?: Date;
}

export const ToolResultMessage: React.FC<ToolResultMessageProps> = ({
  message,
  toolName,
  timestamp,
}) => {
  let content = '';
  let isError = false;

  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (block.type === 'tool_result') {
        content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content, null, 2);
        isError = block.is_error || false;
        break;
      }
    }
  } else if (typeof message.content === 'string') {
    content = message.content;
  }

  const preview = content.length > 120
    ? content.replace(/\n/g, ' ').slice(0, 120) + '…'
    : content.replace(/\n/g, ' ');

  const color = isError ? 'red' : 'green';
  const icon = isError ? '✗' : '✓';

  return (
    <Box>
      <Text color={color} bold>{icon} </Text>
      {toolName && <Text dimColor>{toolName} </Text>}
      <Text dimColor wrap="wrap">{preview}</Text>
    </Box>
  );
};
