/**
 * Java Debug Tools - LLM Tools for Java Debugging
 *
 * These tools enable AI agents to debug Java applications programmatically.
 */

import type { Tool, ToolCapability } from '@neoxlabs/kernel/types/index.js';
import { JavaDebugSessionManager } from './sessionManager.js';
import { getJavaDebugJarPath } from './utils.js';
import type {
  JavaDebugLaunchParams,
  JavaDebugAttachParams,
  JavaDebugSetBreakpointParams,
  JavaDebugContinueParams,
  JavaDebugStepParams,
  JavaDebugGetVariablesParams,
  JavaDebugGetStackTraceParams,
  JavaDebugEvaluateParams,
  JavaDebugStopParams,
} from './types.js';

// Singleton session manager (will be initialized in createJavaDebugTools)
let sessionManager: JavaDebugSessionManager | null = null;

/**
 * Get or create session manager
 */
function getSessionManager(): JavaDebugSessionManager {
  if (!sessionManager) {
    throw new Error(
      'Java Debug Session Manager not initialized. Call createJavaDebugTools() first.'
    );
  }
  return sessionManager;
}

/**
 * Create Java Debug Tools with configuration
 * Automatically detects bundled JAR if no path is provided
 */
export async function createJavaDebugTools(configJarPath?: string): Promise<Tool[]> {
  // Auto-detect JAR path (bundled or configured)
  const javaDebugJarPath = await getJavaDebugJarPath(configJarPath);

  // Initialize session manager
  sessionManager = new JavaDebugSessionManager({
    javaDebugJarPath,
    defaultTimeout: 30000,
    maxSessions: 5,
    sessionTimeout: 30 * 60 * 1000, // 30 minutes
  });

  const javaDebugTools: Tool[] = [
    javaDebugLaunchTool,
    javaDebugAttachTool,
    javaDebugSetBreakpointTool,
    javaDebugContinueTool,
    javaDebugStepOverTool,
    javaDebugStepIntoTool,
    javaDebugStepOutTool,
    javaDebugGetVariablesTool,
    javaDebugGetStackTraceTool,
    javaDebugEvaluateTool,
    javaDebugStopTool,
  ];

  const javaDebugCapabilities: ToolCapability[] = ['debug'];
  return javaDebugTools.map((tool) => ({
    ...tool,
    capabilities: tool.capabilities
      ? Array.from(new Set([...tool.capabilities, ...javaDebugCapabilities]))
      : javaDebugCapabilities,
  }));
}

// ========= Tool Definitions =========

/**
 * JavaDebugLaunch - Launch a Java application in debug mode
 */
const javaDebugLaunchTool: Tool = {
  name: 'java_debug_launch',
  description: `Launch a Java application in debug mode.

Use this tool when you need to start debugging a Java program from the beginning.

Examples:
- Debug a Spring Boot application
- Debug a standalone Java program
- Debug with specific JVM arguments or classpath

After launching, you'll receive a sessionId that you must use for all subsequent debug operations.`,

  parameters: {
    type: 'object',
    properties: {
      mainClass: {
        type: 'string',
        description: 'The fully qualified main class name (e.g., "com.example.Main", "org.springframework.boot.SpringApplication")',
      },
      projectPath: {
        type: 'string',
        description: 'The absolute path to the Java project root directory',
      },
      classpath: {
        type: 'string',
        description: 'Optional classpath for the application (JAR files, directories)',
      },
      args: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional program arguments (e.g., ["--port", "8080", "--debug"])',
      },
      vmArgs: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional JVM arguments (e.g., ["-Xmx512m", "-Dspring.profiles.active=dev"])',
      },
      stopOnEntry: {
        type: 'boolean',
        description: 'Stop at the entry point (main method). Default: false',
      },
      cwd: {
        type: 'string',
        description: 'Working directory for the application. Default: projectPath',
      },
    },
    required: ['mainClass', 'projectPath'],
  },

  async function(params: JavaDebugLaunchParams) {
    try {
      const manager = getSessionManager();
      const result = await manager.launch(params);

      return JSON.stringify({
        success: true,
        sessionId: result.sessionId,
        status: result.status,
        message: result.message,
      }, null, 2);
    } catch (error: any) {
      return JSON.stringify({
        success: false,
        error: error.message,
      }, null, 2);
    }
  },
};

/**
 * JavaDebugAttach - Attach to a running Java process
 */
const javaDebugAttachTool: Tool = {
  name: 'java_debug_attach',
  description: `Attach to a running Java process for debugging.

Use this tool when the Java application is already running with JDWP enabled.

To enable JDWP on a Java application, start it with:
java -agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=5005 YourApp

Common JDWP ports:
- 5005 (default)
- 8000
- Custom port specified by the application

After attaching, you'll receive a sessionId for all subsequent debug operations.`,

  parameters: {
    type: 'object',
    properties: {
      port: {
        type: 'number',
        description: 'The JDWP port number (usually 5005 or 8000)',
      },
      hostName: {
        type: 'string',
        description: 'The hostname to connect to. Default: "localhost"',
      },
      timeout: {
        type: 'number',
        description: 'Connection timeout in milliseconds. Default: 5000',
      },
    },
    required: ['port'],
  },

  async function(params: JavaDebugAttachParams) {
    try {
      const manager = getSessionManager();
      const result = await manager.attach(params);

      return JSON.stringify({
        success: true,
        sessionId: result.sessionId,
        status: result.status,
        message: result.message,
      }, null, 2);
    } catch (error: any) {
      return JSON.stringify({
        success: false,
        error: error.message,
      }, null, 2);
    }
  },
};

/**
 * JavaDebugSetBreakpoint - Set a breakpoint
 */
const javaDebugSetBreakpointTool: Tool = {
  name: 'java_debug_set_breakpoint',
  description: `Set a breakpoint at a specific line in a Java source file.

The program will pause when execution reaches this line, allowing you to inspect variables and stack trace.

You can set:
- Simple breakpoints (just line number)
- Conditional breakpoints (only trigger when condition is true)
- Hit condition breakpoints (trigger after N hits)
- Logpoint breakpoints (log a message without pausing)

Examples:
- Set breakpoint at line 25: {"sessionId": "...", "filePath": "/path/Main.java", "line": 25}
- Conditional breakpoint: {"sessionId": "...", "filePath": "/path/Main.java", "line": 30, "condition": "count > 10"}`,

  parameters: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: 'The debug session ID from java_debug_launch or java_debug_attach',
      },
      filePath: {
        type: 'string',
        description: 'The absolute path to the Java source file',
      },
      line: {
        type: 'number',
        description: 'The line number where to set the breakpoint (1-indexed)',
      },
      condition: {
        type: 'string',
        description: 'Optional condition expression (e.g., "count > 10", "user != null"). Breakpoint only triggers when condition is true.',
      },
      hitCondition: {
        type: 'string',
        description: 'Optional hit condition (e.g., ">5", "==3"). Breakpoint triggers after this many hits.',
      },
      logMessage: {
        type: 'string',
        description: 'Optional log message (logpoint). The breakpoint will log this message instead of pausing. Use {variable} for interpolation.',
      },
    },
    required: ['sessionId', 'filePath', 'line'],
  },

  async function(params: JavaDebugSetBreakpointParams) {
    try {
      const manager = getSessionManager();
      const result = await manager.setBreakpoint(params);

      return JSON.stringify({
        success: true,
        breakpointId: result.breakpointId,
        verified: result.verified,
        line: result.line,
        message: result.message,
      }, null, 2);
    } catch (error: any) {
      return JSON.stringify({
        success: false,
        error: error.message,
      }, null, 2);
    }
  },
};

/**
 * JavaDebugContinue - Continue program execution
 */
const javaDebugContinueTool: Tool = {
  name: 'java_debug_continue',
  description: `Continue program execution until the next breakpoint or program termination.

Use this tool to:
- Resume execution after hitting a breakpoint
- Run until the next breakpoint
- Let the program run to completion

The tool will return:
- "running" if the program continues without hitting a breakpoint (within timeout)
- "stopped" if a breakpoint is hit, with location details
- "terminated" if the program exits

When the program stops at a breakpoint, you can then use:
- java_debug_get_variables to inspect variables
- java_debug_get_stack_trace to see the call stack
- java_debug_evaluate to test expressions`,

  parameters: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: 'The debug session ID',
      },
      threadId: {
        type: 'number',
        description: 'Optional thread ID. Default: main thread',
      },
    },
    required: ['sessionId'],
  },

  async function(params: JavaDebugContinueParams) {
    try {
      const manager = getSessionManager();
      const result = await manager.continue(params);

      return JSON.stringify({
        success: true,
        status: result.status,
        stoppedReason: result.stoppedReason,
        location: result.location,
        message: result.message,
      }, null, 2);
    } catch (error: any) {
      return JSON.stringify({
        success: false,
        error: error.message,
      }, null, 2);
    }
  },
};

/**
 * JavaDebugStepOver - Step over (execute current line)
 */
const javaDebugStepOverTool: Tool = {
  name: 'java_debug_step_over',
  description: `Execute the current line and move to the next line (step over).

If the current line contains a method call, the entire method executes without stopping inside it.

Use this when:
- You want to quickly move through code
- You don't need to debug inside method calls
- You're looking for a specific line of code

Example workflow:
1. Set breakpoint at line 20
2. Continue execution (stops at line 20)
3. Step over to line 21, 22, 23... until you find the issue`,

  parameters: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: 'The debug session ID',
      },
      threadId: {
        type: 'number',
        description: 'Optional thread ID. Default: main thread',
      },
    },
    required: ['sessionId'],
  },

  async function(params: JavaDebugStepParams) {
    try {
      const manager = getSessionManager();
      const result = await manager.stepOver(params);

      return JSON.stringify({
        success: true,
        status: result.status,
        location: result.location,
        message: result.message,
      }, null, 2);
    } catch (error: any) {
      return JSON.stringify({
        success: false,
        error: error.message,
      }, null, 2);
    }
  },
};

/**
 * JavaDebugStepInto - Step into (enter method)
 */
const javaDebugStepIntoTool: Tool = {
  name: 'java_debug_step_into',
  description: `Execute the current line and step into method calls.

If the current line contains a method call, execution stops at the first line inside that method.

Use this when:
- You need to debug inside a method
- You want to trace execution flow into method calls
- You're investigating what a method does

Example:
Line 20: result = processData(input);

After step into, you'll be inside processData() at its first line.`,

  parameters: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: 'The debug session ID',
      },
      threadId: {
        type: 'number',
        description: 'Optional thread ID. Default: main thread',
      },
    },
    required: ['sessionId'],
  },

  async function(params: JavaDebugStepParams) {
    try {
      const manager = getSessionManager();
      const result = await manager.stepInto(params);

      return JSON.stringify({
        success: true,
        status: result.status,
        location: result.location,
        message: result.message,
      }, null, 2);
    } catch (error: any) {
      return JSON.stringify({
        success: false,
        error: error.message,
      }, null, 2);
    }
  },
};

/**
 * JavaDebugStepOut - Step out (finish current method)
 */
const javaDebugStepOutTool: Tool = {
  name: 'java_debug_step_out',
  description: `Execute until the current method returns (step out).

Execution continues until the current method completes and returns to its caller.

Use this when:
- You're inside a method but don't need to debug it further
- You want to quickly return to the calling method
- You stepped into a method by mistake

Example:
You're at line 15 inside processData() method.
After step out, you'll be at the line that called processData().`,

  parameters: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: 'The debug session ID',
      },
      threadId: {
        type: 'number',
        description: 'Optional thread ID. Default: main thread',
      },
    },
    required: ['sessionId'],
  },

  async function(params: JavaDebugStepParams) {
    try {
      const manager = getSessionManager();
      const result = await manager.stepOut(params);

      return JSON.stringify({
        success: true,
        status: result.status,
        location: result.location,
        message: result.message,
      }, null, 2);
    } catch (error: any) {
      return JSON.stringify({
        success: false,
        error: error.message,
      }, null, 2);
    }
  },
};

/**
 * JavaDebugGetVariables - Get variables in current scope
 */
const javaDebugGetVariablesTool: Tool = {
  name: 'java_debug_get_variables',
  description: `Get the values of variables in the current scope.

Use this tool when the program is paused (at a breakpoint or after stepping) to inspect:
- Local variables
- Method arguments
- Instance variables
- Static variables

This is one of the most important debugging tools - it lets you see the actual values of variables at runtime.

You can filter variables by:
- "local" - only local variables
- "arguments" - only method parameters
- "all" - all variables (default)

Example use case:
1. Program stops at breakpoint line 25
2. Call java_debug_get_variables to see all variable values
3. Analyze which variables have unexpected values
4. Identify the bug!`,

  parameters: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: 'The debug session ID',
      },
      frameId: {
        type: 'number',
        description: 'Optional stack frame ID. Default: current frame (0 = topmost frame)',
      },
      filter: {
        type: 'string',
        enum: ['local', 'arguments', 'all'],
        description: 'Filter variables by type. Default: "all"',
      },
    },
    required: ['sessionId'],
  },

  async function(params: JavaDebugGetVariablesParams) {
    try {
      const manager = getSessionManager();
      const result = await manager.getVariables(params);

      return JSON.stringify({
        success: true,
        variables: result.variables,
        message: result.message,
      }, null, 2);
    } catch (error: any) {
      return JSON.stringify({
        success: false,
        error: error.message,
      }, null, 2);
    }
  },
};

/**
 * JavaDebugGetStackTrace - Get call stack
 */
const javaDebugGetStackTraceTool: Tool = {
  name: 'java_debug_get_stack_trace',
  description: `Get the current call stack (stack trace).

The stack trace shows the sequence of method calls that led to the current point of execution.

Use this tool to:
- Understand the execution flow
- See which methods called which
- Find out how the program reached this point
- Identify recursion depth

The stack frames are ordered from most recent (top) to oldest (bottom):
Frame 0: Current method where execution is paused
Frame 1: The method that called Frame 0
Frame 2: The method that called Frame 1
... and so on

Example output:
Frame 0: processUser() at UserService.java:42
Frame 1: handleRequest() at RequestHandler.java:28
Frame 2: main() at Main.java:15`,

  parameters: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: 'The debug session ID',
      },
      threadId: {
        type: 'number',
        description: 'Optional thread ID. Default: main thread',
      },
    },
    required: ['sessionId'],
  },

  async function(params: JavaDebugGetStackTraceParams) {
    try {
      const manager = getSessionManager();
      const result = await manager.getStackTrace(params);

      return JSON.stringify({
        success: true,
        stackFrames: result.stackFrames,
        totalFrames: result.totalFrames,
        message: result.message,
      }, null, 2);
    } catch (error: any) {
      return JSON.stringify({
        success: false,
        error: error.message,
      }, null, 2);
    }
  },
};

/**
 * JavaDebugEvaluate - Evaluate expression in debug context
 */
const javaDebugEvaluateTool: Tool = {
  name: 'java_debug_evaluate',
  description: `Evaluate a Java expression in the current debug context.

This is an extremely powerful tool that lets you:
- Check variable values with custom logic
- Test hypotheses about the bug
- Call methods to see what they return
- Compute complex expressions
- Test fixes before applying them

You can evaluate:
- Variable access: "user.getName()"
- Arithmetic: "count * 2 + offset"
- Comparisons: "user != null && user.isActive()"
- Method calls: "calculateTotal(items)"
- Ternary: "count > 0 ? count : DEFAULT_COUNT"

The expression is evaluated in the context of the current stack frame, so you have access to all visible variables.

Example debugging workflow:
1. Program stops at line 25, variable 'user' is null
2. Evaluate: "user != null" -> false
3. Look at stack trace to see where user was initialized
4. Evaluate: "getUserFromCache(userId)" to test if cache has the user
5. Identify that cache lookup is failing`,

  parameters: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: 'The debug session ID',
      },
      expression: {
        type: 'string',
        description: 'The Java expression to evaluate (e.g., "user.getName()", "count > 10", "items.size()")',
      },
      frameId: {
        type: 'number',
        description: 'Optional stack frame ID. Default: current frame',
      },
      context: {
        type: 'string',
        enum: ['watch', 'repl', 'hover'],
        description: 'Evaluation context. Default: "repl"',
      },
    },
    required: ['sessionId', 'expression'],
  },

  async function(params: JavaDebugEvaluateParams) {
    try {
      const manager = getSessionManager();
      const result = await manager.evaluate(params);

      return JSON.stringify({
        success: true,
        result: result.result,
        type: result.type,
        message: result.message,
      }, null, 2);
    } catch (error: any) {
      return JSON.stringify({
        success: false,
        error: error.message,
      }, null, 2);
    }
  },
};

/**
 * JavaDebugStop - Stop debug session
 */
const javaDebugStopTool: Tool = {
  name: 'java_debug_stop',
  description: `Stop the debug session and optionally terminate the debugged program.

Always call this tool when you're done debugging to clean up resources.

By default, this will terminate the debugged program. Set terminateDebuggee=false to disconnect without killing the program.`,

  parameters: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: 'The debug session ID',
      },
      terminateDebuggee: {
        type: 'boolean',
        description: 'Whether to terminate the debugged program. Default: true',
      },
    },
    required: ['sessionId'],
  },

  async function(params: JavaDebugStopParams) {
    try {
      const manager = getSessionManager();
      const result = await manager.stop(params);

      return JSON.stringify({
        success: true,
        status: result.status,
        message: result.message,
      }, null, 2);
    } catch (error: any) {
      return JSON.stringify({
        success: false,
        error: error.message,
      }, null, 2);
    }
  },
};
