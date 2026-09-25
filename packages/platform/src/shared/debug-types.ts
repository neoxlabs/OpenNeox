/**
 * Neox 调试器 — 语言无关的核心类型.
 *
 * 抽象按 IDEA 的 XDebugger 来对齐: DebugSession 持一个 Backend (DAP 之上),
 * Backend 拉具体进程 (jvm-debugger.jar / node --inspect / 未来其他).
 *
 * 上层 UI 只看这一组类型, 不关心后面是 JDI 还是 CDP.
 */

// ─── 启动配置 (UI 给 DebuggerManager.start 的入参) ──────────────────────

export type DebugLaunchConfig =
  | JvmLaunchConfig
  | JvmAttachConfig
  | NodeLaunchConfig
  | NodeAttachConfig;

export interface JvmLaunchConfig {
  kind: 'jvm-launch';
  mainClass: string;
  classpath: string[];
  modulePath?: string[];
  jvmArgs?: string[];
  programArgs?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** 默认 true. false 则进程起来不暂停, 直接跑到第一个断点 */
  stopOnEntry?: boolean;
}

export interface JvmAttachConfig {
  kind: 'jvm-attach';
  host: string;
  port: number;
}

export interface NodeLaunchConfig {
  kind: 'node-launch';
  script: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  port?: number;
  stopOnEntry?: boolean;
}

export interface NodeAttachConfig {
  kind: 'node-attach';
  host?: string;
  port: number;
}

// ─── 断点 ───────────────────────────────────────────────────────────────

export type Breakpoint =
  | LineBreakpoint
  | MethodBreakpoint
  | FieldBreakpoint
  | ExceptionBreakpoint;

export interface LineBreakpointBase {
  id: string;
  enabled: boolean;
  /** 可选条件 (Java/Node 都支持; UI 让用户写表达式) */
  condition?: string;
  /** 命中 N 次后才停 */
  hitCondition?: string;
  /** 给了就是 logpoint, 不停, 只往 console 写 */
  logMessage?: string;
}

export interface LineBreakpoint extends LineBreakpointBase {
  type: 'line';
  file: string;
  line: number;
  /** 后端验证后回填: 真实生效的行号可能跟 UI 不一样 */
  verified?: boolean;
  message?: string;
}

export interface MethodBreakpoint extends LineBreakpointBase {
  type: 'method';
  className: string;
  methodName: string;
  signature?: string;
}

export interface FieldBreakpoint extends LineBreakpointBase {
  type: 'field';
  className: string;
  fieldName: string;
  watchAccess?: boolean;
  watchModification?: boolean;
}

export interface ExceptionBreakpoint extends LineBreakpointBase {
  type: 'exception';
  /** 全限定名 com.foo.MyException; 'caught'/'uncaught' filter 一起设 */
  className: string;
  caught?: boolean;
  uncaught?: boolean;
  /** subclass 也匹配 (默认 true) */
  includeSubclasses?: boolean;
}

// ─── 暂停时拿到的信息 ────────────────────────────────────────────────────

export interface ThreadInfo {
  id: number;
  name: string;
  state?: 'running' | 'paused' | 'unknown';
}

export interface StackFrame {
  id: number;
  name: string;
  /** 绝对路径 (后端做 source path 查找; UI 直接打开) */
  source?: string;
  line?: number;
  column?: number;
  /** Java: declaring class FQN */
  module?: string;
  /** 是否能 dropFrame / restartFrame */
  canRestart?: boolean;
}

export interface Scope {
  name: string;
  variablesReference: number;
  expensive?: boolean;
}

export interface Variable {
  name: string;
  value: string;
  type?: string;
  /** 0 表示叶子, >0 表示能展开 (再 fetch variables) */
  variablesReference: number;
  /** Java 独门: 这个变量是不是 IDE 标记的 "marked object" */
  markedAs?: string;
  /** Java 独门: 渲染器分类 (toString / hex / json...) */
  renderer?: string;
}

export interface EvaluateResult {
  result: string;
  type?: string;
  variablesReference: number;
}

// ─── 会话事件 ────────────────────────────────────────────────────────────

export type DebugSessionEvent =
  | { type: 'output'; category: 'stdout' | 'stderr' | 'console' | 'telemetry'; output: string }
  | { type: 'thread'; reason: 'started' | 'exited'; threadId: number }
  | { type: 'stopped'; reason: StopReason; threadId: number; description?: string; hitBreakpointIds?: string[] }
  | { type: 'continued'; threadId: number; allThreadsContinued?: boolean }
  | { type: 'breakpoint'; reason: 'changed' | 'new' | 'removed'; breakpoint: Breakpoint }
  | { type: 'terminated' }
  | { type: 'exited'; exitCode: number };

export type StopReason =
  | 'step'
  | 'breakpoint'
  | 'exception'
  | 'pause'
  | 'entry'
  | 'goto'
  | 'function-breakpoint'
  | 'data-breakpoint'
  | 'instruction-breakpoint';

// ─── 能力上报 (跟 DAP capabilities 对齐 + neox 自定义) ───────────────────

export interface DebugSessionCapabilities {
  /** 标准 DAP */
  conditionalBreakpoints: boolean;
  hitConditionalBreakpoints: boolean;
  logPoints: boolean;
  functionBreakpoints: boolean;
  exceptionBreakpoints: boolean;
  fieldBreakpoints: boolean;
  evaluate: boolean;
  setVariable: boolean;
  /** Neox 扩展 (Java 独占, Node CDP 后端永远 false) */
  hotswap: boolean;
  dropFrame: boolean;
  forceEarlyReturn: boolean;
  memoryAgent: boolean;
  asyncStacks: boolean;
  streamDebugger: boolean;
  markObject: boolean;
}

// ─── 会话状态机 ──────────────────────────────────────────────────────────

export type DebugSessionStatus =
  | 'initializing'
  | 'launching'
  | 'running'
  | 'paused'
  | 'terminating'
  | 'terminated';
