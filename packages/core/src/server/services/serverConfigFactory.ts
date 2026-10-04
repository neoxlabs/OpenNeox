import type { NeoxServerConfig } from '../index.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

interface BuildServerConfigOptions {
  workDir: string;
  port: number;
  remoteConfig: any;
  /** Bearer token (强制启用; 本地与远程均要求). */
  authToken: string;
}

/**
 * 构造 server 配置. Auth 现在是**强制**的:
 * - allowLocalWithoutAuth:false → 本机其他进程 curl 也会被 401 拒绝
 * - rateLimit / CORS 仍只在 remote 模式下激活, 本地进程一律不放
 */
export function buildServerConfig(options: BuildServerConfigOptions): NeoxServerConfig {
  const { workDir, port, remoteConfig, authToken } = options;
  const serverConfig: NeoxServerConfig = {
    workDir,
    port,
    auth: {
      token: authToken,
      allowLocalWithoutAuth: false,
    },
  };

  if (remoteConfig.enabled) {
    serverConfig.rateLimit = { maxRequests: 120, windowMs: 60_000 };
    serverConfig.corsOrigins = ['*'];
    cliLogger.info('SERVER', 'Remote mode enabled — rateLimit + CORS active');
  }

  cliLogger.info('SERVER', 'AuthGate enabled (token required for all non-public routes)');
  return serverConfig;
}

export function resolveServerHostname(remoteConfig: any): string {
  return process.env.NEOX_HOST
    || (remoteConfig.enabled ? (remoteConfig.host || '0.0.0.0') : '127.0.0.1');
}
