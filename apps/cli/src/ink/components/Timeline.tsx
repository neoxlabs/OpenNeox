import React from 'react';
import { Box, Text, Static } from '../../../vendor/ink/src/index.js';
import { UserMessage } from './messages/UserMessage.js';
import { AssistantMessage } from './messages/AssistantMessage.js';
import { ToolResultMessage } from './messages/ToolResultMessage.js';
import { InfoMessage } from './messages/InfoMessage.js';
import { ThinkingBlock } from './messages/ThinkingBlock.js';
import { ToolCard, TOOL_STYLES } from './messages/ToolCard.js';
import { PlanUpdateCard } from './messages/PlanUpdateCard.js';
import type { Message, PlanStreamEvent } from '@neoxlabs/kernel/types/index.js';
import type { TimelineEntry } from '../InkRuntime.js';

export interface TimelineProps {
  messages: Message[];
  entries?: TimelineEntry[];
  streamingMessageIndex?: number;
}

const TimelineComponent: React.FC<TimelineProps> = ({
  messages,
  entries,
  streamingMessageIndex
}) => {
  // Each entry is rendered independently, Static handles incremental output

  if (entries && entries.length > 0) {
    // Pre-render all entry elements
    const entryElements = React.useMemo(() => {
      return entries.map((entry, idx) => {
        const key = `entry-${entry.id}`;

        // 间距规则：所有节点前统一 2 行空行
        const needsSpacing = idx > 0;

        let content: React.ReactNode = null;

        // Info entries
        if (entry.type === 'info' && entry.text) {
          content = (
            <InfoMessage
              text={entry.text}
              details={entry.details}
              type="info"
              timestamp={entry.timestamp}
            />
          );
        }
        // Warning entries
        else if (entry.type === 'warning' && entry.text) {
          content = (
            <InfoMessage
              text={entry.text}
              details={entry.details}
              type="warning"
              timestamp={entry.timestamp}
            />
          );
        }
        // Error entries
        else if (entry.type === 'error' && entry.text) {
          content = (
            <InfoMessage
              text={entry.text}
              details={entry.details}
              type="error"
              timestamp={entry.timestamp}
            />
          );
        }
        // Thinking/Reasoning entries
        else if ((entry.type === 'thinking' || entry.type === 'reasoning') && entry.text) {
          content = (
            <ThinkingBlock
              content={entry.text}
              streaming={false}
              type={entry.type}
              timestamp={entry.timestamp}
            />
          );
        }
        // Assistant entries with raw text (no message payload)
        else if (entry.type === 'assistant' && entry.text && !entry.message) {
          const message: Message = {
            role: 'assistant',
            content: [{ type: 'text', text: entry.text }],
          };
          content = renderMessage(message, entry.id, entry.isStreaming, entry.timestamp);
        }
        // Plan entries (卡片风格)
        else if (entry.type === 'plan' && entry.planSteps) {
          const planEvent: PlanStreamEvent = {
            type: 'plan_update',
            explanation: entry.planExplanation,
            plan: entry.planSteps,
            timestamp: entry.timestamp.getTime(),
          };
          content = <PlanUpdateCard event={planEvent} timestamp={entry.timestamp} />;
        }
        // Tool card entries
        else if (TOOL_STYLES[entry.type as keyof typeof TOOL_STYLES] && entry.text) {
          content = (
            <ToolCard
              type={entry.type}
              message={entry.text}
              details={entry.details}
              timestamp={entry.timestamp}
              isStreaming={entry.isStreaming}
              memoryAction={entry.memoryAction}
              memorySearchQuery={entry.memorySearchQuery}
            />
          );
        }
        // Message entries
        else if (entry.message) {
          content = renderMessage(entry.message, entry.id, entry.isStreaming, entry.timestamp);
        }

        if (!content) return null;

        return (
          <Box key={key} flexDirection="column">
            {needsSpacing && <><Text>{''}</Text><Text>{''}</Text></>}
            {content}
          </Box>
        );
      });
    }, [entries]);

    return (
      <Static items={entryElements}>
        {(item) => item}
      </Static>
    );
  }

  // Fallback: render raw messages (already in correct order)
  return (
    <Box flexDirection="column">
      {messages.map((message, index) => {
        const isStreaming = streamingMessageIndex === index;
        return renderMessage(message, index, isStreaming);
      })}
    </Box>
  );
};

// Helper function to render a single message
function renderMessage(
  message: Message,
  index: number,
  streaming?: boolean,
  timestamp?: Date
): React.ReactNode {
  const key = `msg-${index}`;
  const hasToolResult =
    message.role === 'user' &&
    Array.isArray(message.content) &&
    message.content.some(c => (c as any).type === 'tool_result');

  if (hasToolResult) {
    return <ToolResultMessage key={key} message={message} timestamp={timestamp} />;
  }

  switch (message.role) {
    case 'user':
      return <UserMessage key={key} message={message} timestamp={timestamp} />;

    case 'assistant':
      return (
        <AssistantMessage
          key={key}
          message={message}
          streaming={streaming}
          timestamp={timestamp}
        />
      );

    case 'system':
    case 'tool':
      return (
        <Box key={key}>
          <Text color="gray" dimColor>
            [Unknown message type: {message.role}]
          </Text>
        </Box>
      );
  }
}

// This is critical for preventing excessive re-rendering during animations
export const Timeline = React.memo(TimelineComponent, (prevProps, nextProps) => {
  // Custom comparison: only re-render if entries or messages actually changed

  // Fast path: reference equality (works if useMemo is used in parent)
  if (prevProps.entries === nextProps.entries &&
      prevProps.messages === nextProps.messages &&
      prevProps.streamingMessageIndex === nextProps.streamingMessageIndex) {
    return true; // Props are equal, don't re-render
  }

  // Slow path: deep comparison
  const entriesEqual =
    prevProps.entries?.length === nextProps.entries?.length &&
    (prevProps.entries?.every((e, i) => {
      const next = nextProps.entries?.[i];
      // Compare entry ID and streaming state
      return e.id === next?.id && e.isStreaming === next?.isStreaming;
    }) ?? true);

  const messagesEqual = prevProps.messages === nextProps.messages;
  const streamingIndexEqual = prevProps.streamingMessageIndex === nextProps.streamingMessageIndex;

  return entriesEqual && messagesEqual && streamingIndexEqual;
});
