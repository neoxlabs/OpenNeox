import React from 'react';
import { Text } from '../../../../vendor/ink/src/index.js';
import type { PlanStreamEvent } from '@neoxlabs/kernel/types/index.js';
import { NeoxTheme } from '../../theme.js';
import { Step, StepResult } from './step.js';

interface PlanUpdateCardProps {
  event: PlanStreamEvent;
  timestamp?: Date;
  sourceLabel?: string;
}

/** 步骤多时只显示这么多行 (锚定在进行中那步附近), 防长 plan 撑高超屏。头部仍显示完整 N。 */
const MAX_PLAN_ROWS = 8;

export const PlanUpdateCard: React.FC<PlanUpdateCardProps> = ({ event, timestamp, sourceLabel }) => {
  const { plan } = event;
  const totalSteps = plan.length;
  const completedSteps = plan.filter(s => s.status === 'completed').length;

  //   前后折叠成 "⋯ 前/后 N 步"。完整进度看头部 pct (completed/total)。防超屏撑高。
  let startIdx = 0;
  let endIdx = totalSteps;
  if (totalSteps > MAX_PLAN_ROWS) {
    const activeIdx = plan.findIndex(s => s.status === 'in_progress');
    const anchor = activeIdx >= 0 ? activeIdx : completedSteps; // 无进行中 → 锚第一个未完成
    startIdx = Math.max(0, Math.min(anchor - 2, totalSteps - MAX_PLAN_ROWS));
    endIdx = Math.min(totalSteps, startIdx + MAX_PLAN_ROWS);
  }
  const hiddenBefore = startIdx;
  const hiddenAfter = totalSteps - endIdx;

  /* 步骤清单: ✓ 完成 (灰、划线) / ◐ 进行中 (品牌色符号 + 前景色正文) / ○ 待办 (次要色)。
   * 颜色只落在状态符号上 —— 以前进行中那步整行青色, 标题紫色, 来源蓝色。 */
  const dim = NeoxTheme.text.dim;
  const lines: React.ReactNode[] = [];
  if (hiddenBefore > 0) lines.push(`⋯ 前 ${hiddenBefore} 步`);
  for (const item of plan.slice(startIdx, endIdx)) {
    if (item.status === 'completed') {
      lines.push(
        <Text wrap="wrap">
          <Text color={NeoxTheme.functional.success}>✓ </Text>
          <Text color={dim} strikethrough>{item.step}</Text>
        </Text>,
      );
    } else if (item.status === 'in_progress') {
      lines.push(
        <Text wrap="wrap">
          <Text color={NeoxTheme.brand.purple}>◐ </Text>
          <Text bold>{item.step}</Text>
        </Text>,
      );
    } else {
      lines.push(
        <Text wrap="wrap">
          <Text color={dim}>○ </Text>
          <Text color={NeoxTheme.text.secondary}>{item.step}</Text>
        </Text>,
      );
    }
  }
  if (hiddenAfter > 0) lines.push(`⋯ 后 ${hiddenAfter} 步`);

  return (
    <Step
      tone={completedSteps === totalSteps && totalSteps > 0 ? 'success' : 'running'}
      title={
        <Text>
          <Text bold>Plan</Text>
          <Text color={dim}>{`  ${completedSteps}/${totalSteps}`}{sourceLabel ? ` · ${sourceLabel}` : ''}</Text>
        </Text>
      }
    >
      <StepResult lines={lines} />
    </Step>
  );
};
