import React from 'react';
import { Box, Text } from '../../../vendor/ink/src/index.js';
import { formatTime } from '../utils/formatTime.js';
import { t } from '../../i18n/index.js';

export interface PlanStep {
  id: string;
  description: string;
  activeForm?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'skipped';
}

export interface PlanCardProps {
  steps: PlanStep[];
  currentStepIndex?: number;
  timestamp?: Date;
}

/**
 * PlanCard - 显示执行计划的卡片组件
 *
 * 类似 TodoList 的样式，显示一级步骤列表
 */
export const PlanCard: React.FC<PlanCardProps> = ({
  steps,
  currentStepIndex = 0,
  timestamp,
}) => {
  const timeStr = formatTime(timestamp);

  // 计算进度
  const completedCount = steps.filter(s => s.status === 'completed').length;
  const totalCount = steps.length;
  const progress = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

  // 获取状态图标和颜色
  const getStepIcon = (status: PlanStep['status']) => {
    switch (status) {
      case 'completed':
        return '✓';
      case 'in_progress':
        return '▸';
      case 'skipped':
        return '○';
      case 'pending':
      default:
        return '○';
    }
  };

  const getStepColor = (status: PlanStep['status']): 'green' | 'cyan' | 'gray' | 'yellow' => {
    switch (status) {
      case 'completed':
        return 'green';
      case 'in_progress':
        return 'cyan';
      case 'skipped':
        return 'yellow';
      case 'pending':
      default:
        return 'gray';
    }
  };

  return (
    <Box flexDirection="column" marginY={0}>
      {/* Header */}
      <Box>
        <Text color="gray" dimColor>{timeStr} • </Text>
        <Text color="magenta">╭─ </Text>
        <Text bold color="magenta">{t().ui.executionPlan}</Text>
        <Text color="gray" dimColor> ({progress}% {t().ui.percentComplete})</Text>
      </Box>

      {/* Progress bar */}
      <Box>
        <Text color="magenta">│  </Text>
        <Text color="gray" dimColor>[</Text>
        <Text color="green">{'█'.repeat(Math.floor(progress / 5))}</Text>
        <Text color="gray" dimColor>{'░'.repeat(20 - Math.floor(progress / 5))}</Text>
        <Text color="gray" dimColor>] </Text>
        <Text color="cyan">{completedCount}/{totalCount}</Text>
      </Box>

      {/* Empty line */}
      <Box>
        <Text color="magenta">│</Text>
      </Box>

      {/* Steps list */}
      {steps.map((step, index) => {
        const icon = getStepIcon(step.status);
        const color = getStepColor(step.status);
        const isCurrent = index === currentStepIndex;

        return (
          <Box key={step.id}>
            <Text color="magenta">│  </Text>
            <Text color={color} bold={isCurrent}>{icon} </Text>
            <Text color="gray" dimColor>{step.id}. </Text>
            <Text color={isCurrent ? 'white' : 'gray'} bold={isCurrent}>
              {step.status === 'in_progress' && step.activeForm
                ? step.activeForm
                : step.description}
            </Text>
          </Box>
        );
      })}

      {/* Bottom border */}
      <Box>
        <Text color="magenta">╰────────────────────────────────────────</Text>
      </Box>
    </Box>
  );
};
