import React from 'react';
import { Box, Text } from '../../../vendor/ink/src/index.js';
import { formatTime } from '../utils/formatTime.js';

export interface ToolResultCardProps {
  title: string;
  icon?: string;
  color?: 'blue' | 'green' | 'yellow' | 'cyan' | 'magenta';
  content?: string;
  details?: Record<string, any>;
  timestamp?: Date;
}

/**
 * ToolResultCard - Generic card component for displaying tool results
 *
 * Used by all add*Result() methods to show tool execution results
 */
export const ToolResultCard: React.FC<ToolResultCardProps> = ({
  title,
  icon = '✓',
  color = 'green',
  content,
  details,
  timestamp,
}) => {
  // Format timestamp with milliseconds
  const timeStr = formatTime(timestamp);

  return (
    <Box flexDirection="column" marginY={0}>
      {/* Header with timestamp */}
      <Box>
        <Text color="gray" dimColor>{timeStr} • </Text>
        <Text color={color}>╭─ {icon} </Text>
        <Text bold color={color}>{title}</Text>
      </Box>

      {/* Main content */}
      {content && (
        <Box>
          <Text color={color}>               │  </Text>
          <Text>{content}</Text>
        </Box>
      )}

      {/* Details (key-value pairs) */}
      {details && Object.entries(details).map(([key, value]) => (
        <Box key={key}>
          <Text color={color}>               │  </Text>
          <Text color="cyan">{key}: </Text>
          <Text color="gray" dimColor>{String(value)}</Text>
        </Box>
      ))}

      {/* Bottom border */}
      <Box>
        <Text color={color}>               ╰────────────────────────────────────────</Text>
      </Box>
    </Box>
  );
};
