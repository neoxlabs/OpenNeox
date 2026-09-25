import type {
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
} from '../../debug-types.js';

export interface RendererDebugSessionInfo {
  sessionId: string;
  config: DebugLaunchConfig;
  capabilities: DebugSessionCapabilities;
  status: DebugSessionStatus;
}

export type RendererDebugSessionPush =
  | ({ type: 'session-added' } & RendererDebugSessionInfo)
  | { type: 'session-removed'; sessionId: string }
  | { type: 'session-status-changed'; sessionId: string; status: DebugSessionStatus }
  | { type: 'session-event'; sessionId: string; event: DebugSessionEvent };

export interface RendererAPIDebug {
  // ─── 老 API (DebugService 内存断点 — 没真实 session) ────────────────
  debugAddBreakpoint?: (breakpoint: { file: string; line: number; condition?: string; hitCondition?: string; logMessage?: string; source: 'user' | 'llm' }) => Promise<any>;
  debugRemoveBreakpoint?: (fileOrId: string, line?: number) => Promise<any>;
  debugToggleBreakpoint?: (file: string, line: number) => Promise<any>;
  debugGetBreakpoints?: (file?: string) => Promise<any[]>;
  debugClearBreakpoints?: (file?: string, source?: 'user' | 'llm') => Promise<void>;
  /** @deprecated M0+ 用 debugSessionStart */
  debugStartSession?: (config: { type: 'node' | 'python' | 'java'; program: string; args?: string[]; cwd?: string; env?: Record<string, string> }) => Promise<{ id: string; message?: string }>;
  debugStopSession?: (sessionId: string) => Promise<void>;
  debugContinue?: (sessionId: string) => Promise<void>;
  debugStepOver?: (sessionId: string) => Promise<void>;
  debugStepInto?: (sessionId: string) => Promise<void>;
  debugStepOut?: (sessionId: string) => Promise<void>;
  debugPause?: (sessionId: string) => Promise<void>;
  debugStop?: (sessionId: string) => Promise<void>;
  debugGetVariables?: (sessionId: string, frameId?: number) => Promise<any[]>;
  debugGetStackTrace?: (sessionId: string) => Promise<any[]>;
  debugEvaluate?: (sessionId: string, expression: string, frameId?: number) => Promise<{ value: any; type: string }>;
  debugSetBreakpoint?: (file: string, line: number, enabled: boolean) => Promise<any>;
  onDebugEvent?: (callback: (event: any) => void) => () => void;

  // ─── 新 API (DebuggerManager + JvmDapBackend, M0 起) ────────────────
  debugSessionStart?: (config: DebugLaunchConfig) => Promise<RendererDebugSessionInfo>;
  debugSessionDisconnect?: (sessionId: string, terminate?: boolean) => Promise<void>;
  debugSessionList?: () => Promise<RendererDebugSessionInfo[]>;
  debugSessionResume?: (sessionId: string, threadId?: number) => Promise<void>;
  debugSessionPause?: (sessionId: string, threadId?: number) => Promise<void>;
  debugSessionStepOver?: (sessionId: string, threadId: number) => Promise<void>;
  debugSessionStepInto?: (sessionId: string, threadId: number) => Promise<void>;
  debugSessionStepOut?: (sessionId: string, threadId: number) => Promise<void>;
  debugSessionThreads?: (sessionId: string) => Promise<ThreadInfo[]>;
  debugSessionStackTrace?: (sessionId: string, threadId: number) => Promise<StackFrame[]>;
  debugSessionScopes?: (sessionId: string, frameId: number) => Promise<Scope[]>;
  debugSessionVariables?: (sessionId: string, variablesReference: number) => Promise<Variable[]>;
  debugSessionEvaluate?: (sessionId: string, expression: string, frameId?: number) => Promise<EvaluateResult>;
  debugSessionSetLineBreakpoints?: (sessionId: string, file: string, breakpoints: LineBreakpoint[]) => Promise<LineBreakpoint[]>;
  /** main → renderer 推送; 返回 dispose */
  onDebugSessionEvent?: (callback: (event: RendererDebugSessionPush) => void) => () => void;
}
