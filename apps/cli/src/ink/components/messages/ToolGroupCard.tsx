import React from 'react';
import { Text, useStdout } from '../../../../vendor/ink/src/index.js';
import stringWidth from 'string-width';
import type { AggregatedGroup } from '../../utils/aggregateToolCalls.js';
import { describeTool, describeGroup } from '../../utils/describeTool.js';
import { NeoxTheme } from '../../theme.js';
import { Step, StepResult } from './step.js';

export interface ToolGroupCardProps {
  groups: AggregatedGroup[];
  originalIds: number[];
  totalCount: number;
  density: 'medium' | 'compact';
}

const MAX_ITEMS = 4;

function truncateByWidth(text: string, maxWidth: number): string {
  if (stringWidth(text) <= maxWidth) return text;
  let out = '';
  for (const ch of text) {
    if (stringWidth(out + ch) > maxWidth - 1) break;
    out += ch;
  }
  return out + '…';
}

export const ToolGroupCard: React.FC<ToolGroupCardProps> = ({ groups, density }) => {
  const { columns = 80 } = useStdout();
  const items = groups.flatMap(g => g.items.map(it => ({ it, d: describeTool(it.originalType, it.rawText, it.details) })));
  const title = describeGroup(items.map(({ it, d }) => ({ category: d.category, count: it.count * (d.units ?? 1) })));
  const failed = items.some(({ d }) => d.failed);

  const lineW = Math.max(20, columns - 8);
  const shown = density === 'compact' ? [] : items.slice(0, MAX_ITEMS);
  const lines: React.ReactNode[] = shown.map(({ it, d }, i) => {
    const target = truncateByWidth(d.target || d.verb, Math.floor(lineW * 0.7));
    const tail = [it.count > 1 ? `×${it.count}` : '', d.result].filter(Boolean).join(' · ');
    return (
      <Text key={i} wrap="truncate-end">
        <Text color={NeoxTheme.text.secondary}>{target}</Text>
        {tail ? <Text color={d.failed ? NeoxTheme.functional.error : NeoxTheme.text.dim}>{' · ' + tail}</Text> : null}
      </Text>
    );
  });
  if (density !== 'compact' && items.length > MAX_ITEMS) lines.push(`… +${items.length - MAX_ITEMS} more`);

  return (
    <Step tone={failed ? 'error' : 'success'} title={<Text bold>{title}</Text>}>
      {lines.length > 0 ? <StepResult lines={lines} /> : null}
    </Step>
  );
};
