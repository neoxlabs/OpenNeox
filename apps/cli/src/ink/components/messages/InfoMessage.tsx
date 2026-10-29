import React from 'react';
import { Text } from '../../../../vendor/ink/src/index.js';
import { NeoxTheme } from '../../theme.js';
import { Step, StepResult, toneColor, moreLines, type StepTone } from './step.js';

export interface InfoMessageProps {
  text: string;
  details?: string;
  type?: 'info' | 'error' | 'warning' | 'success' | 'queued_message';
  timestamp?: Date;
  sourceLabel?: string;
}

const TYPE_TONE: Record<NonNullable<InfoMessageProps['type']>, StepTone> = {
  info: 'muted',
  error: 'error',
  warning: 'warning',
  success: 'success',
  queued_message: 'muted',
};

const MAX_DETAIL_LINES = 8;

export const InfoMessage: React.FC<InfoMessageProps> = ({
  text,
  details,
  type = 'info',
  sourceLabel,
}) => {
  const tone = TYPE_TONE[type];
  const textColor = tone === 'error' ? toneColor('error')
    : tone === 'warning' ? toneColor('warning')
    : NeoxTheme.text.secondary;
  const detailLines = details && details.trim() ? details.replace(/\s+$/, '').split('\n') : [];
  const shown = detailLines.slice(0, MAX_DETAIL_LINES);
  if (detailLines.length > MAX_DETAIL_LINES) shown.push(moreLines(detailLines.length - MAX_DETAIL_LINES));

  return (
    <Step
      tone={tone}
      title={
        <Text wrap="wrap" color={textColor}>
          {sourceLabel ? <Text color={NeoxTheme.text.dim}>{sourceLabel} · </Text> : null}
          {text}
        </Text>
      }
    >
      {shown.length > 0 ? <StepResult lines={shown} /> : null}
    </Step>
  );
};
