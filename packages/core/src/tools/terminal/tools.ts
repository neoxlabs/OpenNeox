/**
 * Terminal Tools - LLM Tools for Terminal Operations
 *
 * These tools enable AI agents to interact with terminals programmatically.
 * NOTE: These tools are only available when running in Electron UI mode.
 */

import type { Tool, ToolCapability } from '@neoxlabs/kernel/types/index.js';

type ElectronAPIWindow = typeof globalThis & {
  window?: {
    electronAPI?: unknown;
  };
};

/**
 * Get the electron API (only available in Electron renderer process)
 */
function getElectronAPI(): any {
  const electronWindow = globalThis as ElectronAPIWindow;
  if (typeof globalThis !== 'undefined' && electronWindow.window?.electronAPI) {
    return electronWindow.window.electronAPI;
  }
  throw new Error('Terminal tools are only available in Electron UI mode');
}

// ========= Tool Definitions =========

/**
 * TerminalExecute - Execute a command in a terminal session
 */
const terminalExecuteTool: Tool = {
  name: 'terminal_execute',
  description: `Execute a shell command in a terminal session and return the output.

Use this tool when you need to:
- Run shell commands (npm, git, python, etc.)
- Execute scripts or programs
- Check system status or environment
- Build, test, or run applications

The command will be executed in the current working directory or the specified cwd.
You can optionally specify a timeout (default: 30 seconds).

Examples:
- Run tests: "npm test"
- Check git status: "git status"
- Build project: "npm run build"
- List files: "ls -la"`,

  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The shell command to execute (e.g., "npm test", "git status")',
      },
      cwd: {
        type: 'string',
        description: 'Optional working directory for the command (absolute path)',
      },
      timeout: {
        type: 'number',
        description: 'Optional timeout in milliseconds (default: 30000)',
      },
      sessionId: {
        type: 'string',
        description: 'Optional terminal session ID to reuse. If not provided, a new session will be created.',
      },
    },
    required: ['command'],
  },

  function: async (input: any) => {
    const { command, cwd, timeout = 30000, sessionId } = input;
    const api = getElectronAPI();

    try {
      // Create or reuse terminal session
      let terminalSessionId = sessionId;
      if (!terminalSessionId) {
        const result = await api.terminalCreate({ cwd });
        terminalSessionId = result.sessionId;
      }

      // Execute command
      const output = await api.terminalExecute(terminalSessionId, command, timeout);

      // Clean up if we created a temporary session
      if (!sessionId) {
        await api.terminalDestroy(terminalSessionId);
      }

      return JSON.stringify({
        success: true,
        output: output.stdout + output.stderr,
        exitCode: output.exitCode,
        stdout: output.stdout,
        stderr: output.stderr,
      }, null, 2);
    } catch (error: any) {
      return JSON.stringify({
        success: false,
        error: error.message || 'Failed to execute command',
      }, null, 2);
    }
  },
};

/**
 * TerminalCreate - Create a new terminal session
 */
const terminalCreateTool: Tool = {
  name: 'terminal_create',
  description: `Create a new terminal session for interactive use.

Use this tool when you need to:
- Start a long-running interactive process
- Maintain terminal state across multiple commands
- Run commands that require input/output streaming

After creating a session, you'll receive a sessionId that you can use for:
- terminal_write: Send input to the terminal
- terminal_execute: Execute commands in the session
- terminal_destroy: Close the session when done

Example workflow:
1. Create session: terminal_create({ cwd: "/path/to/project" })
2. Execute commands: terminal_execute({ sessionId, command: "npm start" })
3. Clean up: terminal_destroy({ sessionId })`,

  parameters: {
    type: 'object',
    properties: {
      cwd: {
        type: 'string',
        description: 'Optional working directory for the terminal (absolute path)',
      },
      shell: {
        type: 'string',
        description: 'Optional shell to use (e.g., "bash", "zsh", "powershell"). Defaults to system shell.',
      },
      cols: {
        type: 'number',
        description: 'Optional terminal width in columns (default: 80)',
      },
      rows: {
        type: 'number',
        description: 'Optional terminal height in rows (default: 24)',
      },
    },
    required: [],
  },

  function: async (input: any) => {
    const { cwd, shell, cols, rows } = input;
    const api = getElectronAPI();

    try {
      const result = await api.terminalCreate({ cwd, shell, cols, rows });
      return JSON.stringify({
        success: true,
        sessionId: result.sessionId,
        cwd: result.cwd,
        shell: result.shell,
        message: `Terminal session created: ${result.sessionId}. Use this sessionId for subsequent operations.`,
      }, null, 2);
    } catch (error: any) {
      return JSON.stringify({
        success: false,
        error: error.message || 'Failed to create terminal session',
      }, null, 2);
    }
  },
};

/**
 * TerminalDestroy - Close a terminal session
 */
const terminalDestroyTool: Tool = {
  name: 'terminal_destroy',
  description: `Close and clean up a terminal session.

Use this tool when you're done with a terminal session to free up resources.
All running processes in the session will be terminated.`,

  parameters: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: 'The terminal session ID to destroy',
      },
    },
    required: ['sessionId'],
  },

  function: async (input: any) => {
    const { sessionId } = input;
    const api = getElectronAPI();

    try {
      await api.terminalDestroy(sessionId);
      return JSON.stringify({
        success: true,
        message: `Terminal session ${sessionId} destroyed successfully`,
      }, null, 2);
    } catch (error: any) {
      return JSON.stringify({
        success: false,
        error: error.message || 'Failed to destroy terminal session',
      }, null, 2);
    }
  },
};

/**
 * Export all terminal tools
 */
export const terminalTools: Tool[] = [
  terminalExecuteTool,
  terminalCreateTool,
  terminalDestroyTool,
];

const terminalToolCapabilities: ToolCapability[] = ['terminal'];

/**
 * Create terminal tools (for consistency with other tool modules)
 */
export function createTerminalTools(): Tool[] {
  return terminalTools.map((tool) => ({
    ...tool,
    capabilities: tool.capabilities
      ? Array.from(new Set([...tool.capabilities, ...terminalToolCapabilities]))
      : terminalToolCapabilities,
  }));
}
