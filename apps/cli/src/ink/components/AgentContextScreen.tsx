import React from 'react';
import { Box, Text, useInput, useStdout } from '../../../vendor/ink/src/index.js';
import type { AgentContextStats } from '@neoxlabs/kernel/types/agent.js';

export interface AgentContextScreenProps {
  agentContextStats: AgentContextStats[];
  onClose: () => void;
}

const formatNumber = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
};

const getStatusIcon = (status?: string): { icon: string; color: string } => {
  switch (status) {
    case 'running': return { icon: '●', color: 'green' };
    case 'waiting': return { icon: '◐', color: 'yellow' };
    case 'completed': return { icon: '✓', color: 'blue' };
    case 'error': return { icon: '✗', color: 'red' };
    default: return { icon: '○', color: 'gray' };
  }
};

export const AgentContextScreen: React.FC<AgentContextScreenProps> = ({
  agentContextStats,
  onClose,
}) => {
  const { columns } = useStdout();

  useInput((input, key) => {
    if (key.escape || input === 'q') {
      onClose();
    }
  }, { isActive: true });

  const stats = [...agentContextStats].sort((a, b) => {
    if (a.agentId === 'Main') return -1;
    if (b.agentId === 'Main') return 1;
    return a.agentLabel.localeCompare(b.agentLabel);
  });

  return (
    <Box flexDirection="column" width="100%">
      <Box justifyContent="space-between">
        <Text bold color="cyan">Agent Context Overview</Text>
        <Text dimColor>ESC to close</Text>
      </Box>
      <Text color="gray">{'─'.repeat(Math.max(columns, 10))}</Text>
      {stats.length === 0 ? (
        <Text dimColor>No agent context stats available.</Text>
      ) : (
        stats.map((stat) => {
          const contextWindow = stat.contextWindow || 0;
          const tokensUsed = stat.tokensUsedForContext || 0;
          const pressure = contextWindow > 0 ? tokensUsed / contextWindow : 0;
          const percentage = Math.round(pressure * 100);
          const { icon, color } = getStatusIcon(stat.status);
          const task = stat.currentTask
            ? (stat.currentTask.length > 40 ? `${stat.currentTask.slice(0, 37)}...` : stat.currentTask)
            : '';

          return (
            <Box key={stat.agentId} justifyContent="space-between" marginTop={1}>
              <Box>
                <Text color="magenta">{stat.agentLabel}</Text>
                <Text dimColor> </Text>
                <Text color={color as any}>{icon}</Text>
                {task && (
                  <>
                    <Text dimColor> </Text>
                    <Text dimColor>{task}</Text>
                  </>
                )}
              </Box>
              <Box>
                <Text dimColor>in </Text>
                <Text color="cyan">{formatNumber(stat.input)}</Text>
                <Text dimColor> out </Text>
                <Text color="green">{formatNumber(stat.output)}</Text>
                {(stat.cacheCreationTokens || stat.cacheReadTokens) && (
                  <>
                    <Text dimColor> cache-w </Text>
                    <Text color="magenta">{formatNumber(stat.cacheCreationTokens || 0)}</Text>
                    <Text dimColor> cache-r </Text>
                    <Text color="blue">{formatNumber(stat.cacheReadTokens || 0)}</Text>
                  </>
                )}
                <Text dimColor> │ context </Text>
                <Text color="yellow">{formatNumber(tokensUsed)}</Text>
                <Text dimColor>/</Text>
                <Text color="yellow">{formatNumber(contextWindow)}</Text>
                <Text dimColor> (</Text>
                <Text color={pressure > 0.8 ? 'red' : pressure > 0.5 ? 'yellow' : 'green'}>{percentage}%</Text>
                <Text dimColor>)</Text>
              </Box>
            </Box>
          );
        })
      )}
      <Text color="gray">{'─'.repeat(Math.max(columns, 10))}</Text>
      <Text dimColor>Tip: Press Q or ESC to return</Text>
    </Box>
  );
};
