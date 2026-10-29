
import * as pty from 'node-pty';
import { randomUUID } from 'crypto';
import { ProjectService } from '../context/ProjectService.js';
import type { ProjectScope } from '../context/ProjectScope.js';
import { OWNED_IDS_TRACKER } from '../context/tokens.js';
import { getShellEnv } from '@neoxlabs/platform/platform/shellEnv.js';

/** 运行进程的 launch 描述 (跟 runConfigIpcHandlers.RunLaunchSpec 同构) */
export interface RunProcessSpec {
  configurationId: string;
  configurationName: string;
  executorId: string;
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  debug?: {
    protocol: string;
    port?: number;
  };
}

interface RunningProc {
  processId: string;
  configurationId: string;
  configurationName: string;
  executorId: string;
  pid: number;
  ptyProcess: pty.IPty;
  startedAt: string;
}

/** `run-launch:get-running` handler 返回的进程 metadata */
export interface RunningProcessInfo {
  processId: string;
  configurationId: string;
  configurationName: string;
  executorId: string;
  pid: number;
  startedAt: string;
}

export class RunProcessManager extends ProjectService {
  private readonly processes = new Map<string, RunningProc>();

  constructor(scope: ProjectScope) {
    super(scope);
  }

  /**
   * 启动一个进程. 返回 processId.
   * 进程事件通过本 scope 的 window.webContents.send 发给正确的窗口.
   */
  start(spec: RunProcessSpec): string {
    const env: Record<string, string> = {
      ...getShellEnv(),
      ...(spec.env || {}),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      FORCE_COLOR: '1',
    };

    const cols = spec.cols && spec.cols > 0 ? spec.cols : 120;
    const rows = spec.rows && spec.rows > 0 ? spec.rows : 30;

    const ptyProcess = pty.spawn(spec.command, spec.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: spec.cwd,
      env,
    });

    const processId = randomUUID();
    const running: RunningProc = {
      processId,
      configurationId: spec.configurationId,
      configurationName: spec.configurationName,
      executorId: spec.executorId,
      pid: ptyProcess.pid || 0,
      ptyProcess,
      startedAt: new Date().toISOString(),
    };
    this.processes.set(processId, running);

    // 记到 scope 的 OwnedIdsTracker 里 (供跨 scope 反查, 虽然本 scope 自己知道, 但
    // 如果未来有全局 API 需要反查 process 属于哪个 scope, 这个 tracker 是入口)
    this.scope.getService(OWNED_IDS_TRACKER).claim('runProcess', processId);

    const commonFields = {
      processId,
      configurationId: spec.configurationId,
      configurationName: spec.configurationName,
      executorId: spec.executorId,
    };

    // 所有事件直接发给 **本 scope 的 window** —— 不再走 getMainWindow() 的全局 shim
    this.sendEvent('started', {
      ...commonFields,
      pid: ptyProcess.pid || 0,
      command: `${spec.command} ${spec.args.join(' ')}`,
    });

    ptyProcess.onData((data: string) => {
      this.sendEvent('stdout', { ...commonFields, data });
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      this.processes.delete(processId);
      this.scope.getService(OWNED_IDS_TRACKER).release('runProcess', processId);
      this.sendEvent('exit', {
        ...commonFields,
        code: exitCode,
        signal: signal != null ? String(signal) : null,
      });
    });

    return processId;
  }

  /** 停止一个进程 (SIGTERM → 2s 后 SIGKILL 兜底) */
  stop(processId: string): void {
    const running = this.processes.get(processId);
    if (!running) return;
    try {
      running.ptyProcess.kill('SIGTERM');
    } catch {
      /* already dead */
    }
    setTimeout(() => {
      if (this.processes.has(processId)) {
        try {
          running.ptyProcess.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        this.processes.delete(processId);
        this.scope.getService(OWNED_IDS_TRACKER).release('runProcess', processId);
      }
    }, 2000);
  }

  /** 写 stdin (xterm 用户输入转发) */
  writeStdin(processId: string, data: string): void {
    const running = this.processes.get(processId);
    if (!running) return;
    try {
      running.ptyProcess.write(data);
    } catch {
      /* process 已退出 */
    }
  }

  /** Resize pty (xterm fit 后同步) */
  resize(processId: string, cols: number, rows: number): void {
    const running = this.processes.get(processId);
    if (!running) return;
    try {
      running.ptyProcess.resize(Math.max(1, cols), Math.max(1, rows));
    } catch {
      /* ignore */
    }
  }

  /** 拿本 scope 内运行中的所有进程 —— `run-launch:get-running` handler 用 */
  getRunning(): RunningProcessInfo[] {
    return [...this.processes.values()].map((p) => ({
      processId: p.processId,
      configurationId: p.configurationId,
      configurationName: p.configurationName,
      executorId: p.executorId,
      pid: p.pid,
      startedAt: p.startedAt,
    }));
  }

  /** 本 scope 是否拥有这个 processId (事件路由校验用) */
  has(processId: string): boolean {
    return this.processes.has(processId);
  }

  /** ProjectService.dispose: 清掉所有本 scope 的 pty */
  async dispose(): Promise<void> {
    const ids = [...this.processes.keys()];
    for (const id of ids) {
      const running = this.processes.get(id);
      if (!running) continue;
      try {
        running.ptyProcess.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
    this.processes.clear();
  }

  // ═══════════════════════════════════════════════════════════════════
  // Internal
  // ═══════════════════════════════════════════════════════════════════

  private sendEvent(type: string, payload: Record<string, unknown>): void {
    if (this.window.isDestroyed()) return;
    try {
      this.window.webContents.send('run-launch:event', { type, ...payload });
    } catch {
      /* window 可能 closing */
    }
  }
}
