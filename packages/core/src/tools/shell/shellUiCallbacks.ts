import type { ShellOutputStreamPayload } from './shellWorkerClient.js';

export type BackgroundTaskCallback = {
  onAdd?: (command: string, pid: number) => number;
  onUpdate?: (
    id: number,
    updates: { status?: string; exitCode?: number; outputLine?: string }
  ) => void;
  onUpdateByPid?: (pid: number, updates: { status?: string; exitCode?: number }) => void;
};

let bgTaskCallback: BackgroundTaskCallback | null = null;
let shellOutputStreamCallback: ((payload: ShellOutputStreamPayload) => void) | null = null;

export function setBackgroundTaskCallback(cb: BackgroundTaskCallback | null): void {
  bgTaskCallback = cb;
}

export function getBackgroundTaskCallback(): BackgroundTaskCallback | null {
  return bgTaskCallback;
}

export function setShellOutputStreamCallback(
  cb: ((payload: ShellOutputStreamPayload) => void) | null
): void {
  shellOutputStreamCallback = cb;
}

export function getShellOutputStreamCallback(): ((payload: ShellOutputStreamPayload) => void) | null {
  return shellOutputStreamCallback;
}
