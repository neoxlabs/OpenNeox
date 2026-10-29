
import { installCrashReporter } from '@neoxlabs/platform/platform/crashReport/index.js';
import { loadConfig } from '@neoxlabs/platform/utils/config.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { CLI_VERSION } from '../constants.js';

let installed = false;

/** 装 CLI 崩溃上报器 (幂等)。任何失败都吞掉 —— 上报装不上绝不能挡住 CLI 启动。 */
export function installCliCrashReporting(): void {
  if (installed) return;
  installed = true;
  try {
    const reporter = installCrashReporter({
      app: 'cli',
      process: 'main',
      version: CLI_VERSION,
      workspaceDir: process.cwd(),
      /* 设置页里的「发送崩溃报告」开关; env / 测试实例的闸在 isCrashReportEnabled 里另算 */
      isEnabled: () => {
        try { return loadConfig().crashReports !== false; } catch { return true; }
      },
    });
    void reporter.runStartupRecovery();
  } catch (error) {
    try {
      cliLogger.warn('CRASH_REPORT', `崩溃上报器安装失败 (不影响运行): ${(error as Error)?.message ?? error}`);
    } catch {
      /* 连 logger 都还没起来 —— 静默 */
    }
  }
}
