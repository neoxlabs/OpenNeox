/**
 * 通用的消息卡片组件
 * 所有消息都使用这个统一的卡片布局
 */
import React from 'react';
import { Box, Text } from '../../../../vendor/ink/src/index.js';
import { formatTime } from '../../utils/formatTime.js';
import { CARD_LAYOUT, type CardColor } from './cardStyles.js';

export interface MessageCardProps {
  color: CardColor;
  icon: string;
  title: string;
  timestamp?: Date;
  streaming?: boolean;
  subtitle?: string;
  showTimestamp?: boolean; // 控制时间戳显示
  children: React.ReactNode;
}

/**
 * 统一的消息卡片组件
 *
 * 视觉效果（显示时间戳）:
 * 09:30:27.411 • ╭─ ◆ Assistant
 *                 │  内容行1
 *                 │  内容行2
 *                 ╰────────────────────────────────
 *
 * 视觉效果（隐藏时间戳）:
 * ╭─ ◆ Assistant
 * │  内容行1
 * │  内容行2
 * ╰────────────────────────────────
 */
export const MessageCard: React.FC<MessageCardProps> = ({
  color,
  icon,
  title,
  timestamp,
  streaming = false,
  subtitle,
  showTimestamp = true, // 默认显示时间戳
  children,
}) => {
  const timeStr = showTimestamp ? formatTime(timestamp) : null;

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box>
        {timeStr && (
          <>
            <Text dimColor>{timeStr} • </Text>
          </>
        )}
        <Text color={color}>╭─ {icon} </Text>
        <Text bold color={color}>{title}</Text>
        {subtitle && <Text dimColor> {subtitle}</Text>}
        {streaming && <Text color="yellow"> …</Text>}
      </Box>

      {/* Content */}
      {children}

      {/* Bottom border */}
      <Box>
        <Text color={color}>
          {showTimestamp ? CARD_LAYOUT.LEFT_PADDING : ''}╰{'─'.repeat(CARD_LAYOUT.BORDER_LENGTH)}
        </Text>
      </Box>
    </Box>
  );
};

/**
 * 卡片内容行组件
 */
export interface CardContentLineProps {
  color: CardColor;
  showTimestamp?: boolean; // 控制时间戳显示
  children: React.ReactNode;
}

export const CardContentLine: React.FC<CardContentLineProps> = ({
  color,
  showTimestamp = true, // 默认显示时间戳
  children
}) => {
  return (
    <Box flexDirection="row">
      <Text color={color}>
        {showTimestamp ? CARD_LAYOUT.LEFT_PADDING : ''}│
      </Text>
      <Box flexDirection="column" flexShrink={1}>
        {children}
      </Box>
    </Box>
  );
};
