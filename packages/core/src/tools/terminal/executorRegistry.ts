export type TerminalExecutor = (options: {
  command: string;
  cwd: string;
  timeout?: number;
}) => Promise<{ output: string; exitCode: number }>;

let globalTerminalExecutor: TerminalExecutor | null = null;

export function setTerminalExecutor(executor: TerminalExecutor | null): void {
  globalTerminalExecutor = executor;
}

export function getTerminalExecutor(): TerminalExecutor | null {
  return globalTerminalExecutor;
}
