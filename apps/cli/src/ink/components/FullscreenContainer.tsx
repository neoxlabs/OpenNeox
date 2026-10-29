/**
 * FullscreenContainer — 全屏模式布局组件
 *
 * 使用 alt-screen buffer 实现全屏模式：
 * ┌─────────────────────────────────────────┐
 * │ [Neox v2.x] [SINGLE] [provider/model]  │  ← Header
 * ├─────────────────────────────────────────┤
 * │                                         │
 * │  (scrollable message area)              │  ← Virtual scroll
 * │                                         │
 * ├─────────────────────────────────────────┤
 * │ > input                                 │  ← Input
 * │ 5h:12r $0.05 • Thinking on             │  ← HintLine
 * └─────────────────────────────────────────┘
 *
 * 快捷键：Ctrl+Alt+F 或 /fullscreen 切换
 * 鼠标滚轮翻页（需要 mouse tracking）
 * ESC 退出全屏
 */

import React, { useEffect } from 'react';
import { Box, Text, useStdout } from '../../../vendor/ink/src/index.js';
import { NeoxTheme } from '../theme.js';
import { useAltScreen } from '../hooks/useAltScreen.js';
import { useMouseWheel } from '../hooks/useMouseWheel.js';

export interface FullscreenContainerProps {
  /** Whether fullscreen mode is active */
  active: boolean;
  /** Callback to exit fullscreen */
  onExit: () => void;
  /** Version string */
  version?: string;
  /** Run mode label */
  runMode?: string;
  /** Provider/model display */
  providerModel?: string;
  /** Header children (for custom content after the header bar) */
  headerContent?: React.ReactNode;
  /** Main scrollable area content */
  children: React.ReactNode;
  /** Bottom bar content (input + hints) */
  bottomContent?: React.ReactNode;
}

export const FullscreenContainer: React.FC<FullscreenContainerProps> = ({
  active,
  onExit,
  version,
  runMode = 'SINGLE',
  providerModel,
  headerContent,
  children,
  bottomContent,
}) => {
  const { columns: termWidth = 80, rows: termHeight = 24 } = useStdout();
  const altScreen = useAltScreen(active);
  const mouseWheel = useMouseWheel(active);

  // ESC exits fullscreen (handled by parent via onExit)
  // Mouse wheel scrolling is handled by the parent via mouseWheel.scrollOffset

  // Calculate available height for content area
  const headerHeight = 2; // Header + separator
  const bottomHeight = 4; // Input + HintLine + borders
  const contentHeight = Math.max(5, termHeight - headerHeight - bottomHeight);

  if (!active) return null;

  return (
    <Box flexDirection="column" width={termWidth} height={termHeight}>
      {/* Header Bar */}
      <Box justifyContent="space-between" width="100%">
        <Box>
          {version && (
            <Text color={NeoxTheme.brand.purple} bold>
              [{version}]
            </Text>
          )}
          <Text color={NeoxTheme.text.dim}> </Text>
          <Text color={NeoxTheme.brand.cyan} bold>
            [{runMode}]
          </Text>
          {providerModel && (
            <>
              <Text color={NeoxTheme.text.dim}> </Text>
              <Text color={NeoxTheme.brand.magenta}>
                [{providerModel}]
              </Text>
            </>
          )}
        </Box>
        <Text color={NeoxTheme.text.dim}>
          ESC exit • scroll ↑↓
        </Text>
      </Box>

      {/* Separator */}
      <Box width="100%">
        <Text color={NeoxTheme.text.dim}>{'─'.repeat(termWidth)}</Text>
      </Box>

      {headerContent}

      {/* Main Content Area (scrollable) */}
      <Box flexDirection="column" height={contentHeight} overflow="hidden">
        {children}
      </Box>

      {/* Separator */}
      <Box width="100%">
        <Text color={NeoxTheme.text.dim}>{'─'.repeat(termWidth)}</Text>
      </Box>

      {/* Bottom Bar */}
      {bottomContent}
    </Box>
  );
};
