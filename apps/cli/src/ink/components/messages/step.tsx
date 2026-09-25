import React from 'react';
import { Box, Text } from '../../../../vendor/ink/src/index.js';
import { NeoxTheme } from '../../theme.js';

export type StepTone = 'text' | 'running' | 'success' | 'error' | 'warning' | 'muted';

export function toneColor(tone: StepTone): string | undefined {
  switch (tone) {
    case 'running': return NeoxTheme.brand.purple;
    case 'success': return NeoxTheme.functional.success;
    case 'error': return NeoxTheme.functional.error;
    case 'warning': return NeoxTheme.functional.warning;
    case 'muted': return NeoxTheme.text.dim;
    case 'text': return NeoxTheme.text.primary;
  }
}

export const DOT = '●';

/** 一步: 左边圆点, 右边标题 + 子内容 (结果行等) */
export const Step: React.FC<{
  tone: StepTone;
  title: React.ReactNode;
  children?: React.ReactNode;
}> = ({ tone, title, children }) => (
  <Box flexDirection="column">
    <Box>
      <Box width={2} flexShrink={0}><Text color={toneColor(tone)}>{DOT}</Text></Box>
      <Box flexGrow={1} flexShrink={1}>{typeof title === 'string' ? <Text wrap="wrap">{title}</Text> : title}</Box>
    </Box>
    {children ? <Box flexDirection="column" marginLeft={2}>{children}</Box> : null}
  </Box>
);

/** 工具标题: 动词加粗 + 灰色括号参数 —— Edit(src/math.js) */
export const ToolTitle: React.FC<{ verb: string; target?: string; suffix?: React.ReactNode }> = ({ verb, target, suffix }) => (
  <Text wrap="wrap">
    <Text bold>{verb}</Text>
    {target ? <Text color={NeoxTheme.text.secondary}>({target})</Text> : null}
    {suffix ?? null}
  </Text>
);

/**
 * 结果块: 第一行挂 ⎿, 后面的行对齐到 ⎿ 后的正文。
 * lines 可以是字符串 (灰色) 或已经上好色的节点。
 */
export const StepResult: React.FC<{ lines: React.ReactNode[]; color?: string; oneLine?: boolean }> = ({ lines, color, oneLine }) => {
  if (lines.length === 0) return null;
  const c = color ?? NeoxTheme.text.dim;
  return (
    <Box flexDirection="column">
      {lines.map((l, i) => (
        <Box key={i}>
          <Box width={3} flexShrink={0}><Text color={NeoxTheme.text.dim}>{i === 0 ? '⎿ ' : '  '}</Text></Box>
          <Box flexGrow={1} flexShrink={1}>
            {typeof l === 'string'
              ? <Text color={c} wrap={oneLine ? 'truncate-end' : 'wrap'}>{oneLine ? sanitizeOutputLine(l) : l}</Text>
              : l}
          </Box>
        </Box>
      ))}
    </Box>
  );
};

export function sanitizeOutputLine(s: string): string {
  let col = 0;
  let out = '';
  // eslint-disable-next-line no-control-regex
  for (const ch of s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '')) {
    if (ch === '\t') { const n = 4 - (col % 4); out += ' '.repeat(n); col += n; continue; }
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(ch)) continue;
    out += ch;
    col += 1;
  }
  return out;
}

/** "+N more lines" 这类折叠提示 */
export const moreLines = (n: number): string => `… +${n} line${n === 1 ? '' : 's'}`;
