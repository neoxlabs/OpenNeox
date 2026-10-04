/**
 * CollabMessage - 协作工具事件渲染组件
 *
 * 渲染协作模式下的工具调用事件：
 * - spawn / spawn_agent / spawn_process: 创建协作执行单元
 * - delegate_task: 委派轻量任务
 * - query_agent: 查询 Agent 状态
 * - send_message: 发送消息
 * - wait_result: 等待结果
 * - wait_all: 等待多个结果
 * - terminate_agent: 终止 Agent
 */

import React from 'react';
import { Box, Text } from '../../../../vendor/ink/src/index.js';

export interface CollabMessageProps {
  type:
    | 'assistant_spawn'
    | 'assistant_delegate'
    | 'assistant_query'
    | 'assistant_message'
    | 'assistant_wait'
    | 'assistant_terminate';
  text: string;
  details?: string;
  timestamp?: Date;
  toolName?: string;
  targetAgentId?: string;
  taskId?: string;
  result?: 'success' | 'error' | 'pending';
  sourceLabel?: string;
}

// 工具配置映射
const ASSISTANT_TOOL_CONFIG: Record<
  string,
  { icon: string; color: 'cyan' | 'yellow' | 'blue' | 'magenta' | 'green' | 'red'; label: string }
> = {
  assistant_spawn: { icon: '+', color: 'cyan', label: 'spawn' },
  assistant_delegate: { icon: '»', color: 'yellow', label: 'delegate_task' },
  assistant_query: { icon: '?', color: 'blue', label: 'query_agent' },
  assistant_message: { icon: '>', color: 'magenta', label: 'send_message' },
  assistant_wait: { icon: '…', color: 'yellow', label: 'wait_result' },
  assistant_terminate: { icon: 'x', color: 'red', label: 'terminate_agent' },
};

export const CollabMessage: React.FC<CollabMessageProps> = ({
  type,
  text,
  details,
  timestamp,
  toolName,
  targetAgentId,
  taskId,
  result,
  sourceLabel,
}) => {
  const config = ASSISTANT_TOOL_CONFIG[type] || { icon: '>', color: 'blue' as const, label: 'assistant' };

  // 结果状态颜色
  const resultColor = result === 'success' ? 'green' : result === 'error' ? 'red' : 'yellow';
  const resultIcon = result === 'success' ? '✓' : result === 'error' ? 'x' : '…';

  // 计算是否有多个内容行
  const hasAgentOrTask = targetAgentId || taskId;

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box>
        <Text>{config.icon} </Text>
        <Text color={config.color} bold>
          {toolName || config.label}
        </Text>
        {sourceLabel && <Text dimColor> ({sourceLabel})</Text>}
        {result && (
          <Text color={resultColor}>
            {' '}
            {resultIcon}
          </Text>
        )}
      </Box>

      {/* Target Agent / Task ID - 第一行用树枝 */}
      {hasAgentOrTask && (
        <Box>
          <Text dimColor>└─ </Text>
          {targetAgentId && (
            <Text>
              <Text dimColor>Agent: </Text>
              <Text color="cyan">{targetAgentId}</Text>
            </Text>
          )}
          {taskId && (
            <Text>
              <Text dimColor> Task: </Text>
              <Text color="yellow">{taskId}</Text>
            </Text>
          )}
        </Box>
      )}

      {/* Main text - 根据是否有上面内容决定树枝 */}
      <Box>
        <Text dimColor>{hasAgentOrTask ? '   ' : '└─ '}</Text>
        <Text wrap="wrap">{text}</Text>
      </Box>

      {/* Details - 支持多行（每行一个工具记录） */}
      {details && (
        <Box flexDirection="column">
          {details.split('\n').map((line, i) => (
            <Box key={i}>
              <Text dimColor>   </Text>
              <Text dimColor wrap="wrap">
                {line}
              </Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
};
