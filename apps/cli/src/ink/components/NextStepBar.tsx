import React from 'react';
import { Box, Text } from '../../../vendor/ink/src/index.js';
import { NeoxTheme } from '../theme.js';

/** Plan 步骤状态 */
export type PlanStepStatus = 'pending' | 'in_progress' | 'completed';

/** Plan 步骤 */
export interface PlanStep {
  step: string;
  status: PlanStepStatus;
}

export interface NextStepBarProps {
  /** 当前的 Plan 步骤列表 */
  planSteps: PlanStep[];
  /** 是否正在运行 */
  isRunning?: boolean;
}

/**
 * NextStepBar - 显示下一步计划
 *
 * 在 StatusLine 下方显示当前执行的下一步，如：
 * └─ ○ Next: Check dependencies
 *
 * 只显示最多 1 个待执行项
 */
export const NextStepBar: React.FC<NextStepBarProps> = ({ planSteps, isRunning = false }) => {
  // 找到下一个待执行的步骤（第一个 pending 状态的）
  const nextStep = planSteps.find(s => s.status === 'pending');

  // 如果没有下一步，或者不在运行中，不显示
  if (!nextStep || !isRunning) {
    return null;
  }

  // 截断过长的内容
  const displayText = nextStep.step.length > 50
    ? nextStep.step.substring(0, 47) + '...'
    : nextStep.step;

  return (
    <Box>
      <Text color={NeoxTheme.text.dim}>{`   ○ Next: `}</Text>
      <Text color={NeoxTheme.text.secondary}>{displayText}</Text>
    </Box>
  );
};
