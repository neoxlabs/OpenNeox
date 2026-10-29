/**
 * Platform service contracts for runtime/tools.
 */

import type { ProcessManager } from './processManager.js';
import type { ShellEnvPreloadOptions } from './shellEnv.js';
import type { ToolCapabilitySet } from '@neoxlabs/kernel/types/index.js';
import type { TokenUsageService } from './tokenUsageService.js';

export interface PlatformLogger {
  debug: (tag: string, message: string, data?: any) => void;
  info: (tag: string, message: string, data?: any) => void;
  warn: (tag: string, message: string, data?: any) => void;
  error: (tag: string, message: string, data?: any) => void;
  log: (tag: string, ...args: any[]) => void;
}

export interface ShellEnvService {
  preloadShellEnv: (options?: ShellEnvPreloadOptions) => Promise<void>;
  getShellEnv: () => Record<string, string>;
}

export interface PlatformServices {
  logger: PlatformLogger;
  shellEnv: ShellEnvService;
  processManager: ProcessManager;
  capabilities?: ToolCapabilitySet;
  tokenUsage?: TokenUsageService;
}
