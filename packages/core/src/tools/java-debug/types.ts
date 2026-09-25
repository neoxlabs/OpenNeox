/**
 * Java Debug Types - DAP Protocol and Session Management
 */

/**
 * Debug Adapter Protocol (DAP) Message Types
 */
export interface DAPMessage {
  seq: number;
  type: 'request' | 'response' | 'event';
}

export interface DAPRequest extends DAPMessage {
  type: 'request';
  command: string;
  arguments?: any;
}

export interface DAPResponse extends DAPMessage {
  type: 'response';
  request_seq: number;
  success: boolean;
  command: string;
  message?: string;
  body?: any;
}

export interface DAPEvent extends DAPMessage {
  type: 'event';
  event: string;
  body?: any;
}

/**
 * DAP Protocol Interfaces
 */
export interface InitializeRequestArguments {
  clientID?: string;
  clientName?: string;
  adapterID: string;
  pathFormat?: 'path' | 'uri';
  linesStartAt1?: boolean;
  columnsStartAt1?: boolean;
  supportsVariableType?: boolean;
  supportsVariablePaging?: boolean;
  supportsRunInTerminalRequest?: boolean;
  locale?: string;
}

export interface LaunchRequestArguments {
  noDebug?: boolean;
  mainClass: string;
  projectName?: string;
  classPaths?: string[];
  modulePaths?: string[];
  args?: string;
  vmArgs?: string;
  encoding?: string;
  cwd?: string;
  env?: Record<string, string>;
  stopOnEntry?: boolean;
  console?: 'internalConsole' | 'integratedTerminal' | 'externalTerminal';
  shortenCommandLine?: 'none' | 'jarmanifest' | 'argfile';
}

export interface AttachRequestArguments {
  hostName: string;
  port: number;
  timeout?: number;
  processId?: number;
}

export interface SetBreakpointsArguments {
  source: {
    path?: string;
    name?: string;
    sourceReference?: number;
  };
  breakpoints?: Array<{
    line: number;
    column?: number;
    condition?: string;
    hitCondition?: string;
    logMessage?: string;
  }>;
  lines?: number[];
  sourceModified?: boolean;
}

export interface Breakpoint {
  id?: number;
  verified: boolean;
  message?: string;
  source?: {
    path?: string;
    name?: string;
  };
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
}

export interface StackTraceArguments {
  threadId: number;
  startFrame?: number;
  levels?: number;
  format?: StackFrameFormat;
}

export interface StackFrameFormat {
  parameters?: boolean;
  parameterTypes?: boolean;
  parameterNames?: boolean;
  parameterValues?: boolean;
  line?: boolean;
  module?: boolean;
  includeAll?: boolean;
}

export interface StackFrame {
  id: number;
  name: string;
  source?: {
    path?: string;
    name?: string;
    sourceReference?: number;
  };
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  moduleId?: string | number;
  presentationHint?: 'normal' | 'label' | 'subtle';
}

export interface ScopesArguments {
  frameId: number;
}

export interface Scope {
  name: string;
  variablesReference: number;
  namedVariables?: number;
  indexedVariables?: number;
  expensive: boolean;
  source?: {
    path?: string;
    name?: string;
  };
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
}

export interface VariablesArguments {
  variablesReference: number;
  filter?: 'indexed' | 'named';
  start?: number;
  count?: number;
  format?: ValueFormat;
}

export interface ValueFormat {
  hex?: boolean;
}

export interface Variable {
  name: string;
  value: string;
  type?: string;
  presentationHint?: {
    kind?: string;
    attributes?: string[];
    visibility?: string;
  };
  evaluateName?: string;
  variablesReference: number;
  namedVariables?: number;
  indexedVariables?: number;
}

export interface EvaluateArguments {
  expression: string;
  frameId?: number;
  context?: 'watch' | 'repl' | 'hover' | 'clipboard';
  format?: ValueFormat;
}

export interface ContinueArguments {
  threadId: number;
  singleThread?: boolean;
}

export interface NextArguments {
  threadId: number;
  singleThread?: boolean;
  granularity?: 'statement' | 'line' | 'instruction';
}

export interface StepInArguments {
  threadId: number;
  singleThread?: boolean;
  targetId?: number;
  granularity?: 'statement' | 'line' | 'instruction';
}

export interface StepOutArguments {
  threadId: number;
  singleThread?: boolean;
  granularity?: 'statement' | 'line' | 'instruction';
}

export interface DisconnectArguments {
  restart?: boolean;
  terminateDebuggee?: boolean;
  suspendDebuggee?: boolean;
}

export interface ThreadsResponse {
  body: {
    threads: Array<{
      id: number;
      name: string;
    }>;
  };
}

export interface ExceptionInfoArguments {
  threadId: number;
}

export interface ExceptionDetails {
  message?: string;
  typeName?: string;
  fullTypeName?: string;
  evaluateName?: string;
  stackTrace?: string;
  innerException?: ExceptionDetails[];
}

/**
 * Debug Session State
 */
export type SessionStatus = 'initializing' | 'running' | 'stopped' | 'terminated' | 'error';

export interface DebugSession {
  id: string;
  status: SessionStatus;
  currentThreadId?: number;
  currentFrameId?: number;
  stoppedReason?: string;
  stoppedLocation?: {
    filePath: string;
    line: number;
    column?: number;
  };
  breakpoints: Map<string, Breakpoint[]>;
  createdAt: number;
  lastActivity: number;
}

/**
 * Tool Parameter Types
 */
export interface JavaDebugLaunchParams {
  mainClass: string;
  projectPath: string;
  classpath?: string;
  args?: string[];
  vmArgs?: string[];
  stopOnEntry?: boolean;
  cwd?: string;
}

export interface JavaDebugAttachParams {
  port: number;
  hostName?: string;
  timeout?: number;
}

export interface JavaDebugSetBreakpointParams {
  sessionId: string;
  filePath: string;
  line: number;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
}

export interface JavaDebugContinueParams {
  sessionId: string;
  threadId?: number;
}

export interface JavaDebugStepParams {
  sessionId: string;
  threadId?: number;
}

export interface JavaDebugGetVariablesParams {
  sessionId: string;
  frameId?: number;
  filter?: 'local' | 'arguments' | 'all';
}

export interface JavaDebugGetStackTraceParams {
  sessionId: string;
  threadId?: number;
}

export interface JavaDebugEvaluateParams {
  sessionId: string;
  expression: string;
  frameId?: number;
  context?: 'watch' | 'repl' | 'hover';
}

export interface JavaDebugStopParams {
  sessionId: string;
  terminateDebuggee?: boolean;
}

/**
 * Tool Result Types
 */
export interface JavaDebugLaunchResult {
  sessionId: string;
  status: SessionStatus;
  message: string;
}

export interface JavaDebugAttachResult {
  sessionId: string;
  status: SessionStatus;
  processInfo?: {
    pid?: number;
    mainClass?: string;
  };
  message: string;
}

export interface JavaDebugSetBreakpointResult {
  breakpointId: number;
  verified: boolean;
  line: number;
  message: string;
}

export interface JavaDebugContinueResult {
  status: SessionStatus;
  stoppedReason?: 'breakpoint' | 'exception' | 'step' | 'pause' | 'entry';
  location?: {
    filePath: string;
    line: number;
    column: number;
  };
  message: string;
}

export interface JavaDebugStepResult {
  status: SessionStatus;
  location: {
    filePath: string;
    line: number;
    method: string;
  };
  message: string;
}

export interface JavaDebugGetVariablesResult {
  variables: Array<{
    name: string;
    value: string;
    type: string;
    variablesReference?: number;
  }>;
  message: string;
}

export interface JavaDebugGetStackTraceResult {
  stackFrames: Array<{
    id: number;
    name: string;
    source: {
      path: string;
      line: number;
    };
    presentationHint?: 'normal' | 'label' | 'subtle';
  }>;
  totalFrames: number;
  message: string;
}

export interface JavaDebugEvaluateResult {
  result: string;
  type: string;
  variablesReference?: number;
  message: string;
}

export interface JavaDebugExceptionInfoResult {
  exceptionId: string;
  description: string;
  breakMode: 'never' | 'always' | 'unhandled' | 'userUnhandled';
  details?: {
    typeName: string;
    message: string;
    stackTrace: string;
  };
}

export interface JavaDebugStopResult {
  status: 'terminated';
  message: string;
}

/**
 * Configuration
 */
export interface JavaDebugConfig {
  /** Path to java-debug JAR file */
  javaDebugJarPath: string;
  /** Path to JDK home */
  javaHome?: string;
  /** Default timeout for debug operations (ms) */
  defaultTimeout?: number;
  /** Maximum number of concurrent sessions */
  maxSessions?: number;
  /** Auto-cleanup inactive sessions after N ms */
  sessionTimeout?: number;
}
