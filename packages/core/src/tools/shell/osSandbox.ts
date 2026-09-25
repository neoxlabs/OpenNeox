
import { execFile } from 'child_process';
import os from 'os';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { isOsSandboxEnabled, getOsSandboxLevel, getOsSandboxMode, isOsSandboxNetworkAllowed, refreshAgentRuntimeConfig } from '@neoxlabs/platform/runtime/agentRuntimeConfig.js';
import { appendDiagLog } from '../../runtime/agent/diagLogFile.js';
import {
  buildSandboxInvocation,
  tierToPolicy,
  probeBackend,
  type SandboxTier,
  type SandboxBackend,
} from '@neoxlabs/sandbox';
import { buildShellInvocation } from './shellInvocation.js';
import { setCurrentSandboxMode, SandboxMode } from '../../runtime/sandboxModeApi.js';
import { loadConfig, saveConfig } from '@neoxlabs/platform/utils/config.js';
import { getActiveSessionScratch } from '../../runtime/shell/sessionScratch.js';
import { getSandboxFloor } from './sandboxFloor.js';

// ==================== 类型定义 (保持向后兼容) ====================

export type SandboxLevel = 'strict' | 'moderate' | 'permissive';

export interface SandboxConfig {
  /** 沙盒级别 —— 现在真正生效 (映射到 tier): strict→只读, moderate→改工作区, permissive→可联网。 */
  level: SandboxLevel;
  /** 允许网络访问 (workspace-write 时 true → 升级 workspace-net)。 */
  allowNetwork: boolean;
  /** 额外允许读取的路径 (新核心默认全读, 保留字段兼容)。 */
  extraReadPaths: string[];
  /** 额外允许写入的路径。 */
  extraWritePaths: string[];
}

export interface SandboxResult {
  sandboxed: boolean;
  type: 'seatbelt' | 'unshare' | 'bwrap' | 'appcontainer' | 'restricted-token' | 'none';
  exitCode: number;
  stdout: string;
  stderr: string;
  /** 若降级, 原因 (上屏)。 */
  degraded?: string;
}

export interface SandboxCapability {
  available: boolean;
  type: 'seatbelt' | 'unshare' | 'bwrap' | 'appcontainer' | 'restricted-token' | 'none';
  reason?: string;
}

const DEFAULT_CONFIG: SandboxConfig = {
  level: 'moderate',
  allowNetwork: false,
  extraReadPaths: [],
  extraWritePaths: [],
};

// ==================== level → tier 映射 ====================

/**
 * 把旧的 level(strict/moderate/permissive) + allowNetwork 映射成新核心的 tier。
 * (向后兼容旧 config; 现役 tier 走 modeToTier, 见下。)
 */
export function levelToTier(level: SandboxLevel, allowNetwork: boolean): SandboxTier {
  if (level === 'strict') return 'read-only';
  if (level === 'permissive') return 'workspace-net';
  // moderate: 改工作区; 若显式放网 → workspace-net
  return allowNetwork ? 'workspace-net' : 'workspace-write';
}

export function modeToTier(mode: SandboxMode, allowNetwork: boolean): SandboxTier {
  switch (mode) {
    case SandboxMode.READ_ONLY:
      return 'read-only';
    case SandboxMode.DANGER_FULL_ACCESS:
      return 'trusted';
    case SandboxMode.WORKSPACE_WRITE:
    default:
      return allowNetwork ? 'workspace-net' : 'workspace-write';
  }
}

// ==================== 能力检测 ====================

/** 检测当前平台的沙盒能力 (委托给核心 probeBackend)。 */
export async function detectSandboxCapability(): Promise<SandboxCapability> {
  const probe = probeBackend();
  const type = probe.backend as SandboxCapability['type'];
  return { available: probe.available, type, reason: probe.reason };
}

// ==================== 沙盒执行 ====================

export async function executeInSandbox(
  command: string,
  workDir: string,
  config: Partial<SandboxConfig> = {},
  options: {
    timeoutMs?: number;
    signal?: AbortSignal;
    env?: Record<string, string>;
    shell?: string;
  } = {},
): Promise<SandboxResult> {
  const fullConfig = { ...DEFAULT_CONFIG, ...config };
  const tier = levelToTier(fullConfig.level, fullConfig.allowNetwork);

  const policy = tierToPolicy(tier, {
    workspaceRoot: workDir,
    home: os.homedir(),
    tmpDir: getActiveSessionScratch(),
    extraWriteRoots: fullConfig.extraWritePaths,
  });

  const invocation = buildSandboxInvocation(
    policy,
    { command, cwd: workDir, shell: options.shell },
    { logger: (lvl, msg) => cliLogger[lvl === 'debug' ? 'info' : lvl]('SANDBOX', msg) },
  );

  if (invocation.degraded) {
    cliLogger.warn('SANDBOX', `沙盒降级: ${invocation.degraded}`);
  }

  try {
    const result = await execInChild(invocation.program, invocation.args, workDir, options);
    const backend = invocation.backend as SandboxBackend;
    return {
      sandboxed: backend !== 'none',
      type: backend === 'none' ? 'none' : (backend as SandboxResult['type']),
      degraded: invocation.degraded,
      ...result,
    };
  } finally {
    invocation.cleanup();
  }
}

// ==================== 底层执行 ====================

function execInChild(
  cmd: string,
  args: string[],
  cwd: string,
  options: {
    timeoutMs?: number;
    signal?: AbortSignal;
    env?: Record<string, string>;
  },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, {
      cwd,
      env: { ...process.env, ...options.env } as Record<string, string>,
      timeout: options.timeoutMs ?? 120_000,
      maxBuffer: 10 * 1024 * 1024, // 10MB
      shell: false,
    }, (error, stdout, stderr) => {
      const exitCode = error ? (error as any).code ?? 1 : 0;
      resolve({
        exitCode: typeof exitCode === 'number' ? exitCode : 1,
        stdout: stdout || '',
        stderr: stderr || '',
      });
    });

    if (options.signal) {
      const onAbort = () => {
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 3000);
      };
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
    }
  });
}

// ==================== 集成入口 ====================

export function shouldUseOsSandbox(): boolean {
  const mode = getOsSandboxMode();
  const floor = getSandboxFloor();
  const enabled = isOsSandboxEnabled();
  appendDiagLog('OS_SANDBOX_GATE', {
    pid: typeof process !== 'undefined' ? process.pid : null,
    mode, floor, enabled,
    envOs: process.env.NEOX_OS_SANDBOX ?? null,
    envLegacy: process.env.NEOX_SANDBOX ?? null,
  });
  if (mode === 'danger-full-access') return false; // danger = 不沙盒
  if (floor) return true;                          // 模式地板: 强制 OS 强制
  return enabled;
}

/** 获取沙盒配置 (从 env + config)。 */
export function getSandboxConfig(): SandboxConfig {
  return {
    level: getOsSandboxLevel() as SandboxLevel,
    allowNetwork: isOsSandboxNetworkAllowed(),
    extraReadPaths: (process.env.NEOX_SANDBOX_EXTRA_READ || '').split(':').filter(Boolean),
    extraWritePaths: (process.env.NEOX_SANDBOX_EXTRA_WRITE || '').split(':').filter(Boolean),
  };
}

/** 当前生效的 tier —— 从 config 的 SandboxMode(单一真源) + 网络偏好推导。 */
export function getCurrentSandboxTier(): SandboxTier {
  return modeToTier(getOsSandboxMode() as SandboxMode, isOsSandboxNetworkAllowed());
}

/**
 * 把 config 的 OS 沙箱档同步到 kernel SandboxMode 单例 (工具类别门禁读它)。
 * 在会话启动时调 → OS 强制 与 工具门禁 用同一个档, 不再各说各话。
 */
export function syncSandboxModeFromConfig(): void {
  const mode = isOsSandboxEnabled() ? getOsSandboxMode() : SandboxMode.WORKSPACE_WRITE;
  setCurrentSandboxMode(mode as SandboxMode);
}

/**
 * 持久化 OS 沙箱选择到 config —— CLI `neox sandbox <mode>` / 程序化设置用。
 * 让选档存盘 + 跨进程生效 (桌面走 configService, 这里给 CLI 用同一份 config)。
 * enable 默认按 mode 推导: danger→关 OS 强制, 其余→开。
 */
export function persistOsSandboxSelection(
  mode: 'read-only' | 'workspace-write' | 'danger-full-access',
  opts: { enable?: boolean } = {},
): void {
  const cfg = loadConfig();
  const rt = (cfg.agentRuntime = cfg.agentRuntime ?? {});
  const enable = opts.enable ?? (mode !== 'danger-full-access');
  rt.osSandbox = { ...(rt.osSandbox ?? {}), mode, enabled: enable };
  saveConfig(cfg);
  // 同进程内让 config cache + kernel 单例立即反映
  refreshAgentRuntimeConfig();
  setCurrentSandboxMode(mode as SandboxMode);
}

// ==================== spawn 规格 (供 PTY / 后台 / 流式路径复用) ====================

export interface MaybeSandboxedInvocation {
  /** 直接喂 node-pty.spawn / execa 的程序。 */
  cmd: string;
  args: string[];
  /** win32 cmd 分支透传 (见 ShellInvocation.windowsVerbatimArgs —— 让 execa 引号原样交 cmd)。 */
  windowsVerbatimArgs?: boolean;
  /** 是否真被沙盒包裹 (false = 普通 shell 直跑, 与旧行为完全一致)。 */
  sandboxed: boolean;
  backend: SandboxBackend | 'none';
  degraded?: string;
  /** 进程退出后调 —— 删临时 profile (未沙盒时为 noop)。 */
  cleanup(): void;
}

/**
 * 把 (command + cwd) 编译成可直接 spawn 的规格 —— 沙盒开则包裹, 关则返回原生 shell 调用。
 *
 * 关键: 这条路径**不缓冲** (不走 execFile), 调用方自己用 node-pty/execa spawn 保留流式。
 * 让 PTY / 后台 / 交互 三条原本绕过沙盒的路径也能被沙盒约束 (堵住"挂后台即逃逸")。
 */
export function buildMaybeSandboxedInvocation(command: string, cwd: string): MaybeSandboxedInvocation {
  if (!shouldUseOsSandbox()) {
    const inv = buildShellInvocation(command);
    return { cmd: inv.cmd, args: inv.args, windowsVerbatimArgs: inv.windowsVerbatimArgs, sandboxed: false, backend: 'none', cleanup: () => {} };
  }
  const cfg = getSandboxConfig();
  const tier = getCurrentSandboxTier(); // 单一真源: SandboxMode → tier
  const policy = tierToPolicy(tier, {
    workspaceRoot: cwd,
    home: os.homedir(),
    tmpDir: getActiveSessionScratch(),
    extraWriteRoots: cfg.extraWritePaths,
  });
  const inv = buildSandboxInvocation(
    policy,
    { command, cwd },
    { logger: (lvl, msg) => cliLogger[lvl === 'debug' ? 'info' : lvl]('SANDBOX', msg) },
  );
  return {
    cmd: inv.program,
    args: inv.args,
    sandboxed: inv.backend !== 'none',
    backend: inv.backend,
    degraded: inv.degraded,
    cleanup: inv.cleanup,
  };
}
