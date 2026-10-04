/**
 * useTerminal - React Hook for Terminal Compatibility Layer
 *
 * 提供给 Ink 组件使用的 React Hooks，用于：
 * - 获取终端能力信息
 * - 监听 resize 事件（跨平台可靠）
 * - 使用 Alternate Screen
 * - 使用 Synchronized Update
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  TerminalAdapter,
  getTerminalAdapter,
  type TerminalSize,
  type TerminalCapabilities,
} from './TerminalAdapter.js';

// ============================================================================
// useTerminalSize - 跨平台可靠的终端尺寸 Hook
// ============================================================================

/**
 * 获取终端尺寸，自动响应 resize
 * 比 Ink 内置的 useStdout 更可靠（支持 Windows/WSL 轮询）
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const { columns, rows } = useTerminalSize();
 *   return <Text>Terminal: {columns}x{rows}</Text>;
 * }
 * ```
 */
export function useTerminalSize(): TerminalSize {
  const terminal = getTerminalAdapter();
  const [size, setSize] = useState<TerminalSize>(() => terminal.size);

  useEffect(() => {
    const handleResize = (newSize: TerminalSize) => {
      setSize(newSize);
    };

    terminal.on('resize', handleResize);

    // 立即同步一次（防止初始值过期）
    setSize(terminal.size);

    return () => {
      terminal.off('resize', handleResize);
    };
  }, [terminal]);

  return size;
}

// ============================================================================
// useTerminalCapabilities - 获取终端能力
// ============================================================================

/**
 * 获取终端能力信息
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const caps = useTerminalCapabilities();
 *   return (
 *     <Box>
 *       <Text>Terminal: {caps.terminalType}</Text>
 *       <Text>True Color: {caps.trueColor ? 'Yes' : 'No'}</Text>
 *     </Box>
 *   );
 * }
 * ```
 */
export function useTerminalCapabilities(): TerminalCapabilities {
  const terminal = getTerminalAdapter();
  return terminal.capabilities;
}

// ============================================================================
// useAltScreen - Alternate Screen 管理
// ============================================================================

interface UseAltScreenResult {
  /** 是否在备用屏幕中 */
  inAltScreen: boolean;
  /** 进入备用屏幕 */
  enter: () => void;
  /** 离开备用屏幕 */
  leave: () => void;
  /** 切换备用屏幕 */
  toggle: () => void;
}

/**
 * 管理 Alternate Screen
 * 用于全屏模式、弹窗等场景
 *
 * @example
 * ```tsx
 * function FullScreenEditor() {
 *   const { inAltScreen, enter, leave } = useAltScreen();
 *
 *   useEffect(() => {
 *     enter();
 *     return () => leave();
 *   }, []);
 *
 *   return <Box>Full screen content...</Box>;
 * }
 * ```
 */
export function useAltScreen(): UseAltScreenResult {
  const terminal = getTerminalAdapter();
  const [inAltScreen, setInAltScreen] = useState(terminal.inAltScreen);

  useEffect(() => {
    const handleAltScreen = (isAlt: boolean) => {
      setInAltScreen(isAlt);
    };

    terminal.on('altscreen', handleAltScreen);
    return () => {
      terminal.off('altscreen', handleAltScreen);
    };
  }, [terminal]);

  const enter = useCallback(() => {
    terminal.enterAltScreen();
  }, [terminal]);

  const leave = useCallback(() => {
    terminal.leaveAltScreen();
  }, [terminal]);

  const toggle = useCallback(() => {
    if (terminal.inAltScreen) {
      terminal.leaveAltScreen();
    } else {
      terminal.enterAltScreen();
    }
  }, [terminal]);

  return { inAltScreen, enter, leave, toggle };
}

// ============================================================================
// useSyncUpdate - Synchronized Update 包装
// ============================================================================

interface UseSyncUpdateResult {
  /** 是否支持 Synchronized Update */
  supported: boolean;
  /** 在同步更新块中执行操作 */
  syncUpdate: (fn: () => void) => void;
}

/**
 * 使用 Synchronized Update 防止闪烁
 *
 * @example
 * ```tsx
 * function FlickerFreeComponent() {
 *   const { syncUpdate } = useSyncUpdate();
 *
 *   const handleComplexUpdate = () => {
 *     syncUpdate(() => {
 *       // 这里的所有输出会作为一帧渲染
 *       console.log('Line 1');
 *       console.log('Line 2');
 *     });
 *   };
 *
 *   return <Button onPress={handleComplexUpdate}>Update</Button>;
 * }
 * ```
 */
export function useSyncUpdate(): UseSyncUpdateResult {
  const terminal = getTerminalAdapter();

  const syncUpdate = useCallback((fn: () => void) => {
    terminal.syncUpdate(fn);
  }, [terminal]);

  return {
    supported: terminal.capabilities.synchronizedUpdate,
    syncUpdate,
  };
}

// ============================================================================
// useTerminal - 完整的终端访问
// ============================================================================

interface UseTerminalResult {
  /** 终端适配器实例 */
  adapter: TerminalAdapter;
  /** 终端尺寸 */
  size: TerminalSize;
  /** 终端能力 */
  capabilities: TerminalCapabilities;
  /** 是否在备用屏幕中 */
  inAltScreen: boolean;
  /** 进入备用屏幕 */
  enterAltScreen: () => void;
  /** 离开备用屏幕 */
  leaveAltScreen: () => void;
  /** 同步更新 */
  syncUpdate: (fn: () => void) => void;
  /** 写入原始数据 */
  write: (data: string) => void;
  /** 清屏 */
  clearScreen: () => void;
}

/**
 * 完整的终端访问 Hook
 * 提供所有终端操作的统一入口
 *
 * @example
 * ```tsx
 * function AdvancedComponent() {
 *   const terminal = useTerminal();
 *
 *   useEffect(() => {
 *     if (terminal.capabilities.trueColor) {
 *       // 使用 true color
 *     }
 *   }, [terminal.capabilities]);
 *
 *   return <Text>Size: {terminal.size.columns}x{terminal.size.rows}</Text>;
 * }
 * ```
 */
export function useTerminal(): UseTerminalResult {
  const terminal = getTerminalAdapter();
  const [size, setSize] = useState<TerminalSize>(() => terminal.size);
  const [inAltScreen, setInAltScreen] = useState(terminal.inAltScreen);

  useEffect(() => {
    const handleResize = (newSize: TerminalSize) => {
      setSize(newSize);
    };

    const handleAltScreen = (isAlt: boolean) => {
      setInAltScreen(isAlt);
    };

    terminal.on('resize', handleResize);
    terminal.on('altscreen', handleAltScreen);

    return () => {
      terminal.off('resize', handleResize);
      terminal.off('altscreen', handleAltScreen);
    };
  }, [terminal]);

  const enterAltScreen = useCallback(() => {
    terminal.enterAltScreen();
  }, [terminal]);

  const leaveAltScreen = useCallback(() => {
    terminal.leaveAltScreen();
  }, [terminal]);

  const syncUpdate = useCallback((fn: () => void) => {
    terminal.syncUpdate(fn);
  }, [terminal]);

  const write = useCallback((data: string) => {
    terminal.write(data);
  }, [terminal]);

  const clearScreen = useCallback(() => {
    terminal.clearScreen();
  }, [terminal]);

  return {
    adapter: terminal,
    size,
    capabilities: terminal.capabilities,
    inAltScreen,
    enterAltScreen,
    leaveAltScreen,
    syncUpdate,
    write,
    clearScreen,
  };
}

// ============================================================================
// useResizeCallback - 简单的 resize 回调
// ============================================================================

/**
 * 监听终端 resize 事件
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   useResizeCallback((size) => {
 *     console.log(`Resized to ${size.columns}x${size.rows}`);
 *   });
 *
 *   return <Text>Resize me!</Text>;
 * }
 * ```
 */
export function useResizeCallback(
  callback: (size: TerminalSize, oldSize: TerminalSize) => void
): void {
  const terminal = getTerminalAdapter();
  const callbackRef = useRef(callback);

  // 保持 callback 最新
  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    const handleResize = (newSize: TerminalSize, oldSize: TerminalSize) => {
      callbackRef.current(newSize, oldSize);
    };

    terminal.on('resize', handleResize);
    return () => {
      terminal.off('resize', handleResize);
    };
  }, [terminal]);
}

// ============================================================================
// useAdaptiveLayout - 自适应布局 Hook
// ============================================================================

export type Breakpoint = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

export interface AdaptiveLayoutResult {
  /** 当前断点 */
  breakpoint: Breakpoint;
  /** 终端宽度 */
  width: number;
  /** 终端高度 */
  height: number;
  /** 是否是窄屏 (< 60 列) */
  isNarrow: boolean;
  /** 是否是宽屏 (>= 120 列) */
  isWide: boolean;
  /** 是否是短屏 (< 20 行) */
  isShort: boolean;
  /** 建议的内容宽度 */
  contentWidth: number;
  /** 建议的边距 */
  margin: number;
}

/**
 * 自适应布局 Hook
 * 根据终端尺寸自动计算布局参数
 *
 * @example
 * ```tsx
 * function ResponsiveComponent() {
 *   const layout = useAdaptiveLayout();
 *
 *   return (
 *     <Box width={layout.contentWidth} marginX={layout.margin}>
 *       {layout.isNarrow ? <CompactView /> : <FullView />}
 *     </Box>
 *   );
 * }
 * ```
 */
export function useAdaptiveLayout(): AdaptiveLayoutResult {
  const { columns, rows } = useTerminalSize();

  // 计算断点
  const getBreakpoint = (width: number): Breakpoint => {
    if (width < 40) return 'xs';
    if (width < 60) return 'sm';
    if (width < 80) return 'md';
    if (width < 120) return 'lg';
    return 'xl';
  };

  const breakpoint = getBreakpoint(columns);
  const isNarrow = columns < 60;
  const isWide = columns >= 120;
  const isShort = rows < 20;

  // 计算建议的内容宽度和边距
  let contentWidth: number;
  let margin: number;

  switch (breakpoint) {
    case 'xs':
      contentWidth = columns;
      margin = 0;
      break;
    case 'sm':
      contentWidth = columns - 2;
      margin = 1;
      break;
    case 'md':
      contentWidth = Math.min(columns - 4, 76);
      margin = Math.max(2, Math.floor((columns - contentWidth) / 2));
      break;
    case 'lg':
      contentWidth = Math.min(columns - 8, 100);
      margin = Math.max(4, Math.floor((columns - contentWidth) / 2));
      break;
    case 'xl':
      contentWidth = Math.min(columns - 16, 120);
      margin = Math.max(8, Math.floor((columns - contentWidth) / 2));
      break;
  }

  return {
    breakpoint,
    width: columns,
    height: rows,
    isNarrow,
    isWide,
    isShort,
    contentWidth,
    margin,
  };
}

// ============================================================================
// useResponsiveValue - 响应式值选择
// ============================================================================

type ResponsiveValues<T> = {
  xs?: T;
  sm?: T;
  md?: T;
  lg?: T;
  xl?: T;
  default: T;
};

/**
 * 根据断点选择响应式值
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const padding = useResponsiveValue({
 *     xs: 0,
 *     sm: 1,
 *     md: 2,
 *     lg: 4,
 *     default: 2,
 *   });
 *
 *   return <Box padding={padding}>Content</Box>;
 * }
 * ```
 */
export function useResponsiveValue<T>(values: ResponsiveValues<T>): T {
  const { breakpoint } = useAdaptiveLayout();

  // 按优先级查找值：当前断点 -> 更小的断点 -> default
  const breakpoints: Breakpoint[] = ['xl', 'lg', 'md', 'sm', 'xs'];
  const currentIndex = breakpoints.indexOf(breakpoint);

  for (let i = currentIndex; i < breakpoints.length; i++) {
    const bp = breakpoints[i]!;
    if (values[bp] !== undefined) {
      return values[bp]!;
    }
  }

  return values.default;
}

// ============================================================================
// useDebounceResize - 防抖 resize
// ============================================================================

/**
 * 防抖的终端尺寸 Hook
 * 避免 resize 过程中频繁重渲染
 *
 * @param delay 防抖延迟 (ms)，默认 100
 */
export function useDebouncedSize(delay = 100): TerminalSize {
  const terminal = getTerminalAdapter();
  const [size, setSize] = useState<TerminalSize>(() => terminal.size);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const handleResize = (newSize: TerminalSize) => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      timeoutRef.current = setTimeout(() => {
        setSize(newSize);
      }, delay);
    };

    terminal.on('resize', handleResize);

    return () => {
      terminal.off('resize', handleResize);
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [terminal, delay]);

  return size;
}

// ============================================================================
// useScrollRegion - 滚动区域管理
// ============================================================================

interface ScrollRegionResult {
  /** 可见区域高度 */
  visibleHeight: number;
  /** 当前滚动位置 */
  scrollTop: number;
  /** 总内容高度 */
  totalHeight: number;
  /** 是否可以向上滚动 */
  canScrollUp: boolean;
  /** 是否可以向下滚动 */
  canScrollDown: boolean;
  /** 滚动到指定位置 */
  scrollTo: (position: number) => void;
  /** 滚动指定行数 */
  scrollBy: (delta: number) => void;
  /** 滚动到顶部 */
  scrollToTop: () => void;
  /** 滚动到底部 */
  scrollToBottom: () => void;
  /** 设置总内容高度 */
  setTotalHeight: (height: number) => void;
}

/**
 * 滚动区域管理 Hook
 * 用于实现虚拟滚动或大内容滚动
 *
 * @param reservedLines 保留行数（如状态栏）
 */
export function useScrollRegion(reservedLines = 0): ScrollRegionResult {
  const { rows } = useTerminalSize();
  const visibleHeight = rows - reservedLines;

  const [scrollTop, setScrollTop] = useState(0);
  const [totalHeight, setTotalHeight] = useState(0);

  const maxScroll = Math.max(0, totalHeight - visibleHeight);

  const scrollTo = useCallback((position: number) => {
    setScrollTop(Math.max(0, Math.min(maxScroll, position)));
  }, [maxScroll]);

  const scrollBy = useCallback((delta: number) => {
    setScrollTop(prev => Math.max(0, Math.min(maxScroll, prev + delta)));
  }, [maxScroll]);

  const scrollToTop = useCallback(() => {
    setScrollTop(0);
  }, []);

  const scrollToBottom = useCallback(() => {
    setScrollTop(maxScroll);
  }, [maxScroll]);

  return {
    visibleHeight,
    scrollTop,
    totalHeight,
    canScrollUp: scrollTop > 0,
    canScrollDown: scrollTop < maxScroll,
    scrollTo,
    scrollBy,
    scrollToTop,
    scrollToBottom,
    setTotalHeight,
  };
}
