/**
 * JvmDapBackend — DebugSession 的 JVM 实现 (DAP 后端).
 *
 * 持一个 DapClient (拉 jvm-debugger.jar 子进程), 把 DebugSession 接口翻成 DAP
 * request/response. M0 只接 lifecycle (start/disconnect) + 透传 events. M1 起
 * 加 breakpoint/step/eval, M3 起加 evaluate, M4 起加 redefineClasses 等.
 *
 * 这个文件 import 了 DapClient (Node-only), 所以放在 ui/electron 下 ——
 * 跟 src/ide/debug/ 下面的纯接口分开.
 */

import type {
  DebugSession,
  DebugSessionListener,
} from '../../../../ide/debug/DebugSession.js';
import type {
  Breakpoint,
  DebugSessionCapabilities,
  DebugSessionEvent,
  DebugSessionStatus,
  EvaluateResult,
  JvmAttachConfig,
  JvmLaunchConfig,
  LineBreakpoint,
  Scope,
  StackFrame,
  ThreadInfo,
  Variable,
} from '@neoxlabs/platform/shared/debug-types.js';

import type { DapClient, DapEvent } from './DapClient.js';

export interface JvmDapBackendDeps {
  /** 已经构造好但还没 start 的 DapClient. backend 接管它. */
  client: DapClient;
  /** 给 session 一个稳定 id (UI 用) */
  sessionId: string;
  onBeforeConfigurationDone?: (session: DebugSession) => Promise<void>;
}

export class JvmDapBackend implements DebugSession {
  readonly id: string;
  readonly config: JvmLaunchConfig | JvmAttachConfig;
  readonly capabilities: DebugSessionCapabilities;

  private readonly client: DapClient;
  private readonly listeners = new Set<DebugSessionListener>();
  private currentStatus: DebugSessionStatus = 'initializing';
  private readonly onBeforeConfigurationDone?: (session: DebugSession) => Promise<void>;

  constructor(config: JvmLaunchConfig | JvmAttachConfig, deps: JvmDapBackendDeps) {
    this.id = deps.sessionId;
    this.config = config;
    this.client = deps.client;
    this.onBeforeConfigurationDone = deps.onBeforeConfigurationDone;

    // M0 静态填; serverCaps 拿到后会用真实值覆盖
    this.capabilities = {
      conditionalBreakpoints: false,
      hitConditionalBreakpoints: false,
      logPoints: false,
      functionBreakpoints: false,
      exceptionBreakpoints: false,
      fieldBreakpoints: false,
      evaluate: false,
      setVariable: false,
      hotswap: false,
      dropFrame: false,
      forceEarlyReturn: false,
      memoryAgent: false,
      asyncStacks: false,
      streamDebugger: false,
      markObject: false,
    };

    this.client.on('event', (ev: DapEvent) => this.handleDapEvent(ev));
    this.client.on('exit', ({ code }: { code: number | null }) => {
      this.setStatus('terminated');
      this.emit({ type: 'exited', exitCode: code ?? 0 });
    });
    this.client.on('error', (err: Error) => {
      this.emit({ type: 'output', category: 'stderr', output: `[backend error] ${err.message}\n` });
    });
  }

  status(): DebugSessionStatus {
    return this.currentStatus;
  }

  onEvent(listener: DebugSessionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ─── 生命周期 ─────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.setStatus('initializing');
    this.client.start();

    const caps = (await this.client.sendRequest('initialize', {
      clientID: 'neox',
      clientName: 'Neox',
      adapterID: 'neox-jvm-debugger',
      pathFormat: 'path',
      linesStartAt1: true,
      columnsStartAt1: true,
      supportsRunInTerminalRequest: false,
    })) as Record<string, unknown> | undefined;
    if (caps) this.applyServerCaps(caps);

    this.setStatus('launching');
    if (this.config.kind === 'jvm-launch') {
      await this.client.sendRequest('launch', {
        mainClass: this.config.mainClass,
        classpath: this.config.classpath,
        modulePath: this.config.modulePath,
        jvmArgs: this.config.jvmArgs,
        programArgs: this.config.programArgs,
        cwd: this.config.cwd,
        env: this.config.env,
        stopOnEntry: this.config.stopOnEntry ?? false,
      });
    } else {
      await this.client.sendRequest('attach', {
        host: this.config.host,
        port: this.config.port,
      });
    }

    // 在 configurationDone 之前把断点一次性推给 jvm-debugger —— target 此刻
    // 在 VMStartEvent 挂着不动, ClassPrepareRequest 后面会接管延迟加载的 class
    if (this.onBeforeConfigurationDone) {
      try {
        await this.onBeforeConfigurationDone(this);
      } catch (err) {
        console.warn('[JvmDapBackend] onBeforeConfigurationDone threw:', err);
      }
    }

    try {
      await this.client.sendRequest('configurationDone', {});
    } catch {
      // jvm-debugger 没注册 configurationDone 的老版本可忽略 (M0 曾经这样)
    }
    this.setStatus('running');
  }

  async disconnect(terminate = false): Promise<void> {
    this.setStatus('terminating');
    await this.client.stop(terminate);
    this.setStatus('terminated');
  }

  // ─── 执行控制 (M1 接通) ──────────────────────────────────────────────

  async resume(threadId?: number): Promise<void> {
    await this.client.sendRequest('continue', { threadId: threadId ?? 1 });
  }
  async pause(threadId?: number): Promise<void> {
    await this.client.sendRequest('pause', { threadId: threadId ?? 1 });
  }
  async stepOver(threadId: number): Promise<void> {
    await this.client.sendRequest('next', { threadId });
  }
  async stepInto(threadId: number): Promise<void> {
    await this.client.sendRequest('stepIn', { threadId });
  }
  async stepOut(threadId: number): Promise<void> {
    await this.client.sendRequest('stepOut', { threadId });
  }

  // ─── 断点 ────────────────────────────────────────────────────────────

  async setLineBreakpoints(file: string, breakpoints: LineBreakpoint[]): Promise<LineBreakpoint[]> {
    const body = (await this.client.sendRequest('setBreakpoints', {
      source: { path: file },
      breakpoints: breakpoints.map((bp) => ({
        line: bp.line,
        condition: bp.condition,
        hitCondition: bp.hitCondition,
        logMessage: bp.logMessage,
      })),
    })) as { breakpoints?: Array<{ verified?: boolean; line?: number; message?: string }> } | undefined;
    const verified = body?.breakpoints ?? [];
    return breakpoints.map((bp, idx) => ({
      ...bp,
      verified: verified[idx]?.verified,
      line: verified[idx]?.line ?? bp.line,
      message: verified[idx]?.message,
    }));
  }

  async setBreakpoints(breakpoints: Breakpoint[]): Promise<Breakpoint[]> {
    // M2 实现; 现在直接回原值
    return breakpoints;
  }

  // ─── 检查 ────────────────────────────────────────────────────────────

  async threads(): Promise<ThreadInfo[]> {
    const body = (await this.client.sendRequest('threads')) as { threads?: ThreadInfo[] } | undefined;
    return body?.threads ?? [];
  }

  async stackFrames(threadId: number): Promise<StackFrame[]> {
    const body = (await this.client.sendRequest('stackTrace', {
      threadId,
      startFrame: 0,
      levels: 100,
    })) as
      | {
          stackFrames?: Array<{
            id: number;
            name: string;
            source?: { path?: string };
            line?: number;
            column?: number;
          }>;
        }
      | undefined;
    return (body?.stackFrames ?? []).map((f) => ({
      id: f.id,
      name: f.name,
      source: f.source?.path,
      line: f.line,
      column: f.column,
    }));
  }

  async scopes(frameId: number): Promise<Scope[]> {
    const body = (await this.client.sendRequest('scopes', { frameId })) as { scopes?: Scope[] } | undefined;
    return body?.scopes ?? [];
  }

  async variables(variablesReference: number): Promise<Variable[]> {
    const body = (await this.client.sendRequest('variables', { variablesReference })) as
      | { variables?: Variable[] }
      | undefined;
    return body?.variables ?? [];
  }

  async evaluate(expression: string, frameId?: number): Promise<EvaluateResult> {
    const body = (await this.client.sendRequest('evaluate', { expression, frameId, context: 'repl' })) as
      | EvaluateResult
      | undefined;
    return body ?? { result: '', variablesReference: 0 };
  }

  // ─── 内部 ─────────────────────────────────────────────────────────────

  private setStatus(status: DebugSessionStatus): void {
    if (this.currentStatus === status) return;
    this.currentStatus = status;
  }

  private emit(event: DebugSessionEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (err) {
        console.error('[JvmDapBackend] listener threw:', err);
      }
    }
  }

  private handleDapEvent(ev: DapEvent): void {
    switch (ev.event) {
      case 'output': {
        const b = ev.body as { category?: string; output?: string } | undefined;
        this.emit({
          type: 'output',
          category:
            (b?.category as 'stdout' | 'stderr' | 'console' | 'telemetry') ?? 'console',
          output: b?.output ?? '',
        });
        break;
      }
      case 'thread': {
        const b = ev.body as { reason?: 'started' | 'exited'; threadId?: number } | undefined;
        if (b?.threadId != null) {
          this.emit({ type: 'thread', reason: b.reason ?? 'started', threadId: b.threadId });
        }
        break;
      }
      case 'stopped': {
        const b = ev.body as
          | { reason?: string; threadId?: number; description?: string; hitBreakpointIds?: string[] }
          | undefined;
        if (b?.threadId != null) {
          this.setStatus('paused');
          this.emit({
            type: 'stopped',
            reason: (b.reason as never) ?? 'pause',
            threadId: b.threadId,
            description: b.description,
            hitBreakpointIds: b.hitBreakpointIds,
          });
        }
        break;
      }
      case 'continued': {
        const b = ev.body as { threadId?: number; allThreadsContinued?: boolean } | undefined;
        if (b?.threadId != null) {
          this.setStatus('running');
          this.emit({
            type: 'continued',
            threadId: b.threadId,
            allThreadsContinued: b.allThreadsContinued,
          });
        }
        break;
      }
      case 'terminated': {
        this.emit({ type: 'terminated' });
        break;
      }
      case 'initialized': {
        // 标准 DAP 流程: 这之后 client 才能下 setBreakpoints, 然后 configurationDone.
        // M0 不在这处理 — start() 顺序写死了, M1 起再做异步初始化.
        break;
      }
    }
  }

  private applyServerCaps(caps: Record<string, unknown>): void {
    const c = this.capabilities as Writable<DebugSessionCapabilities>;
    c.conditionalBreakpoints = !!caps.supportsConditionalBreakpoints;
    c.hitConditionalBreakpoints = !!caps.supportsHitConditionalBreakpoints;
    c.logPoints = !!caps.supportsLogPoints;
    c.functionBreakpoints = !!caps.supportsFunctionBreakpoints;
    c.exceptionBreakpoints = !!caps.supportsExceptionFilterOptions;
    c.evaluate = !!caps.supportsEvaluateForHovers;
    c.setVariable = !!caps.supportsSetVariable;
    const neox = caps.neox as Record<string, boolean> | undefined;
    if (neox) {
      c.hotswap = !!neox.hotswap;
      c.dropFrame = !!neox.dropFrame;
      c.forceEarlyReturn = !!neox.forceEarlyReturn;
      c.memoryAgent = !!neox.memoryAgent;
      c.asyncStacks = !!neox.asyncStacks;
      c.streamDebugger = !!neox.streamDebugger;
      c.markObject = !!neox.markObject;
      c.fieldBreakpoints = !!neox.fieldBreakpoints;
    }
  }
}

type Writable<T> = { -readonly [K in keyof T]: T[K] };
