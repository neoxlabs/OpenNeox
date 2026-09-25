/**
 * Java Debug Session Manager
 *
 * Manages multiple debug sessions, coordinating between DAP clients and Java Debug Servers.
 * This is the main interface for the Java Debug Tools.
 */

import { EventEmitter } from 'events';
import path from 'path';
import { DAPClient } from './dapClient.js';
import { JavaDebugServer } from './javaDebugServer.js';
import type {
  DebugSession,
  SessionStatus,
  JavaDebugConfig,
  JavaDebugLaunchParams,
  JavaDebugLaunchResult,
  JavaDebugAttachParams,
  JavaDebugAttachResult,
  JavaDebugSetBreakpointParams,
  JavaDebugSetBreakpointResult,
  JavaDebugContinueParams,
  JavaDebugContinueResult,
  JavaDebugStepParams,
  JavaDebugStepResult,
  JavaDebugGetVariablesParams,
  JavaDebugGetVariablesResult,
  JavaDebugGetStackTraceParams,
  JavaDebugGetStackTraceResult,
  JavaDebugEvaluateParams,
  JavaDebugEvaluateResult,
  JavaDebugStopParams,
  JavaDebugStopResult,
  Breakpoint,
} from './types.js';

export class JavaDebugSessionManager extends EventEmitter {
  private sessions = new Map<string, {
    session: DebugSession;
    client: DAPClient;
    server: JavaDebugServer | null;
  }>();

  private config: JavaDebugConfig;
  private sessionIdCounter = 0;

  constructor(config: JavaDebugConfig) {
    super();
    this.config = config;

    // Setup periodic cleanup of inactive sessions
    if (this.config.sessionTimeout) {
      setInterval(() => {
        this.cleanupInactiveSessions();
      }, 60000); // Check every minute
    }
  }

  /**
   * Launch a new debug session
   */
  async launch(params: JavaDebugLaunchParams): Promise<JavaDebugLaunchResult> {
    const sessionId = this.generateSessionId();

    try {
      // 1. Start Java Debug Server
      const server = new JavaDebugServer({
        jarPath: this.config.javaDebugJarPath,
        javaHome: this.config.javaHome,
        startupTimeout: this.config.defaultTimeout,
      });

      const port = await server.start();

      // 2. Connect DAP client
      const client = new DAPClient();
      await client.connect('localhost', port);

      // 3. Initialize debug session
      await client.initialize({
        clientID: 'neox',
        clientName: 'Neox Java Debugger',
        adapterID: 'java',
        pathFormat: 'path',
        linesStartAt1: true,
        columnsStartAt1: true,
      });

      // 4. Launch program
      await client.launch({
        mainClass: params.mainClass,
        projectName: path.basename(params.projectPath),
        classPaths: params.classpath ? [params.classpath] : [],
        args: params.args?.join(' '),
        vmArgs: params.vmArgs?.join(' '),
        cwd: params.cwd || params.projectPath,
        stopOnEntry: params.stopOnEntry,
      });

      // 5. Configuration done
      await client.configurationDone();

      // 6. Create session record
      const session: DebugSession = {
        id: sessionId,
        status: 'running',
        breakpoints: new Map(),
        createdAt: Date.now(),
        lastActivity: Date.now(),
      };

      this.sessions.set(sessionId, { session, client, server });

      // 7. Setup event listeners
      this.setupClientListeners(sessionId, client);

      return {
        sessionId,
        status: 'running',
        message: `Debug session started for ${params.mainClass}`,
      };
    } catch (error: any) {
      throw new Error(`Failed to launch debug session: ${error.message}`);
    }
  }

  /**
   * Attach to a running Java process
   */
  async attach(params: JavaDebugAttachParams): Promise<JavaDebugAttachResult> {
    const sessionId = this.generateSessionId();

    try {
      // 1. Connect directly to JDWP port (no need to start Java Debug Server)
      const client = new DAPClient();
      await client.connect(params.hostName || 'localhost', params.port);

      // 2. Initialize debug session
      await client.initialize({
        clientID: 'neox',
        clientName: 'Neox Java Debugger',
        adapterID: 'java',
        pathFormat: 'path',
        linesStartAt1: true,
        columnsStartAt1: true,
      });

      // 3. Attach to process
      await client.attach({
        hostName: params.hostName || 'localhost',
        port: params.port,
        timeout: params.timeout || 5000,
      });

      // 4. Configuration done
      await client.configurationDone();

      // 5. Create session record
      const session: DebugSession = {
        id: sessionId,
        status: 'running',
        breakpoints: new Map(),
        createdAt: Date.now(),
        lastActivity: Date.now(),
      };

      this.sessions.set(sessionId, { session, client, server: null });

      // 6. Setup event listeners
      this.setupClientListeners(sessionId, client);

      return {
        sessionId,
        status: 'running',
        message: `Attached to Java process on ${params.hostName || 'localhost'}:${params.port}`,
      };
    } catch (error: any) {
      throw new Error(`Failed to attach to process: ${error.message}`);
    }
  }

  /**
   * Set a breakpoint
   */
  async setBreakpoint(params: JavaDebugSetBreakpointParams): Promise<JavaDebugSetBreakpointResult> {
    const ctx = this.getSessionContext(params.sessionId);
    ctx.session.lastActivity = Date.now();

    try {
      const response = await ctx.client.setBreakpoints({
        source: { path: params.filePath },
        breakpoints: [
          {
            line: params.line,
            condition: params.condition,
            hitCondition: params.hitCondition,
            logMessage: params.logMessage,
          },
        ],
      });

      const breakpoint = response.body.breakpoints[0];

      // Store breakpoint
      if (!ctx.session.breakpoints.has(params.filePath)) {
        ctx.session.breakpoints.set(params.filePath, []);
      }
      ctx.session.breakpoints.get(params.filePath)!.push(breakpoint);

      return {
        breakpointId: breakpoint.id || -1,
        verified: breakpoint.verified,
        line: breakpoint.line || params.line,
        message: breakpoint.verified
          ? `Breakpoint set at line ${breakpoint.line}`
          : `Breakpoint not verified: ${breakpoint.message || 'Unknown reason'}`,
      };
    } catch (error: any) {
      throw new Error(`Failed to set breakpoint: ${error.message}`);
    }
  }

  /**
   * Continue execution
   */
  async continue(params: JavaDebugContinueParams): Promise<JavaDebugContinueResult> {
    const ctx = this.getSessionContext(params.sessionId);
    ctx.session.lastActivity = Date.now();

    try {
      const threadId = params.threadId || ctx.session.currentThreadId || 1;

      await ctx.client.continue({ threadId });
      ctx.session.status = 'running';

      // Wait for stopped event or timeout
      return await this.waitForStoppedOrTimeout(ctx, threadId);
    } catch (error: any) {
      throw new Error(`Failed to continue execution: ${error.message}`);
    }
  }

  /**
   * Step over
   */
  async stepOver(params: JavaDebugStepParams): Promise<JavaDebugStepResult> {
    return await this.performStep(params, 'stepOver');
  }

  /**
   * Step into
   */
  async stepInto(params: JavaDebugStepParams): Promise<JavaDebugStepResult> {
    return await this.performStep(params, 'stepInto');
  }

  /**
   * Step out
   */
  async stepOut(params: JavaDebugStepParams): Promise<JavaDebugStepResult> {
    return await this.performStep(params, 'stepOut');
  }

  /**
   * Get variables in current scope
   */
  async getVariables(params: JavaDebugGetVariablesParams): Promise<JavaDebugGetVariablesResult> {
    const ctx = this.getSessionContext(params.sessionId);
    ctx.session.lastActivity = Date.now();

    try {
      const threadId = ctx.session.currentThreadId || 1;
      const frameId = params.frameId || ctx.session.currentFrameId || 0;

      // Get stack trace to ensure we have a valid frame
      const stackResponse = await ctx.client.stackTrace({
        threadId,
        startFrame: 0,
        levels: 1,
      });

      if (stackResponse.body.stackFrames.length === 0) {
        throw new Error('No stack frames available');
      }

      const frame = stackResponse.body.stackFrames[0];

      // Get scopes for the frame
      const scopesResponse = await ctx.client.scopes({ frameId: frame.id });

      // Collect variables from all scopes (or filtered)
      const allVariables: any[] = [];

      for (const scope of scopesResponse.body.scopes) {
        if (params.filter === 'local' && scope.name !== 'Local') continue;
        if (params.filter === 'arguments' && scope.name !== 'Arguments') continue;

        const varsResponse = await ctx.client.variables({
          variablesReference: scope.variablesReference,
        });

        allVariables.push(...varsResponse.body.variables);
      }

      return {
        variables: allVariables.map((v) => ({
          name: v.name,
          value: v.value,
          type: v.type || 'unknown',
          variablesReference: v.variablesReference,
        })),
        message: `Retrieved ${allVariables.length} variables`,
      };
    } catch (error: any) {
      throw new Error(`Failed to get variables: ${error.message}`);
    }
  }

  /**
   * Get stack trace
   */
  async getStackTrace(params: JavaDebugGetStackTraceParams): Promise<JavaDebugGetStackTraceResult> {
    const ctx = this.getSessionContext(params.sessionId);
    ctx.session.lastActivity = Date.now();

    try {
      const threadId = params.threadId || ctx.session.currentThreadId || 1;

      const response = await ctx.client.stackTrace({
        threadId,
        startFrame: 0,
        levels: 50, // Get top 50 frames
      });

      return {
        stackFrames: response.body.stackFrames.map((f: any) => ({
          id: f.id,
          name: f.name,
          source: {
            path: f.source?.path || 'unknown',
            line: f.line,
          },
          presentationHint: f.presentationHint,
        })),
        totalFrames: response.body.totalFrames || response.body.stackFrames.length,
        message: `Retrieved ${response.body.stackFrames.length} stack frames`,
      };
    } catch (error: any) {
      throw new Error(`Failed to get stack trace: ${error.message}`);
    }
  }

  /**
   * Evaluate expression
   */
  async evaluate(params: JavaDebugEvaluateParams): Promise<JavaDebugEvaluateResult> {
    const ctx = this.getSessionContext(params.sessionId);
    ctx.session.lastActivity = Date.now();

    try {
      const frameId = params.frameId || ctx.session.currentFrameId;

      const response = await ctx.client.evaluate({
        expression: params.expression,
        frameId,
        context: params.context || 'repl',
      });

      return {
        result: response.body.result,
        type: response.body.type || 'unknown',
        variablesReference: response.body.variablesReference,
        message: `Expression evaluated: ${response.body.result}`,
      };
    } catch (error: any) {
      throw new Error(`Failed to evaluate expression: ${error.message}`);
    }
  }

  /**
   * Stop debug session
   */
  async stop(params: JavaDebugStopParams): Promise<JavaDebugStopResult> {
    const ctx = this.getSessionContext(params.sessionId);

    try {
      // Disconnect from debuggee
      await ctx.client.disconnectRequest({
        terminateDebuggee: params.terminateDebuggee !== false,
      });

      // Stop server if we started it
      if (ctx.server) {
        ctx.server.stop();
      }

      // Remove session
      this.sessions.delete(params.sessionId);

      return {
        status: 'terminated',
        message: 'Debug session stopped',
      };
    } catch (error: any) {
      // Even if disconnect fails, clean up
      this.sessions.delete(params.sessionId);

      return {
        status: 'terminated',
        message: `Debug session stopped (with error: ${error.message})`,
      };
    }
  }

  /**
   * Get session info
   */
  getSession(sessionId: string): DebugSession | null {
    return this.sessions.get(sessionId)?.session || null;
  }

  /**
   * List all active sessions
   */
  listSessions(): DebugSession[] {
    return Array.from(this.sessions.values()).map((ctx) => ctx.session);
  }

  // ========= Private Methods =========

  private generateSessionId(): string {
    return `java-debug-${Date.now()}-${++this.sessionIdCounter}`;
  }

  private getSessionContext(sessionId: string) {
    const ctx = this.sessions.get(sessionId);
    if (!ctx) {
      throw new Error(`Debug session not found: ${sessionId}`);
    }
    return ctx;
  }

  private setupClientListeners(sessionId: string, client: DAPClient): void {
    client.on('event', (event) => {
      const ctx = this.sessions.get(sessionId);
      if (!ctx) return;

      switch (event.event) {
        case 'stopped':
          ctx.session.status = 'stopped';
          ctx.session.currentThreadId = event.body.threadId;
          ctx.session.stoppedReason = event.body.reason;
          ctx.session.lastActivity = Date.now();
          break;

        case 'continued':
          ctx.session.status = 'running';
          ctx.session.lastActivity = Date.now();
          break;

        case 'terminated':
          ctx.session.status = 'terminated';
          ctx.session.lastActivity = Date.now();
          break;
      }

      this.emit('session:event', {
        sessionId,
        event: event.event,
        body: event.body,
      });
    });
  }

  private async waitForStoppedOrTimeout(
    ctx: { session: DebugSession; client: DAPClient },
    threadId: number,
    timeout: number = 5000
  ): Promise<JavaDebugContinueResult> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        ctx.client.off('event:stopped', listener);
        ctx.client.off('event:terminated', listener);
        resolve({
          status: 'running',
          message: 'Program is running',
        });
      }, timeout);

      const listener = (body: any) => {
        clearTimeout(timer);
        ctx.client.off('event:stopped', listener);
        ctx.client.off('event:terminated', listener);

        if (body.reason) {
          // Stopped event
          resolve({
            status: 'stopped',
            stoppedReason: body.reason,
            location: body.source
              ? {
                  filePath: body.source.path,
                  line: body.line,
                  column: body.column || 0,
                }
              : undefined,
            message: `Program stopped: ${body.reason}`,
          });
        } else {
          // Terminated event
          resolve({
            status: 'terminated',
            message: 'Program terminated',
          });
        }
      };

      ctx.client.once('event:stopped', listener);
      ctx.client.once('event:terminated', listener);
    });
  }

  private async performStep(
    params: JavaDebugStepParams,
    stepType: 'stepOver' | 'stepInto' | 'stepOut'
  ): Promise<JavaDebugStepResult> {
    const ctx = this.getSessionContext(params.sessionId);
    ctx.session.lastActivity = Date.now();

    try {
      const threadId = params.threadId || ctx.session.currentThreadId || 1;

      // Perform step
      switch (stepType) {
        case 'stepOver':
          await ctx.client.next({ threadId });
          break;
        case 'stepInto':
          await ctx.client.stepIn({ threadId });
          break;
        case 'stepOut':
          await ctx.client.stepOut({ threadId });
          break;
      }

      // Wait for stopped event
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Step operation timeout'));
        }, 5000);

        ctx.client.once('event:stopped', async (body: any) => {
          clearTimeout(timeout);

          // Get current location
          try {
            const stackResponse = await ctx.client.stackTrace({
              threadId,
              startFrame: 0,
              levels: 1,
            });

            const frame = stackResponse.body.stackFrames[0];
            ctx.session.currentFrameId = frame.id;

            resolve({
              status: 'stopped',
              location: {
                filePath: frame.source?.path || 'unknown',
                line: frame.line,
                method: frame.name,
              },
              message: `Stepped to ${frame.name} at line ${frame.line}`,
            });
          } catch (error) {
            reject(error);
          }
        });
      });
    } catch (error: any) {
      throw new Error(`Failed to perform step: ${error.message}`);
    }
  }

  private cleanupInactiveSessions(): void {
    if (!this.config.sessionTimeout) return;

    const now = Date.now();
    for (const [sessionId, ctx] of this.sessions.entries()) {
      const inactiveTime = now - ctx.session.lastActivity;

      if (inactiveTime > this.config.sessionTimeout) {
        console.log(`Cleaning up inactive session: ${sessionId}`);
        this.stop({ sessionId }).catch((error) => {
          console.error(`Failed to stop inactive session ${sessionId}:`, error);
        });
      }
    }
  }
}
