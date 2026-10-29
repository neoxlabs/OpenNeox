/**
 * AskUserQuestionCard - ask_user 工具的 timeline 卡片
 *
 * 只负责静态渲染问题和选项，交互由 SelectMenu 处理。
 */

import React from 'react';
import { Box, Text } from '../../../../vendor/ink/src/index.js';
import { NeoxTheme } from '../../theme.js';
import { Step, StepResult } from './step.js';

export interface AskUserQuestionCardProps {
  questions: Array<{
    question: string;
    options: Array<{ label: string; description?: string }>;
  }>;
  timestamp?: Date;
  sourceLabel?: string;
}

export const AskUserQuestionCard: React.FC<AskUserQuestionCardProps> = ({
  questions,
  sourceLabel,
}) => {
  /* 问题 = 一步 (品牌色圆点: 在等用户); 选项挂在 ⎿ 下, 名称次要色 + 说明灰色 */
  return (
    <Box flexDirection="column">
      {questions.map((q, qi) => (
        <Step
          key={qi}
          tone="running"
          title={
            <Text wrap="wrap">
              {sourceLabel ? <Text color={NeoxTheme.text.dim}>{`${sourceLabel} · `}</Text> : null}
              <Text bold>{q.question}</Text>
            </Text>
          }
        >
          <StepResult lines={q.options.map(opt => (
            <Text wrap="wrap">
              <Text color={NeoxTheme.text.secondary}>{opt.label}</Text>
              {opt.description ? <Text color={NeoxTheme.text.dim}>{`  ${opt.description}`}</Text> : null}
            </Text>
          ))} />
        </Step>
      ))}
    </Box>
  );
};
