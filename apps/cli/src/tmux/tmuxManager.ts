/**
 * Tmux Manager — Tmux 集成
 *
 * 检测 tmux 环境，支持：
 * - /tmux 命令创建新窗口执行命令
 * - Worktree 工具自动创建 tmux window
 * - 后台任务用 tmux pane 显示实时输出
 */

import { execFileSync, execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// ==================== Detection ====================

/** Check if we're running inside tmux */
export function isInsideTmux(): boolean {
  return !!process.env.TMUX;
}

/** Get tmux version */
export function getTmuxVersion(): string | null {
  try {
    return execFileSync('tmux', ['-V'], { encoding: 'utf-8', timeout: 5_000 }).trim();
  } catch {
    return null;
  }
}

/** Get current tmux session name */
export function getCurrentSession(): string | null {
  if (!isInsideTmux()) return null;
  try {
    return execFileSync('tmux', ['display-message', '-p', '#{session_name}'], {
      encoding: 'utf-8',
      timeout: 5_000,
    }).trim();
  } catch {
    return null;
  }
}

/** Get current window index */
export function getCurrentWindowIndex(): number | null {
  if (!isInsideTmux()) return null;
  try {
    const result = execFileSync('tmux', ['display-message', '-p', '#{window_index}'], {
      encoding: 'utf-8',
      timeout: 5_000,
    }).trim();
    return parseInt(result, 10);
  } catch {
    return null;
  }
}

// ==================== Window Management ====================

export interface TmuxWindowOptions {
  /** Window name */
  name?: string;
  /** Working directory */
  cwd?: string;
  /** Command to execute */
  command?: string;
  /** Don't switch focus to the new window */
  background?: boolean;
}

/**
 * Create a new tmux window.
 * Returns the window index on success.
 */
export async function createWindow(options: TmuxWindowOptions = {}): Promise<number | null> {
  if (!isInsideTmux()) return null;

  const args = ['new-window'];

  if (options.background) args.push('-d');
  if (options.name) args.push('-n', options.name);
  if (options.cwd) args.push('-c', options.cwd);
  if (options.command) args.push(options.command);

  // Add print format to get window index
  args.push('-P', '-F', '#{window_index}');

  try {
    const { stdout } = await execFileAsync('tmux', args, {
      encoding: 'utf-8',
      timeout: 10_000,
    });
    return parseInt(stdout.trim(), 10);
  } catch {
    return null;
  }
}

/**
 * Create a new pane in the current window.
 * Returns the pane index on success.
 */
export async function createPane(options: {
  /** Split direction */
  direction?: 'horizontal' | 'vertical';
  /** Command to execute */
  command?: string;
  /** Working directory */
  cwd?: string;
  /** Pane size (percentage) */
  size?: number;
} = {}): Promise<string | null> {
  if (!isInsideTmux()) return null;

  const args = ['split-window'];

  if (options.direction === 'horizontal') args.push('-h');
  if (options.cwd) args.push('-c', options.cwd);
  if (options.size) args.push('-p', String(options.size));
  if (options.command) args.push(options.command);

  args.push('-P', '-F', '#{pane_id}');

  try {
    const { stdout } = await execFileAsync('tmux', args, {
      encoding: 'utf-8',
      timeout: 10_000,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Send keys to a tmux pane (for running commands).
 */
export async function sendKeys(target: string, keys: string): Promise<boolean> {
  try {
    await execFileAsync('tmux', ['send-keys', '-t', target, keys, 'Enter'], {
      encoding: 'utf-8',
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill a tmux window by index.
 */
export async function killWindow(windowIndex: number): Promise<boolean> {
  try {
    await execFileAsync('tmux', ['kill-window', '-t', String(windowIndex)], {
      encoding: 'utf-8',
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill a tmux pane by ID.
 */
export async function killPane(paneId: string): Promise<boolean> {
  try {
    await execFileAsync('tmux', ['kill-pane', '-t', paneId], {
      encoding: 'utf-8',
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * List all windows in the current session.
 */
export async function listWindows(): Promise<Array<{ index: number; name: string; active: boolean }>> {
  if (!isInsideTmux()) return [];

  try {
    const { stdout } = await execFileAsync('tmux', [
      'list-windows', '-F', '#{window_index}\t#{window_name}\t#{window_active}',
    ], { encoding: 'utf-8', timeout: 5_000 });

    return stdout.trim().split('\n').filter(Boolean).map(line => {
      const [index, name, active] = line.split('\t');
      return {
        index: parseInt(index, 10),
        name,
        active: active === '1',
      };
    });
  } catch {
    return [];
  }
}

// ==================== High-level Helpers ====================

/**
 * Create a tmux window for a worktree.
 * Opens the worktree directory in a new named window.
 */
export async function createWorktreeWindow(worktreePath: string, branchName: string): Promise<number | null> {
  const shortName = branchName.replace('neox-worktree/', 'wt/');
  return createWindow({
    name: shortName,
    cwd: worktreePath,
    background: true,
  });
}

/**
 * Execute a command in a new tmux window and return control.
 */
export async function executeInNewWindow(command: string, options?: {
  name?: string;
  cwd?: string;
}): Promise<number | null> {
  return createWindow({
    name: options?.name || 'neox-task',
    cwd: options?.cwd,
    command,
    background: true,
  });
}
