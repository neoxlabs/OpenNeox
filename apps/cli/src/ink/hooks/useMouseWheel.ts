/**
 * useMouseWheel — Mouse wheel event handler for terminal
 *
 * 启用 SGR mouse mode 接收滚轮事件，用于全屏模式下的翻页。
 * - 不影响正常模式的终端选择行为
 * - 仅在全屏模式下激活
 */

import { useState, useEffect, useCallback, useRef } from 'react';

// ==================== Mouse Mode Control ====================

/** Enable SGR extended mouse mode (mode 1006 + 1003) */
function enableMouseTracking(): void {
  // Mode 1000: basic mouse tracking (button press/release)
  // Mode 1003: any-event tracking (includes motion)
  // Mode 1006: SGR extended format (supports large coordinates)
  process.stdout.write('\x1b[?1000h'); // Enable button tracking
  process.stdout.write('\x1b[?1006h'); // Enable SGR format
}

function disableMouseTracking(): void {
  process.stdout.write('\x1b[?1006l');
  process.stdout.write('\x1b[?1000l');
}

// ==================== Types ====================

export type ScrollDirection = 'up' | 'down';

export interface MouseWheelEvent {
  direction: ScrollDirection;
  x: number;
  y: number;
}

// ==================== SGR Mouse Parser ====================

/**
 * Parse SGR mouse sequence: \x1b[<button;x;y[Mm]
 * Button 64 = scroll up, button 65 = scroll down
 */
function parseSGRMouse(data: string): MouseWheelEvent | null {
  // Match SGR mouse format: ESC [ < button ; x ; y M or m
  const match = data.match(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
  if (!match) return null;

  const button = parseInt(match[1], 10);
  const x = parseInt(match[2], 10);
  const y = parseInt(match[3], 10);

  // Button 64 = scroll up, 65 = scroll down
  if (button === 64) return { direction: 'up', x, y };
  if (button === 65) return { direction: 'down', x, y };

  return null;
}

// ==================== Hook ====================

export interface MouseWheelState {
  /** Whether mouse tracking is active */
  active: boolean;
  /** Current scroll offset (accumulated) */
  scrollOffset: number;
  /** Reset scroll offset */
  resetScroll: () => void;
}

export function useMouseWheel(
  enabled: boolean = false,
  onScroll?: (event: MouseWheelEvent) => void,
  scrollStep: number = 3,
): MouseWheelState {
  const [active, setActive] = useState(false);
  const [scrollOffset, setScrollOffset] = useState(0);
  const handlerRef = useRef<((data: Buffer) => void) | null>(null);

  useEffect(() => {
    if (!enabled) {
      if (active) {
        disableMouseTracking();
        setActive(false);
      }
      return;
    }

    enableMouseTracking();
    setActive(true);

    // Listen for raw stdin data
    const handler = (data: Buffer) => {
      const str = data.toString('utf-8');
      const event = parseSGRMouse(str);
      if (event) {
        if (event.direction === 'up') {
          setScrollOffset(prev => Math.max(0, prev - scrollStep));
        } else {
          setScrollOffset(prev => prev + scrollStep);
        }
        onScroll?.(event);
      }
    };

    handlerRef.current = handler;

    if (process.stdin.isTTY) {
      process.stdin.on('data', handler);
    }

    return () => {
      disableMouseTracking();
      setActive(false);
      if (handlerRef.current && process.stdin.isTTY) {
        process.stdin.off('data', handlerRef.current);
      }
    };
  }, [enabled, scrollStep]); // eslint-disable-line react-hooks/exhaustive-deps

  const resetScroll = useCallback(() => {
    setScrollOffset(0);
  }, []);

  return { active, scrollOffset, resetScroll };
}
