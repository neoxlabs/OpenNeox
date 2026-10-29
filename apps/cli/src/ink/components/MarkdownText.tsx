import React, { useState, useEffect, useMemo } from 'react';
import { Box, Text } from '../../../vendor/ink/src/index.js';
import { renderMarkdown } from './markdownRenderer.js';

// 纯渲染逻辑都在 markdownRenderer.ts (零 ink 依赖, 有 snapshot 回归集)。本文件只是 React 壳。
// 兼容旧 import 路径: 这些纯函数仍可从本模块拿到。
export { formatToken, applyMarkdown, renderMarkdown } from './markdownRenderer.js';

export interface MarkdownTextProps {
  content: string;
  streaming?: boolean;
}

// ─── React 组件 ───────────────────────────────────────────────────
export const MarkdownText: React.FC<MarkdownTextProps> = ({ content, streaming = false }) => {
  const [showCursor, setShowCursor] = useState(true);

  useEffect(() => {
    if (!streaming) {
      setShowCursor(false);
      return;
    }
    const timer = setInterval(() => setShowCursor(s => !s), 800);
    return () => clearInterval(timer);
  }, [streaming]);

  if (!content?.trim()) return null;

  const cleanContent = content.trim();

  const renderedContent = useMemo(() => {
    return renderMarkdown(cleanContent, streaming);
  }, [cleanContent, streaming]);

  return (
    <Box flexDirection="column" flexShrink={1}>
      <Text wrap="wrap">{renderedContent}{streaming && showCursor ? '\x1b[36m▊\x1b[0m' : ''}</Text>
    </Box>
  );
};
