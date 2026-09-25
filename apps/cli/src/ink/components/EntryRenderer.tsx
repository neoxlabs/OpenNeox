import React from 'react';
import { Box, Text } from '../../../vendor/ink/src/index.js';
import { UserMessage } from './messages/UserMessage.js';
import { SupervisorMessage } from './messages/SupervisorMessage.js';
import { AssistantMessage } from './messages/AssistantMessage.js';
import { AssistantToolMessage } from './messages/AssistantToolMessage.js';
import { ToolResultMessage } from './messages/ToolResultMessage.js';
import { InfoMessage } from './messages/InfoMessage.js';
import { StepResult } from './messages/step.js';
import { ThinkingBlock } from './messages/ThinkingBlock.js';
import { ToolCard, TOOL_STYLES } from './messages/ToolCard.js';
import { PlanUpdateCard } from './messages/PlanUpdateCard.js';
import { AgentMessage } from './messages/AgentMessage.js';
import { TaskAgentCard } from './messages/TaskAgentCard.js';
import { AskUserQuestionCard } from './messages/AskUserQuestionCard.js';
import { ToolGroupCard } from './messages/ToolGroupCard.js';
import { Header } from './Header.js';
import type { Message, PlanStreamEvent } from '@neoxlabs/kernel/types/index.js';
import type { TimelineEntry, TimelineDensity } from '../InkRuntime.js';

export interface EntryRendererProps {
  entry: TimelineEntry;
  thinkingCollapsed?: boolean;
  /** Timeline density (传下来用于 tool_group 渲染) */
  density?: TimelineDensity;
}

/**
 * EntryRenderer - Renders a single timeline entry
 * This is a pure rendering component, designed to be used with Static component
 */
const EntryRendererComponent: React.FC<EntryRendererProps> = ({ entry, thinkingCollapsed = true, density = 'medium' }) => {
  let content: React.ReactNode = null;

  if (entry.type === 'header_reemit' && entry.headerSnapshot) {
    return <Header {...entry.headerSnapshot} />;
  }

  if (entry.type === 'tool_group' && entry.toolGroup) {
    const renderDensity = density === 'compact' ? 'compact' : 'medium';
    return (
      <ToolGroupCard
        groups={entry.toolGroup.groups}
        originalIds={entry.toolGroup.originalIds}
        totalCount={entry.toolGroup.totalCount}
        density={renderDensity}
      />
    );
  }

  if (entry.type === 'user' && entry.message) {
    content = (
      <UserMessage
        message={entry.message}
        timestamp={entry.timestamp}
        sourceLabel={entry.sourceLabel}
      />
    );
  }
  else if (entry.type === 'assistant' && entry.text && !entry.message) {
    const message: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: entry.text }],
    };
    content = (
      <AssistantMessage
        message={message}
        streaming={entry.isStreaming}
        timestamp={entry.timestamp}
        sourceLabel={entry.sourceLabel}
      />
    );
  }
  // Info entries
  else if (entry.type === 'info' && entry.text) {
    content = (
      <InfoMessage
        text={entry.text}
        details={entry.details}
        type="info"
        timestamp={entry.timestamp}
        sourceLabel={entry.sourceLabel}
      />
    );
  }
  // esc 中断: 挂在上一条下面的一行灰字, 不是独立的一条消息
  else if ((entry.type as string) === 'interrupted' && entry.text) {
    content = <Box paddingLeft={2}><StepResult lines={[entry.text]} /></Box>;
  }
  // Warning entries
  else if (entry.type === 'warning' && entry.text) {
    content = (
      <InfoMessage
        text={entry.text}
        details={entry.details}
        type="warning"
        timestamp={entry.timestamp}
        sourceLabel={entry.sourceLabel}
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
        sourceLabel={entry.sourceLabel}
      />
    );
  }
  // Thinking/Reasoning entries
  else if ((entry.type === 'thinking' || entry.type === 'reasoning') && entry.text) {
    content = (
      <ThinkingBlock
        content={entry.text}
        streaming={entry.isStreaming}
        collapsed={thinkingCollapsed}
        type={entry.type}
        timestamp={entry.timestamp}
        sourceLabel={entry.sourceLabel}
      />
    );
  }
  else if (entry.type === 'plan' && entry.planSteps) {
    const planEvent: PlanStreamEvent = {
      type: 'plan_update',
      explanation: entry.planExplanation,
      plan: entry.planSteps,
      timestamp: entry.timestamp.getTime(),
    };
    content = <PlanUpdateCard event={planEvent} timestamp={entry.timestamp} sourceLabel={entry.sourceLabel} />;
  }
  else if (entry.type === 'queued_message' && entry.text) {
    // 构造一个 Message 对象来复用 UserMessage 组件
    const queuedMessage = {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: entry.text }],
    };
    content = (
      <UserMessage
        message={queuedMessage}
        timestamp={entry.timestamp}
        sourceLabel={entry.sourceLabel || 'Queued'}
      />
    );
  }
  else if (entry.type === 'supervisor' && entry.message) {
    content = (
      <SupervisorMessage
        message={entry.message}
        timestamp={entry.timestamp}
        sourceLabel={entry.sourceLabel}
        sourceType={entry.sourceType}
      />
    );
  }
  else if (
    (entry.type === 'agent_spawn' ||
     entry.type === 'agent_progress' ||
     entry.type === 'agent_complete' ||
     entry.type === 'agent_error') &&
    entry.agentId
  ) {
    content = (
      <AgentMessage
        agentId={entry.agentId}
        agentIndex={entry.agentIndex || 1}
        status={entry.agentStatus || 'running'}
        task={entry.agentTask}
        progress={entry.agentProgress}
        message={entry.text}
        error={entry.agentError}
        model={entry.agentModel}
        timestamp={entry.timestamp}
        roleId={entry.agentRoleId}
      />
    );
  }
  else if (entry.type === 'ask_user' && entry.askUserQuestions) {
    content = (
      <AskUserQuestionCard
        questions={entry.askUserQuestions}
        timestamp={entry.timestamp}
        sourceLabel={entry.sourceLabel}
      />
    );
  }
  else if (entry.type === 'task_agent_progress' && entry.taskAgentId) {
    content = (
      <TaskAgentCard
        agentId={entry.taskAgentId}
        role={entry.taskAgentRole || 'Task'}
        task={entry.taskAgentTask || ''}
        status={entry.taskAgentStatus || 'running'}
        toolCount={entry.taskAgentToolCount || 0}
        tokens={entry.taskAgentTokens || 0}
        elapsed={entry.taskAgentElapsed || 0}
        toolRecords={entry.taskAgentToolRecords}
        timestamp={entry.timestamp}
        sourceLabel={entry.sourceLabel}
        groupMembers={entry.taskAgentGroupMembers}
      />
    );
  }
  else if (
    (entry.type === 'assistant_spawn' ||
     entry.type === 'assistant_delegate' ||
     entry.type === 'assistant_query' ||
     entry.type === 'assistant_message' ||
     entry.type === 'assistant_wait' ||
     entry.type === 'assistant_terminate') &&
    entry.text
  ) {
    content = (
      <AssistantToolMessage
        type={entry.type}
        text={entry.text}
        details={entry.details}
        timestamp={entry.timestamp}
        toolName={entry.assistantToolName}
        targetAgentId={entry.assistantTargetAgentId}
        taskId={entry.assistantTaskId}
        result={entry.assistantResult}
        sourceLabel={entry.sourceLabel}
      />
    );
  }
  // Tool card entries (包括 command_exec, command_running 等)
  else if (TOOL_STYLES[entry.type as keyof typeof TOOL_STYLES] && entry.text) {
    content = (
      <ToolCard
        type={entry.type}
        message={entry.text}
        details={entry.details}
        timestamp={entry.timestamp}
        isStreaming={entry.isStreaming}
        isComplete={entry.isComplete}
        sourceLabel={entry.sourceLabel}
        memoryAction={entry.memoryAction}
        memorySearchQuery={entry.memorySearchQuery}
      />
    );
  }
  // Message entries
  else if (entry.message) {
    content = renderMessage(entry.message, entry.id, entry.isStreaming, entry.timestamp, entry.sourceLabel);
  }

  if (!content) {
    return null;
  }

  return (
    <Box flexDirection="column">
      {content}
    </Box>
  );
};

// Helper function to render a single message
function renderMessage(
  message: Message,
  index: number,
  streaming?: boolean,
  timestamp?: Date,
  sourceLabel?: string,
): React.ReactNode {
  const key = `msg-${index}`;
  const hasToolResult =
    message.role === 'user' &&
    Array.isArray(message.content) &&
    message.content.some(c => c.type === 'tool_result');

  if (hasToolResult) {
    return <ToolResultMessage key={key} message={message} timestamp={timestamp} />;
  }

  switch (message.role) {
    case 'user':
      return <UserMessage key={key} message={message} timestamp={timestamp} sourceLabel={sourceLabel} />;

    case 'assistant':
      return (
        <AssistantMessage
          key={key}
          message={message}
          streaming={streaming}
          timestamp={timestamp}
          sourceLabel={sourceLabel}
        />
      );

    case 'system':
    case 'tool':
      // Check if this is a tool result message (user role with tool_result content)
      // Note: We cast to Message to bypass TypeScript's narrowing
      const msg = message as Message;
      if (
        msg.role === 'user' &&
        Array.isArray(msg.content) &&
        msg.content.some(c => c.type === 'tool_result')
      ) {
        return <ToolResultMessage key={key} message={msg} timestamp={timestamp} />;
      }

      return (
        <Box key={key}>
          <Text color="gray" dimColor>
            [Unknown message type: {message.role}]
          </Text>
        </Box>
      );
  }
}

export const EntryRenderer = React.memo(EntryRendererComponent, (prevProps, nextProps) => {
  return prevProps.entry.id === nextProps.entry.id &&
         prevProps.entry.isStreaming === nextProps.entry.isStreaming &&
         prevProps.entry.text === nextProps.entry.text &&
         prevProps.entry.details === nextProps.entry.details &&
         prevProps.entry.assistantResult === nextProps.entry.assistantResult &&
         prevProps.entry.taskAgentStatus === nextProps.entry.taskAgentStatus &&
         prevProps.entry.taskAgentToolCount === nextProps.entry.taskAgentToolCount &&
         prevProps.entry.taskAgentTokens === nextProps.entry.taskAgentTokens &&
         prevProps.entry.taskAgentElapsed === nextProps.entry.taskAgentElapsed &&
         prevProps.entry.taskAgentToolRecords === nextProps.entry.taskAgentToolRecords &&
         prevProps.entry.taskAgentGroupMembers === nextProps.entry.taskAgentGroupMembers &&
         prevProps.thinkingCollapsed === nextProps.thinkingCollapsed;
});
