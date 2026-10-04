/**
 * Terminal Compatibility Layer - 终端兼容层
 *
 * 导出所有终端相关模块，提供统一的 API
 */

// Core adapter
export {
  TerminalAdapter,
  getTerminalAdapter,
  resetTerminalAdapter,
  ANSI,
  type TerminalSize,
  type TerminalCapabilities,
  type TerminalType,
  type Platform,
  type TerminalAdapterOptions,
} from './TerminalAdapter.js';

// Diff rendering
export {
  DiffRenderer,
  ScreenBuffer,
  IncrementalRenderer,
  VirtualScrollRenderer,
  type Cell,
  type DiffCommand,
  type RenderStats,
  type AdaptiveLayoutOptions,
} from './DiffRenderer.js';

// 🔥 NEW: Full Screen Renderer (彻底解决残影问题)
export {
  FullScreenRenderer,
  InlineRenderer,
  AltScreenRenderer,
  createFullScreenRenderer,
  createInlineRenderer,
  createAltScreenRenderer,
  type FullScreenOptions,
  type RenderFrame,
  type FrameStats,
} from './FullScreenRenderer.js';

// Ink integration
export {
  InkTerminalBackend,
  createInkLogUpdate,
  useTerminalAdapter,
  useTerminalResize,
  type InkBackendOptions,
  type InkLogUpdate,
} from './InkTerminalBackend.js';

// React Hooks
export {
  useTerminalSize,
  useTerminalCapabilities,
  useAltScreen,
  useSyncUpdate,
  useTerminal,
  useResizeCallback,
  useAdaptiveLayout,
  useResponsiveValue,
  useDebouncedSize,
  useScrollRegion,
  type Breakpoint,
  type AdaptiveLayoutResult,
} from './useTerminal.js';
