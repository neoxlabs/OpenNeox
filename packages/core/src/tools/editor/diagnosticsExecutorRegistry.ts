/** Desktop agentBridge 注入: 从 renderer Monaco 拉当前诊断. */

export type DiagnosticItem = {
  path: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  source?: string;
  code?: string;
};

export type DiagnosticsQuery = {
  paths?: string[];
  /** 最多返回条数, 默认 80 */
  limit?: number;
};

export type DiagnosticsExecutor = (query: DiagnosticsQuery) => Promise<DiagnosticItem[]>;

let globalDiagnosticsExecutor: DiagnosticsExecutor | null = null;

export function setDiagnosticsExecutor(executor: DiagnosticsExecutor | null): void {
  globalDiagnosticsExecutor = executor;
}

export function getDiagnosticsExecutor(): DiagnosticsExecutor | null {
  return globalDiagnosticsExecutor;
}
