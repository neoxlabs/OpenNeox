/**
 * Editor and Debug Tools - LLM Tools for Code Editing and Debugging
 *
 * These tools enable AI agents to set breakpoints, manage debugging sessions,
 * and interact with the Monaco Editor programmatically.
 * NOTE: These tools are only available when running in Electron UI mode.
 */

import type { Tool, ToolCapability } from '@neoxlabs/kernel/types/index.js';
import { readLintsTool } from './readLintsTool.js';

type ElectronAPIWindow = typeof globalThis & {
  window?: {
    electronAPI?: unknown;
  };
};

// ---- Input interfaces for tool functions ----

interface SetBreakpointInput {
  file: string;
  line: number;
  condition?: string;
  logMessage?: string;
  source: 'llm' | 'user';
}

interface RemoveBreakpointInput {
  breakpointId: string;
}

interface FileFilterInput {
  file?: string;
}

interface StartDebugSessionInput {
  type: 'node' | 'python' | 'java';
  program: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

interface SessionIdInput {
  sessionId: string;
}

interface GetVariablesInput {
  sessionId: string;
  frameId?: number;
}

interface EvaluateExpressionInput {
  sessionId: string;
  expression: string;
  frameId?: number;
}

interface BreakpointInfo {
  id: string;
  file: string;
  line: number;
  enabled: boolean;
  verified: boolean;
  source: string;
  condition?: string;
  logMessage?: string;
}

// ---- Electron API shape (loose contract for IPC bridge) ----

interface ElectronDebugAPI {
  debugAddBreakpoint(bp: {
    file: string;
    line: number;
    condition?: string;
    logMessage?: string;
    source: string;
  }): Promise<BreakpointInfo>;
  debugRemoveBreakpoint(id: string): Promise<void>;
  debugGetBreakpoints(file?: string): Promise<BreakpointInfo[]>;
  debugClearBreakpoints(file?: string): Promise<void>;
  debugStartSession(config: {
    type: string;
    program: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
  }): Promise<{ id: string }>;
  debugStopSession(sessionId: string): Promise<void>;
  debugContinue(sessionId: string): Promise<void>;
  debugStepOver(sessionId: string): Promise<void>;
  debugStepInto(sessionId: string): Promise<void>;
  debugStepOut(sessionId: string): Promise<void>;
  debugGetVariables(sessionId: string, frameId?: number): Promise<unknown[]>;
  debugGetStackTrace(sessionId: string): Promise<unknown[]>;
  debugEvaluate(
    sessionId: string,
    expression: string,
    frameId?: number,
  ): Promise<{ value: unknown; type: string }>;
}

/**
 * Get the electron API (only available in Electron renderer process)
 */
function getElectronAPI(): ElectronDebugAPI {
  const electronWindow = globalThis as ElectronAPIWindow;
  if (typeof globalThis !== 'undefined' && electronWindow.window?.electronAPI) {
    return electronWindow.window.electronAPI as ElectronDebugAPI;
  }
  throw new Error('Editor tools are only available in Electron UI mode');
}

// ========= Breakpoint Tools =========

/**
 * SetBreakpoint - Set a breakpoint in a file
 */
const setBreakpointTool: Tool = {
  name: 'set_breakpoint',
  description: `Set a breakpoint at a specific line in a file.

Use this tool when you need to:
- Pause execution at a specific line to inspect state
- Debug a suspected bug location
- Understand program flow through stepping
- Inspect variable values at runtime

The breakpoint will be visible to the user in the Monaco Editor.
You can optionally add conditions (e.g., "x > 10") or log messages.

Examples:
- Simple breakpoint: { file: "/path/to/file.js", line: 42, source: "llm" }
- Conditional: { file: "/path/to/file.js", line: 42, condition: "count > 100", source: "llm" }
- Log point: { file: "/path/to/file.js", line: 42, logMessage: "Count: {count}", source: "llm" }

IMPORTANT: Always use source: "llm" to indicate the breakpoint was set by you.
This helps users distinguish between their breakpoints and yours.`,

  parameters: {
    type: 'object',
    properties: {
      file: {
        type: 'string',
        description: 'Absolute path to the file (e.g., "/Users/name/project/src/app.js")',
      },
      line: {
        type: 'number',
        description: 'Line number (1-indexed) where the breakpoint should be set',
      },
      condition: {
        type: 'string',
        description: 'Optional condition expression (e.g., "x > 10", "user.name === \'Alice\'")',
      },
      logMessage: {
        type: 'string',
        description: 'Optional log message for log points (e.g., "Value: {variable}")',
      },
      source: {
        type: 'string',
        enum: ['llm', 'user'],
        description: 'MUST be "llm" to indicate this breakpoint was set by the AI',
      },
    },
    required: ['file', 'line', 'source'],
  },

  function: async (input: SetBreakpointInput) => {
    const { file, line, condition, logMessage, source } = input;
    const api = getElectronAPI();

    // Enforce source = 'llm'
    if (source !== 'llm') {
      return JSON.stringify({
        success: false,
        error: 'Breakpoints set by AI must have source: "llm"',
      }, null, 2);
    }

    try {
      const breakpoint = await api.debugAddBreakpoint({
        file,
        line,
        condition,
        logMessage,
        source,
      });

      return JSON.stringify({
        success: true,
        breakpointId: breakpoint.id,
        file: breakpoint.file,
        line: breakpoint.line,
        enabled: breakpoint.enabled,
        message: `Breakpoint set at ${file}:${line}${condition ? ` (condition: ${condition})` : ''}`,
      }, null, 2);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return JSON.stringify({
        success: false,
        error: msg || 'Failed to set breakpoint',
      }, null, 2);
    }
  },
};

/**
 * RemoveBreakpoint - Remove a breakpoint
 */
const removeBreakpointTool: Tool = {
  name: 'remove_breakpoint',
  description: `Remove a specific breakpoint by ID.

Use this tool when you're done debugging a particular location
and want to clean up the breakpoint you previously set.`,

  parameters: {
    type: 'object',
    properties: {
      breakpointId: {
        type: 'string',
        description: 'The ID of the breakpoint to remove (returned from set_breakpoint)',
      },
    },
    required: ['breakpointId'],
  },

  function: async (input: RemoveBreakpointInput) => {
    const { breakpointId } = input;
    const api = getElectronAPI();

    try {
      await api.debugRemoveBreakpoint(breakpointId);
      return JSON.stringify({
        success: true,
        message: `Breakpoint ${breakpointId} removed`,
      }, null, 2);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return JSON.stringify({
        success: false,
        error: msg || 'Failed to remove breakpoint',
      }, null, 2);
    }
  },
};

/**
 * ListBreakpoints - List all breakpoints
 */
const listBreakpointsTool: Tool = {
  name: 'list_breakpoints',
  description: `List all breakpoints, optionally filtered by file.

Use this tool to:
- See what breakpoints are currently set
- Check if a breakpoint already exists before setting a new one
- Review breakpoints set by both you and the user`,

  parameters: {
    type: 'object',
    properties: {
      file: {
        type: 'string',
        description: 'Optional file path to filter breakpoints (absolute path)',
      },
    },
    required: [],
  },

  function: async (input: FileFilterInput) => {
    const { file } = input;
    const api = getElectronAPI();

    try {
      const breakpoints = await api.debugGetBreakpoints(file);
      return JSON.stringify({
        success: true,
        breakpoints: breakpoints.map((bp: BreakpointInfo) => ({
          id: bp.id,
          file: bp.file,
          line: bp.line,
          enabled: bp.enabled,
          verified: bp.verified,
          source: bp.source,
          condition: bp.condition,
          logMessage: bp.logMessage,
        })),
        count: breakpoints.length,
      }, null, 2);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return JSON.stringify({
        success: false,
        error: msg || 'Failed to list breakpoints',
      }, null, 2);
    }
  },
};

/**
 * ClearBreakpoints - Clear all breakpoints in a file or globally
 */
const clearBreakpointsTool: Tool = {
  name: 'clear_breakpoints',
  description: `Clear all breakpoints in a file or globally.

Use this tool when you want to:
- Clean up all breakpoints after debugging
- Start fresh debugging session
- Remove all breakpoints from a specific file

WARNING: This will remove ALL breakpoints (both user and LLM set).
Use with caution.`,

  parameters: {
    type: 'object',
    properties: {
      file: {
        type: 'string',
        description: 'Optional file path to clear breakpoints from (absolute path). If not provided, clears ALL breakpoints.',
      },
    },
    required: [],
  },

  function: async (input: FileFilterInput) => {
    const { file } = input;
    const api = getElectronAPI();

    try {
      await api.debugClearBreakpoints(file);
      return JSON.stringify({
        success: true,
        message: file ? `All breakpoints cleared from ${file}` : 'All breakpoints cleared globally',
      }, null, 2);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return JSON.stringify({
        success: false,
        error: msg || 'Failed to clear breakpoints',
      }, null, 2);
    }
  },
};

// ========= Debug Session Tools =========

/**
 * StartDebugSession - Start a debugging session
 */
const startDebugSessionTool: Tool = {
  name: 'start_debug_session',
  description: `Start a debugging session for a program.

Use this tool to begin debugging a Node.js, Python, or Java application.
After starting, the program will run until it hits a breakpoint or completes.

Supported languages:
- node: Node.js/JavaScript/TypeScript
- python: Python scripts
- java: Java applications (requires Java Debug Server)

Example:
{
  type: "node",
  program: "/path/to/app.js",
  args: ["--port", "3000"],
  cwd: "/path/to/project"
}`,

  parameters: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: ['node', 'python', 'java'],
        description: 'The type of program to debug',
      },
      program: {
        type: 'string',
        description: 'Absolute path to the program entry point (e.g., main.js, app.py, Main.java)',
      },
      args: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional command-line arguments for the program',
      },
      cwd: {
        type: 'string',
        description: 'Optional working directory (defaults to program directory)',
      },
      env: {
        type: 'object',
        description: 'Optional environment variables (e.g., { "NODE_ENV": "development" })',
      },
    },
    required: ['type', 'program'],
  },

  function: async (input: StartDebugSessionInput) => {
    const { type, program, args, cwd, env } = input;
    const api = getElectronAPI();

    try {
      const session = await api.debugStartSession({
        type,
        program,
        args,
        cwd,
        env,
      });

      return JSON.stringify({
        success: true,
        sessionId: session.id,
        message: `Debug session started: ${session.id}. Use this sessionId for debug operations.`,
      }, null, 2);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return JSON.stringify({
        success: false,
        error: msg || 'Failed to start debug session',
      }, null, 2);
    }
  },
};

/**
 * StopDebugSession - Stop a debugging session
 */
const stopDebugSessionTool: Tool = {
  name: 'stop_debug_session',
  description: `Stop a running debugging session.

Use this tool when you're done debugging to clean up resources
and terminate the debugged program.`,

  parameters: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: 'The debug session ID to stop',
      },
    },
    required: ['sessionId'],
  },

  function: async (input: SessionIdInput) => {
    const { sessionId } = input;
    const api = getElectronAPI();

    try {
      await api.debugStopSession(sessionId);
      return JSON.stringify({
        success: true,
        message: `Debug session ${sessionId} stopped`,
      }, null, 2);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return JSON.stringify({
        success: false,
        error: msg || 'Failed to stop debug session',
      }, null, 2);
    }
  },
};

/**
 * DebugContinue - Continue execution until next breakpoint
 */
const debugContinueTool: Tool = {
  name: 'debug_continue',
  description: `Continue program execution until the next breakpoint is hit or the program completes.

Use this tool after hitting a breakpoint to resume execution.`,

  parameters: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: 'The debug session ID',
      },
    },
    required: ['sessionId'],
  },

  function: async (input: SessionIdInput) => {
    const { sessionId } = input;
    const api = getElectronAPI();

    try {
      await api.debugContinue(sessionId);
      return JSON.stringify({
        success: true,
        message: 'Program execution continued',
      }, null, 2);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return JSON.stringify({
        success: false,
        error: msg || 'Failed to continue execution',
      }, null, 2);
    }
  },
};

/**
 * DebugStepOver - Step over the current line
 */
const debugStepOverTool: Tool = {
  name: 'debug_step_over',
  description: `Step over the current line of code.

Executes the current line and stops at the next line in the same function.
Function calls are executed without stepping into them.`,

  parameters: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: 'The debug session ID',
      },
    },
    required: ['sessionId'],
  },

  function: async (input: SessionIdInput) => {
    const { sessionId } = input;
    const api = getElectronAPI();

    try {
      await api.debugStepOver(sessionId);
      return JSON.stringify({
        success: true,
        message: 'Stepped over current line',
      }, null, 2);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return JSON.stringify({
        success: false,
        error: msg || 'Failed to step over',
      }, null, 2);
    }
  },
};

/**
 * DebugStepInto - Step into the current function call
 */
const debugStepIntoTool: Tool = {
  name: 'debug_step_into',
  description: `Step into the current function call.

If the current line contains a function call, steps into that function.
Otherwise, behaves like step_over.`,

  parameters: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: 'The debug session ID',
      },
    },
    required: ['sessionId'],
  },

  function: async (input: SessionIdInput) => {
    const { sessionId } = input;
    const api = getElectronAPI();

    try {
      await api.debugStepInto(sessionId);
      return JSON.stringify({
        success: true,
        message: 'Stepped into function',
      }, null, 2);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return JSON.stringify({
        success: false,
        error: msg || 'Failed to step into',
      }, null, 2);
    }
  },
};

/**
 * DebugStepOut - Step out of the current function
 */
const debugStepOutTool: Tool = {
  name: 'debug_step_out',
  description: `Step out of the current function.

Continues execution until the current function returns,
then stops at the call site.`,

  parameters: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: 'The debug session ID',
      },
    },
    required: ['sessionId'],
  },

  function: async (input: SessionIdInput) => {
    const { sessionId } = input;
    const api = getElectronAPI();

    try {
      await api.debugStepOut(sessionId);
      return JSON.stringify({
        success: true,
        message: 'Stepped out of function',
      }, null, 2);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return JSON.stringify({
        success: false,
        error: msg || 'Failed to step out',
      }, null, 2);
    }
  },
};

/**
 * GetVariables - Get variable values in current scope
 */
const getVariablesTool: Tool = {
  name: 'get_variables',
  description: `Get the values of all variables in the current scope.

Use this tool when stopped at a breakpoint to inspect:
- Local variables
- Function parameters
- Closure variables
- Global variables

Optionally specify a frameId to inspect a different stack frame.`,

  parameters: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: 'The debug session ID',
      },
      frameId: {
        type: 'number',
        description: 'Optional stack frame ID (0 = current frame, 1 = caller, etc.)',
      },
    },
    required: ['sessionId'],
  },

  function: async (input: GetVariablesInput) => {
    const { sessionId, frameId } = input;
    const api = getElectronAPI();

    try {
      const variables = await api.debugGetVariables(sessionId, frameId);
      return JSON.stringify({
        success: true,
        variables,
        count: variables.length,
      }, null, 2);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return JSON.stringify({
        success: false,
        error: msg || 'Failed to get variables',
      }, null, 2);
    }
  },
};

/**
 * GetStackTrace - Get the current call stack
 */
const getStackTraceTool: Tool = {
  name: 'get_stack_trace',
  description: `Get the current call stack (stack trace).

Use this tool when stopped at a breakpoint to understand:
- How the program reached the current location
- The chain of function calls
- Which files and lines are in the call path`,

  parameters: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: 'The debug session ID',
      },
    },
    required: ['sessionId'],
  },

  function: async (input: SessionIdInput) => {
    const { sessionId } = input;
    const api = getElectronAPI();

    try {
      const stackTrace = await api.debugGetStackTrace(sessionId);
      return JSON.stringify({
        success: true,
        stackTrace,
        depth: stackTrace.length,
      }, null, 2);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return JSON.stringify({
        success: false,
        error: msg || 'Failed to get stack trace',
      }, null, 2);
    }
  },
};

/**
 * EvaluateExpression - Evaluate an expression in the debug context
 */
const evaluateExpressionTool: Tool = {
  name: 'evaluate_expression',
  description: `Evaluate an expression in the current debug context.

Use this tool to:
- Check the value of a specific variable or expression
- Call functions to test behavior
- Perform calculations with current values
- Test conditions

Examples:
- "user.name" - Get a property value
- "count > 10" - Evaluate a condition
- "formatDate(timestamp)" - Call a function
- "arr[0] + arr[1]" - Perform calculations`,

  parameters: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: 'The debug session ID',
      },
      expression: {
        type: 'string',
        description: 'The expression to evaluate (e.g., "user.name", "count > 10")',
      },
      frameId: {
        type: 'number',
        description: 'Optional stack frame ID to evaluate in (default: current frame)',
      },
    },
    required: ['sessionId', 'expression'],
  },

  function: async (input: EvaluateExpressionInput) => {
    const { sessionId, expression, frameId } = input;
    const api = getElectronAPI();

    try {
      const result = await api.debugEvaluate(sessionId, expression, frameId);
      return JSON.stringify({
        success: true,
        result: result.value,
        type: result.type,
      }, null, 2);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return JSON.stringify({
        success: false,
        error: msg || 'Failed to evaluate expression',
      }, null, 2);
    }
  },
};

/**
 * Export all editor and debug tools
 */
export const editorTools: Tool[] = [
  // Breakpoint management
  setBreakpointTool,
  removeBreakpointTool,
  listBreakpointsTool,
  clearBreakpointsTool,
  // Debug session management
  startDebugSessionTool,
  stopDebugSessionTool,
  // Debug control
  debugContinueTool,
  debugStepOverTool,
  debugStepIntoTool,
  debugStepOutTool,
  // Inspection
  getVariablesTool,
  getStackTraceTool,
  evaluateExpressionTool,
  // IDE diagnostics (Monaco markers) — works via main↔renderer bridge, not renderer-only
  readLintsTool,
];

const editorToolCapabilities: ToolCapability[] = ['editor'];

/**
 * Create editor tools (for consistency with other tool modules)
 */
export function createEditorTools(): Tool[] {
  return editorTools.map((tool) => ({
    ...tool,
    capabilities: tool.capabilities
      ? Array.from(new Set([...tool.capabilities, ...editorToolCapabilities]))
      : editorToolCapabilities,
  }));
}
