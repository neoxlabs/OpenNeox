import * as path from 'path';
import chalk from 'chalk';
import { showHelp, showVersion, type CLIArgs } from '../args.js';
import { handleMcpCliCommand } from '../commands/index.js';
import { cliErrorln } from '../utils/output.js';
import { findCliSubcommand } from '../edition/index.js';

export async function handleEarlyCliSubcommands(rawArgs: string[]): Promise<number | null> {
  if (rawArgs[0] === 'mcp') {
    const workDir = path.resolve(process.cwd());
    const exitCode = await handleMcpCliCommand(rawArgs.slice(1), { workDir });
    return exitCode;
  }

  if (rawArgs[0] === 'daemon') {
    const { handleDaemonCommand } = await import('../commands/daemon.js');
    const code = await handleDaemonCommand(rawArgs.slice(1));
    return typeof code === 'number' ? code : 0;
  }

  if (rawArgs[0] === 'provider' || rawArgs[0] === 'providers') {
    const { handleProviderCliCommand } = await import('../commands/provider-cmd.js');
    return await handleProviderCliCommand(rawArgs.slice(1));
  }

  /* neox migrate —— 从 Claude Code / Codex / Cursor 搬技能 + MCP。
   * 放在 early 分发: 它不需要 runtime / provider, 扫完打印就 exit。
   * 入口必须在这里而不是只藏在桌面端设置里 —— 迁移用户装完第一件事就是找它。 */
  if (rawArgs[0] === 'migrate') {
    const { handleMigrateCommand } = await import('../commands/migrate-cmd.js');
    return await handleMigrateCommand(rawArgs.slice(1));
  }

  if (rawArgs[0] === 'browser') {
    const { handleBrowserCliCommand } = await import('../commands/browser-cmd.js');
    return await handleBrowserCliCommand(rawArgs.slice(1));
  }

  /* K4-MVP: neox skill <install|update|uninstall|list|trust|untrust> */
  if (rawArgs[0] === 'skill' || rawArgs[0] === 'skills') {
    const { handleSkillCliCommand } = await import('../commands/skill-cmd.js');
    return await handleSkillCliCommand(rawArgs.slice(1));
  }

  const editionCommand = rawArgs[0] ? findCliSubcommand(rawArgs[0]) : undefined;
  if (editionCommand) {
    return await editionCommand.run(rawArgs.slice(1));
  }
  if (rawArgs[0] === 'uninstall') {
    const { handleUninstallCommand } = await import('../commands/uninstall.js');
    return await handleUninstallCommand(rawArgs.slice(1));
  }
  /* model 列表 (subcommand) — 跟现有 REPL slash /model 不冲突 (那个走另一条路径) */
  if (rawArgs[0] === 'model' || rawArgs[0] === 'models') {
    const { handleModelCliCommand } = await import('../commands/models-cmd.js');
    return await handleModelCliCommand(rawArgs.slice(1));
  }
  /* agent 吞吐 / 去重埋点看板 — 跟 usage(订阅额度) 分开: 那个是"花了多少钱",
   * 这个是"agent 干活效率" (工具调用 / 读去重 / 搜索去重命中率)。
   * 存在的理由见 agent-metrics-cmd.ts 文件头: 埋点一直在落, 但 DB 按宿主分家, 没人查得到。 */
  /* 会话回放 (审计) —— 跟 metrics 同一类命令: 数据一直在落, 但没人查得到。
   * metrics 回答"效率如何", audit 回答"那一次到底干了什么"。 */
  if (rawArgs[0] === 'audit' || rawArgs[0] === 'replay') {
    const { handleAuditCommand } = await import('../commands/audit-cmd.js');
    return await handleAuditCommand(rawArgs.slice(1));
  }
  if (rawArgs[0] === 'metrics') {
    const { handleAgentMetricsCommand } = await import('../commands/agent-metrics-cmd.js');
    return await handleAgentMetricsCommand(rawArgs.slice(1));
  }
  if (rawArgs[0] === 'update') {
    if (rawArgs[1] === '--help' || rawArgs[1] === '-h' || rawArgs[1] === 'help') {
      console.log('Usage: neox update');
      console.log('');
      console.log('  检查新版本, 发现后自动下载安装 (Check for a new version and install it).');
      console.log('  更新源: dl.neox-dev.com → npm registry fallback');
      console.log('  禁用启动时自动检查: REPL 内 /update → Auto check OFF,');
      console.log('  或设置环境变量 NEOX_DISABLE_AUTO_UPDATE_CHECK=1');
      return 0;
    }
    const { handleUpdateCommand } = await import('../commands/update-cmd.js');
    return await handleUpdateCommand();
  }

  return null;
}

export async function handleEarlyProcessArgs(args: CLIArgs, cliVersion: string): Promise<number | null> {
  if (args.unknownArgs && args.unknownArgs.length > 0) {
    cliErrorln(chalk.red(`错误: 不支持的参数: ${args.unknownArgs.join(', ')}`));
    cliErrorln(chalk.yellow(`使用 'neox --help' 查看支持的参数列表`));
    return 1;
  }

  if (args.help) {
    showHelp(cliVersion);
    return 0;
  }

  if (args.version) {
    showVersion(cliVersion);
    return 0;
  }

  return null;
}
