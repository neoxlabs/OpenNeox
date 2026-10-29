import React from 'react';
import { Box, Text } from '../../../vendor/ink/src/index.js';
import { NeoxTheme } from '../theme.js';

export const MenuPanel: React.FC<{
  title?: string;
  hint?: string;
  footer?: React.ReactNode;
  children: React.ReactNode;
}> = ({ title, hint, footer, children }) => (
  <Box flexDirection="column">
    {title || hint ? (
      <Box paddingX={2} justifyContent="space-between">
        <Text bold>{title ?? ''}</Text>
        {hint ? <Text color={NeoxTheme.text.faint}>{hint}</Text> : null}
      </Box>
    ) : null}
    {children}
    {footer ? (
      <Box paddingX={2}>
        <Text color={NeoxTheme.text.faint} wrap="truncate-end">{footer}</Text>
      </Box>
    ) : null}
  </Box>
);

/** 一行选项: 选中 = 钴蓝 ›; 右侧可放快捷键/计数 */
export const MenuRow: React.FC<{ selected: boolean; right?: React.ReactNode; children: React.ReactNode }> = ({ selected, right, children }) => (
  <Box paddingX={2} justifyContent="space-between">
    <Box flexShrink={1}>
      <Text color={NeoxTheme.brand.purple} bold>{selected ? '› ' : '  '}</Text>
      {children}
    </Box>
    {right ? <Box flexShrink={0} marginLeft={2}>{typeof right === 'string' ? <Text color={NeoxTheme.text.faint}>{right}</Text> : right}</Box> : null}
  </Box>
);

/** 把 text 里第一次出现的 q 标成钴蓝粗体 (筛选命中) */
export const Highlight: React.FC<{ text: string; q?: string; color?: string; bold?: boolean }> = ({ text, q, color, bold }) => {
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (!q || i < 0) return <Text color={color} bold={bold}>{text}</Text>;
  return (
    <Text color={color} bold={bold}>
      {text.slice(0, i)}
      <Text color={NeoxTheme.brand.purple} bold>{text.slice(i, i + q.length)}</Text>
      {text.slice(i + q.length)}
    </Text>
  );
};
