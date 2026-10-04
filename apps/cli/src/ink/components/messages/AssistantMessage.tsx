import React from 'react';
import { Box, Text } from '../../../../vendor/ink/src/index.js';
import type { Message } from '@neoxlabs/kernel/types/index.js';
import { MarkdownText } from '../MarkdownText.js';
import { Step, ToolTitle } from './step.js';
import { NeoxTheme } from '../../theme.js';

/** 已有专用渲染的工具 — 不在 AssistantMessage 里重复显示 */
const HIDDEN_TOOL_USES = new Set([
  'update_plan', 'verify_step',
  'explore',
  // Legacy tools
  'spawn_agent', 'delegate_task', 'query_agent',
  'send_message', 'wait_result', 'wait_all', 'terminate_agent',
  // New Agent OS tools
  'spawn_process', 'list_processes', 'read_process_output',
  'kill_process', 'wait_process', 'send_to_process',
  // Team orchestration
  'create_team',
  'ask_user',
  'select_tools', 'call_tool',
  'agent', 'Agent',
]);

export interface AssistantMessageProps {
  message: Message;
  streaming?: boolean;
  timestamp?: Date;
  sourceLabel?: string;
}

export const AssistantMessage: React.FC<AssistantMessageProps> = ({
  message,
  streaming = false,
  timestamp,
  sourceLabel,
}) => {
  let textContent = '';
  const toolUses: Array<{ id: string; name: string; input: any }> = [];

  if (typeof message.content === 'string') {
    textContent = message.content;
  } else if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (block.type === 'text') {
        textContent += block.text;
      } else if (block.type === 'tool_use') {
        if (!HIDDEN_TOOL_USES.has(block.name)) {
          toolUses.push({ id: block.id, name: block.name, input: block.input });
        }
      }
    }
  }

  const hasContent = textContent.trim().length > 0;

  /* 正文直接挂在圆点后面 —— 以前每段先起一行 "● Neox" 再缩进正文, 一段话多占一行,
   * 而且整条时间线只有它一个会署名, 读起来像聊天记录不像工作日志。
   * 子 agent 的话才需要署名 (看得出是谁说的), 署名放在正文前、灰色。 */
  return (
    <Box flexDirection="column">
      {hasContent && (
        <Step
          tone="text"
          title={
            <Box flexDirection="column" flexGrow={1}>
              {sourceLabel ? <Text color={NeoxTheme.text.dim}>{sourceLabel}</Text> : null}
              <MarkdownText content={textContent.trim()} streaming={streaming} />
            </Box>
          }
        />
      )}
      {toolUses.map((tool) => {
        const argStr = JSON.stringify(tool.input);
        return (
          <Step key={tool.id} tone="muted" title={<ToolTitle verb={tool.name} target={argStr.length <= 80 ? argStr : argStr.slice(0, 79) + '…'} />} />
        );
      })}
    </Box>
  );
};
