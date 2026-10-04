import React, { useMemo } from 'react';
import { Box, Text, useStdout } from '../../../../vendor/ink/src/index.js';
import stringWidth from 'string-width';
import { getLanguage } from '../../../i18n/index.js';

export interface ThinkingBlockProps {
  content: string;
  streaming?: boolean;
  collapsed?: boolean;
  type?: 'thinking' | 'reasoning';
  timestamp?: Date;
  sourceLabel?: string;
}

/* Bound previews by display columns rather than character count. Reserve space
 * for indentation and the ellipsis so double-width text remains on one line. */
const PREVIEW_COLUMNS = 108;

/** 按显示宽度截断 (中日韩按 2 列算) */
function truncateByWidth(text: string, maxCols: number): { text: string; truncated: boolean } {
  if (stringWidth(text) <= maxCols) return { text, truncated: false };
  let out = '';
  let w = 0;
  for (const ch of text) {
    const cw = stringWidth(ch);
    if (w + cw > maxCols - 1) break; // -1 给 …
    out += ch;
    w += cw;
  }
  return { text: out, truncated: true };
}

export const ThinkingBlock: React.FC<ThinkingBlockProps> = ({
  content,
  streaming = false,
  collapsed = true,
  type = 'thinking',
  sourceLabel,
}) => {
  /* 表头跟内容同语言 —— 中文界面下模型的推理是中文, 表头却写着 Reasoning */
  const zh = (() => { try { return getLanguage() === 'zh'; } catch { return false; } })();
  const label = type === 'reasoning'
    ? (zh ? '推理' : 'Reasoning')
    : (zh ? '思考' : 'Thinking');
  const symbol = '∴';

  const preview = useMemo(() => {
    return content.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  }, [content]);
  const { stdout } = useStdout();
  const cols = stdout?.columns || 100;
  const headW = stringWidth(label + (sourceLabel ? ` (${sourceLabel})` : '') + (streaming ? '…' : '') + ' · ');
  const cut = useMemo(
    () => truncateByWidth(preview, Math.max(10, Math.min(PREVIEW_COLUMNS, cols - 2 - headW - 2))),
    [preview, cols, headW],
  );
  const isTruncated = cut.truncated;
  const previewText = isTruncated ? `${cut.text}…` : cut.text;

  if (collapsed) {
    return (
      <Box>
        <Box width={2} flexShrink={0}><Text dimColor>{symbol}</Text></Box>
        <Box flexGrow={1} flexShrink={1}>
          <Text dimColor italic wrap="truncate-end">
            {label}{sourceLabel ? ` (${sourceLabel})` : ''}{streaming ? '…' : ''}
            {previewText ? ` · ${previewText}` : ''}
          </Text>
        </Box>
      </Box>
    );
  }

  // Expanded: label + full content
  const lines = content.split('\n');
  return (
    <Box flexDirection="column">
      <Box>
        <Box width={2} flexShrink={0}><Text dimColor>{symbol}</Text></Box>
        <Text dimColor italic>{label}{sourceLabel ? ` (${sourceLabel})` : ''}</Text>
      </Box>
      <Box flexDirection="column" marginLeft={2}>
        {lines.map((line, i) => (
          <Box key={i}>
            <Text dimColor wrap="wrap">{line}</Text>
          </Box>
        ))}
      </Box>
      <Box marginLeft={2}>
        <Text dimColor>(ctrl+o to collapse)</Text>
      </Box>
    </Box>
  );
};
