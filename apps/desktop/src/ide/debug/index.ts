/**
 * Neox 调试器抽象层 — 入口.
 *
 * 这一层故意不依赖任何 Electron / Node API, 让 renderer 也能 import 类型.
 * 后端实现 (会拉子进程 / 开 socket) 在 src/ui/electron/services/debug/ 下面.
 */

export type {
  Breakpoint,
  LineBreakpoint,
  MethodBreakpoint,
  FieldBreakpoint,
  ExceptionBreakpoint,
  DebugLaunchConfig,
  JvmLaunchConfig,
  JvmAttachConfig,
  NodeLaunchConfig,
  NodeAttachConfig,
  ThreadInfo,
  StackFrame,
  Scope,
  Variable,
  EvaluateResult,
  DebugSessionEvent,
  DebugSessionCapabilities,
  DebugSessionStatus,
  StopReason,
} from '@neoxlabs/platform/shared/debug-types.js';

export type { DebugSession, DebugSessionListener } from './DebugSession.js';
export {
  DebuggerManager,
  type BackendFactory,
  type DebuggerManagerEvent,
  type DebuggerManagerListener,
} from './DebuggerManager.js';
