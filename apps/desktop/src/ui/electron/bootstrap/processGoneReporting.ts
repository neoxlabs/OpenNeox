
import type {
  CrashProcessRole,
  CrashReporter,
} from '@neoxlabs/platform/platform/crashReport/index.js';

/** Electron 给的 gone 原因 (render-process-gone 与 child-process-gone 共用) */
export type ProcessGoneReason =
  | 'clean-exit'
  | 'abnormal-exit'
  | 'killed'
  | 'crashed'
  | 'oom'
  | 'launch-failed'
  | 'integrity-failure'
  | 'memory-eviction';

export interface RenderProcessGoneLike {
  reason: ProcessGoneReason;
  exitCode: number;
}

export type ChildProcessType =
  | 'Utility'
  | 'Zygote'
  | 'Sandbox helper'
  | 'GPU'
  | 'Pepper Plugin'
  | 'Pepper Plugin Broker'
  | 'Unknown';

export interface ChildProcessGoneLike {
  type: ChildProcessType;
  reason: ProcessGoneReason;
  exitCode: number;
  serviceName?: string;
  name?: string;
}

/** 归一后要上报的那一条 (就是 reportNative 的参数)。 */
export interface ProcessGoneCrash {
  message: string;
  exitCode: number;
  role: CrashProcessRole;
}

/** 渲染进程崩溃 → 上报描述; clean-exit (关窗 / reload) 返回 null。 */
export function describeRenderProcessGone(details: RenderProcessGoneLike): ProcessGoneCrash | null {
  if (!details || details.reason === 'clean-exit') return null;
  return {
    role: 'renderer',
    exitCode: details.exitCode,
    message: `桌面渲染进程异常退出: reason=${details.reason}, exitCode=${details.exitCode}`,
  };
}

/** GPU / Utility 进程崩溃 → 上报描述; 其它进程类型与 clean-exit 返回 null。 */
export function describeChildProcessGone(details: ChildProcessGoneLike): ProcessGoneCrash | null {
  if (!details || details.reason === 'clean-exit') return null;
  const label = details.type === 'GPU' ? 'GPU' : details.type === 'Utility' ? 'Utility' : null;
  if (!label) return null;
  const role: CrashProcessRole = details.type === 'GPU' ? 'gpu' : 'utility';
  const name = details.name || details.serviceName;
  return {
    role,
    exitCode: details.exitCode,
    message: `${label} 进程异常退出${name ? ` (${name})` : ''}: reason=${details.reason}, exitCode=${details.exitCode}`,
  };
}

/** 只依赖 Electron app 的 on —— 测试用假对象即可。 */
export interface GoneEventSource {
  on(event: string, listener: (...args: any[]) => void): unknown;
}

/**
 * 挂上两个 app 级事件并上报。幂等由调用方保证 (只在 main 里装一次)。
 * 任何失败都吞掉 —— 上报装不上绝不能挡住应用启动。
 */
export function installProcessGoneReporting(
  app: GoneEventSource,
  reporter: Pick<CrashReporter, 'reportNative'>,
  logger: Pick<Console, 'error'> = console,
): void {
  try {
    app.on('render-process-gone', (_event: unknown, _webContents: unknown, details: RenderProcessGoneLike) => {
      const crash = describeRenderProcessGone(details);
      if (!crash) return;
      try { reporter.reportNative(crash); } catch { /* 上报失败不影响窗口处理 */ }
      try { logger.error(`[crash-report] ${crash.message}`); } catch { /* ignore */ }
    });
    app.on('child-process-gone', (_event: unknown, details: ChildProcessGoneLike) => {
      const crash = describeChildProcessGone(details);
      if (!crash) return;
      try { reporter.reportNative(crash); } catch { /* 上报失败不影响进程处理 */ }
      try { logger.error(`[crash-report] ${crash.message}`); } catch { /* ignore */ }
    });
  } catch {
    /* 装不上不影响应用启动 */
  }
}
