import React from 'react';
import { Box, Text } from '../../../vendor/ink/src/index.js';
import { NeoxTheme } from '../theme.js';
import { getLanguage } from '../../i18n/index.js';

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

  const zh = getLanguage() === 'zh';
  return (
    <Box flexDirection="column">
      {messages.map((msg, index) => (
        <Box key={msg.id} justifyContent="space-between">
          <Box flexShrink={1}>
            <Text color={NeoxTheme.text.faint}>{(zh ? '排队 ' : 'queued ') + String(index + 1).padEnd(3)}</Text>
            <Text wrap="truncate-end">{msg.text}</Text>
          </Box>
          {index === 0 ? (
            <Box flexShrink={0} marginLeft={2}>
              <Text color={NeoxTheme.text.faint}>{zh ? '↑ 编辑' : '↑ edit'}</Text>
            </Box>
          ) : null}
        </Box>
      ))}
    </Box>
  );
};
