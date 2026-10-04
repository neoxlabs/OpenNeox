export interface RendererAPITerminal {
  // ==================== 终端服务 (xterm.js + node-pty) ====================
  terminalCreate: (options?: { cwd?: string; shell?: string; cols?: number; rows?: number }) => Promise<{ sessionId: string; cwd: string; shell: string }>;
  terminalWrite: (sessionId: string, data: string) => Promise<void>;
  terminalResize: (sessionId: string, cols: number, rows: number) => Promise<void>;
  terminalDestroy: (sessionId: string) => Promise<void>;
  terminalExecute: (sessionId: string, command: string, timeout?: number) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  onTerminalData: (callback: (data: { sessionId: string; data: string }) => void) => () => void;
  onTerminalExit: (callback: (data: { sessionId: string; exitCode: number }) => void) => () => void;
  //  终端请求系统（LLM execute_shell 工具调用）
  onTerminalRequest: (callback: (data: { requestId: string; command: string; cwd: string; timeout?: number }) => void) => () => void;
  terminalRequestComplete: (requestId: string, result: { output: string; exitCode: number; error?: string }) => Promise<void>;
}
