/**
 * useAltScreen — Fullscreen Mode (alt-screen buffer)
 *
 * 使用终端 alt-screen buffer 实现全屏模式：
 * - 进入全屏：\x1b[?1049h (switch to alt screen)
 * - 退出全屏：\x1b[?1049l (switch back to main screen)
 *
 * 全屏模式下内容不会污染主终端的 scrollback buffer。
 */

import { useState, useEffect, useCallback, useRef } from 'react';

// ==================== Alt Screen Control ====================

function enterAltScreen(): void {
  process.stdout.write('\x1b[?1049h'); // Enter alt screen
  process.stdout.write('\x1b[H');       // Move cursor to top-left
  process.stdout.write('\x1b[2J');      // Clear screen
}

function exitAltScreen(): void {
  process.stdout.write('\x1b[?1049l'); // Exit alt screen
}

// ==================== Hook ====================

export interface AltScreenState {
  isFullscreen: boolean;
  toggle: () => void;
  enter: () => void;
  exit: () => void;
}

export function useAltScreen(initialFullscreen: boolean = false): AltScreenState {
  const [isFullscreen, setIsFullscreen] = useState(initialFullscreen);
  const cleanupRef = useRef(false);

  // Enter/exit on state change
  useEffect(() => {
    if (isFullscreen) {
      enterAltScreen();
    } else if (cleanupRef.current) {
      // Only exit if we previously entered (avoid double-exit on mount)
      exitAltScreen();
    }
    cleanupRef.current = true;

    return () => {
      // Ensure we exit alt screen on unmount
      if (isFullscreen) {
        exitAltScreen();
      }
    };
  }, [isFullscreen]);

  const toggle = useCallback(() => {
    setIsFullscreen(prev => !prev);
  }, []);

  const enter = useCallback(() => {
    setIsFullscreen(true);
  }, []);

  const exit = useCallback(() => {
    setIsFullscreen(false);
  }, []);

  return { isFullscreen, toggle, enter, exit };
}
