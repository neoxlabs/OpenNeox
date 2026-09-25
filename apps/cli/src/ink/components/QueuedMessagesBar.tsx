import React from 'react';
import { Box, Text } from '../../../vendor/ink/src/index.js';

export interface QueuedMessage {
  id: number;
  text: string;
  timestamp: Date;
}

export interface QueuedMessagesBarProps {
  messages: QueuedMessage[];
}

/**
 * QueuedMessagesBar - Claude Code 风格的待发送消息显示
 *
 * 显示在 StatusLine 上方，类似：
 * ┌─ Queued ─────────────────────────────────────────────────────────────────────┐
 * │ > 你是谁                                                                      │
 * │ > 帮我写一个函数                                                              │
 * └──────────────────────────────────────────────────────────────────────────────┘
 * Press ↑ to edit queued messages
 */
export const QueuedMessagesBar: React.FC<QueuedMessagesBarProps> = ({ messages }) => {
  if (messages.length === 0) {
    return null;
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      {/* 标题行 */}
      <Box>
        <Text color="magenta" bold>┌─ </Text>
        <Text color="magenta" bold>Queued ({messages.length})</Text>
        <Text color="magenta" bold> ─</Text>
      </Box>

      {/* 消息列表 */}
      {messages.map((msg, index) => (
        <Box key={msg.id} paddingLeft={1}>
          <Text color="gray">│ </Text>
          <Text color="cyan" bold>&gt; </Text>
          <Text color="white">
            {msg.text.length > 70 ? msg.text.substring(0, 67) + '...' : msg.text}
          </Text>
        </Box>
      ))}

      {/* 底部边框 */}
      <Box>
        <Text color="magenta" bold>└─</Text>
        <Text dimColor> Press </Text>
        <Text color="yellow">↑</Text>
        <Text dimColor> to edit queued messages</Text>
      </Box>
    </Box>
  );
};
