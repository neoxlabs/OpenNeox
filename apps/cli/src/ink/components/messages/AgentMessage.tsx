import React from 'react';
import { Box, Text } from '../../../../vendor/ink/src/index.js';
import type { AgentStatus } from '@neoxlabs/kernel/types/agent.js';

export interface AgentMessageProps {
  agentId: string;
  agentIndex: number;
  status: AgentStatus;
  task?: string;
  progress?: number;
  message?: string;
  error?: string;
  model?: string;
  timestamp?: Date;
  roleId?: string;
}

const STATUS_CONFIG: Record<AgentStatus, { icon: string; color: string }> = {
  idle: { icon: '○', color: 'gray' },
  running: { icon: '●', color: 'green' },
  waiting: { icon: '●', color: 'yellow' },
  completed: { icon: '✓', color: 'blue' },
  error: { icon: '✗', color: 'red' },
};

export const AgentMessage: React.FC<AgentMessageProps> = ({
  agentId, agentIndex, status, task, progress, message, error, model, roleId,
}) => {
  const { icon, color } = STATUS_CONFIG[status];
  const content = error || message || task || status;
  const progressBar = progress !== undefined
    ? `${'█'.repeat(Math.round(progress / 10))}${'░'.repeat(10 - Math.round(progress / 10))} ${progress}%`
    : '';

  return (
    <Box>
      <Text color={color as any} bold>{icon} Agent-{agentIndex}</Text>
      {roleId && <Text color="cyan"> [{roleId}]</Text>}
      {model && <Text dimColor> ({model})</Text>}
      {progressBar && <Text dimColor> {progressBar}</Text>}
      <Text dimColor> </Text>
      <Text color={status === 'error' ? 'red' : undefined} wrap="wrap">{content}</Text>
    </Box>
  );
};
