/**
 * DebugSession — 语言无关的调试会话接口.
 *
 * 对应 IDEA 的 XDebugSession. 一个 Session = 一个 target 进程 (本地 launch
 * 或 remote attach) 的完整生命周期.
 *
 * UI / 上层逻辑只跟这个接口打交道. 具体后端 (JVM via DAP / Node via CDP) 在
 * `backends/` 下实现. Java 独门能力 (HotSwap / Memory Agent / DropFrame)
 * 通过可选方法暴露, 调用前用 capabilities 检查.
 */

import type {
  Breakpoint,
  DebugLaunchConfig,
  DebugSessionCapabilities,
  DebugSessionEvent,
  DebugSessionStatus,
  EvaluateResult,
  LineBreakpoint,
  Scope,
  StackFrame,
  ThreadInfo,
  Variable,
} from '@neoxlabs/platform/shared/debug-types.js';

export type DebugSessionListener = (event: DebugSessionEvent) => void;

export interface DebugSession {
  readonly id: string;
  readonly config: DebugLaunchConfig;
  readonly capabilities: DebugSessionCapabilities;

  status(): DebugSessionStatus;

  /** 订阅会话事件; 返回 dispose */
  onEvent(listener: DebugSessionListener): () => void;

  // ─── 生命周期 ─────────────────────────────────────────────────────────

  start(): Promise<void>;
  /** terminate=true 杀目标进程; false (默认) 只断开调试器, target 继续跑 */
  disconnect(terminate?: boolean): Promise<void>;

  // ─── 执行控制 ─────────────────────────────────────────────────────────

  resume(threadId?: number): Promise<void>;
  pause(threadId?: number): Promise<void>;
  stepOver(threadId: number): Promise<void>;
  stepInto(threadId: number): Promise<void>;
  stepOut(threadId: number): Promise<void>;

  // ─── 断点 ────────────────────────────────────────────────────────────

  /** 同步给定文件的全部行断点 (DAP setBreakpoints 语义: 全量替换) */
  setLineBreakpoints(file: string, breakpoints: LineBreakpoint[]): Promise<LineBreakpoint[]>;
  /** 设非行类断点 (method / field / exception); 全量替换同类型 */
  setBreakpoints(breakpoints: Breakpoint[]): Promise<Breakpoint[]>;

  // ─── 暂停时检查 ───────────────────────────────────────────────────────

  threads(): Promise<ThreadInfo[]>;
  stackFrames(threadId: number): Promise<StackFrame[]>;
  scopes(frameId: number): Promise<Scope[]>;
  variables(variablesReference: number): Promise<Variable[]>;
  evaluate(expression: string, frameId?: number): Promise<EvaluateResult>;

  // ─── Java 独门能力 (capabilities 里关掉的就别叫) ────────────────────

  /** HotSwap: 把改过的 .class 推到 target JVM (M4) */
  redefineClasses?(classes: Array<{ className: string; bytecodeBase64: string }>): Promise<void>;

  /** Drop Frame: 把当前帧弹掉, 回到调用者下一行 (M6) */
  dropFrame?(frameId: number): Promise<void>;

  /** Force Early Return: 强制让方法立即返回 (M6) */
  forceEarlyReturn?(threadId: number, value: string): Promise<void>;

  /** Memory Agent: 找对象到 GC roots 的引用链 (M5) */
  gcRoots?(variablesReference: number): Promise<unknown>;

  /** Memory Agent: 谁 hold 住这个对象 (M5) */
  referrers?(variablesReference: number, limit?: number): Promise<unknown>;

  /** Memory Agent: retained size (M5) */
  retainedSize?(variablesReference: number): Promise<number>;
}
