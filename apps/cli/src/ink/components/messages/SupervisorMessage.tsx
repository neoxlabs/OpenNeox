import React from 'react';
import { Box, Text } from '../../../../vendor/ink/src/index.js';
import type { Message } from '@neoxlabs/kernel/types/index.js';

export interface SupervisorMessageProps {
  message: Message;
  timestamp?: Date;
  sourceLabel?: string;
  sourceType?: 'supervisor' | 'agent';
}

export const SupervisorMessage: React.FC<SupervisorMessageProps> = ({
  message,
  timestamp,
  sourceLabel,
  sourceType,
}) => {
  let textContent = '';
  if (typeof message.content === 'string') {
    textContent = message.content;
  } else if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (block.type === 'text') textContent += block.text;
    }
  }

  const isResponse = message.role === 'assistant';
  const label = sourceLabel || 'Supervisor';
  const icon = isResponse ? '●' : '❯';
  const color = 'magenta';

  return (
    <Box>
      <Text color={color} bold>{icon} {label} </Text>
      <Text wrap="wrap">{textContent}</Text>
    </Box>
  );
};
