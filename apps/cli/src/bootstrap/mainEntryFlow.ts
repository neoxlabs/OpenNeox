import { profileCheckpoint } from '@neoxlabs/platform/utils/startup/profiler.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import type { CLIArgs } from '../args.js';
import { getCliEdition } from '../edition/index.js';

const KNOWN_SUBCOMMANDS = [
  'mcp', 'daemon', 'skill', 'skills', 'login', 'logout', 'uninstall', 'whoami',
  'device', 'devices', 'upgrade', 'plan', 'model', 'models', 'usage', 'quota',
  'update', 'provider', 'providers', 'browser',
];
/** 表里属于发行版插槽的那些 —— 发行版没注册就不参与联想 */
const EDITION_SUBCOMMANDS = new Set([
  'login', 'logout', 'whoami', 'device', 'devices', 'upgrade', 'plan', 'usage', 'quota',
]);

function knownSubcommands(): string[] {
  const provided = new Set(getCliEdition().subcommands.flatMap((c) => c.names));
  const base = KNOWN_SUBCOMMANDS.filter((c) => !EDITION_SUBCOMMANDS.has(c) || provided.has(c));
  return [...base, ...[...provided].filter((c) => !KNOWN_SUBCOMMANDS.includes(c))];
}

/* exported: main.ts 未知 slash 命令的 did-you-mean 建议也用它 */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[n];
}

function suggestCommand(token: string): string | null {
  /* 只对"长得像命令"的单 token 提示 (小写字母开头, 无空格无 CJK) */
  if (!/^[a-z][a-z0-9_-]{1,15}$/.test(token)) return null;
  let best: string | null = null;
  let bestDist = Infinity;
  for (const cmd of knownSubcommands()) {
    const d = levenshtein(token, cmd);
    if (d < bestDist) { bestDist = d; best = cmd; }
  }
  return bestDist > 0 && bestDist <= 2 ? best : null;
}

async function applyEarlyAuthContext(): Promise<void> {
  try {
    /* 账号插槽 (商业版读 ~/.neox/auth.enc; 公开版没有账号 → null) */
    const userId = getCliEdition().account?.currentUserId() ?? null;
    const cfg = await import('@neoxlabs/platform/utils/config.js' as any);

    if (userId) {
      cfg.setCurrentUserId(userId);
      cliLogger.debug('BOOT', `applyEarlyAuthContext: setCurrentUserId=${userId}`);
    }

    const dbEarly = await import('@neoxlabs/platform/platform/database.js' as any);
    const lite = dbEarly.migrateLiteHomeToStandard();
    if (!lite.skipped) {
      cliLogger.info('BOOT', `lite-home merge: ${lite.files} file(s) → ~/.neox`);
    }
    const result = cfg.migratePerUserBucketsToGlobal();
    if (result.migratedProviders > 0) {
      cliLogger.info('BOOT', `migrated ${result.migratedProviders} BYOK providers from ${result.scannedBuckets} per-user bucket(s) → global (one-time)`);
    }
    const db = await import('@neoxlabs/platform/platform/database.js' as any);
    const dbResult = db.migratePerUserDbToGlobal();
    if (dbResult.dbFiles > 0 || dbResult.failedDbFiles > 0) {
      cliLogger.info('BOOT', `merged ${dbResult.dbFiles} per-user db file(s) → global (${dbResult.sessions} new sessions, ${dbResult.failedDbFiles} failed)`);
    }
  } catch (err: any) {
    cliLogger.debug('BOOT', `applyEarlyAuthContext skipped: ${err?.message ?? err}`);
  }
}

export async function runCliMainEntryFlow(params: {
  cliVersion: string;
  parseArgs: () => CLIArgs;
  handleEarlyCliSubcommands: (rawArgs: string[]) => Promise<number | null>;
  handleEarlyProcessArgs: (args: CLIArgs, cliVersion: string) => Promise<number | null>;
  runProviderSetupFlowIfNeeded: () => Promise<void>;
  ensureProviderConfigured: () => Promise<void>;
  createCli: (args: CLIArgs) => { init: () => Promise<void>; runInteractive: () => Promise<void> };
  setActiveCliInstance: (cli: any) => void;
}): Promise<{ exitCode?: number }> {
  const rawArgs = process.argv.slice(2);
  const earlySubcommandExitCode = await params.handleEarlyCliSubcommands(rawArgs);
  if (earlySubcommandExitCode !== null) {
    return { exitCode: earlySubcommandExitCode };
  }

  const args = params.parseArgs();

  if (args.debug) {
    process.env.CLI_DEBUG = '1';
  }
  if (args.debug || args.debugConsole) {
    process.env.CLI_DEBUG_CONSOLE = '1';
  }

  cliLogger.setEnabled(process.env.CLI_DEBUG === '1' || process.env.CLI_DEBUG_CONSOLE === '1');

  cliLogger.info('CLI', 'Arguments parsed', {
    model: args.model,
    provider: args.provider,
    workDir: args.workDir,
    debug: process.env.CLI_DEBUG === '1',
    debugConsole: process.env.CLI_DEBUG_CONSOLE === '1',
  });

  const earlyArgsExitCode = await params.handleEarlyProcessArgs(args, params.cliVersion);
  if (earlyArgsExitCode !== null) {
    return { exitCode: earlyArgsExitCode };
  }

  /* 位置参数: did-you-mean 或一次性 prompt (见文件头注释)
   * (update 已在 handleEarlyCliSubcommands 处理, 不再需要在这儿过滤) */
  const positional = args._.filter((t) => t);
  if (positional.length > 0) {
    if (positional.length === 1) {
      const suggestion = suggestCommand(positional[0]);
      if (suggestion) {
        process.stderr.write(`Error: unknown command "${positional[0]}"\n`);
        process.stderr.write(`  Did you mean: neox ${suggestion} ?\n`);
        return { exitCode: 1 };
      }
    }
    const prompt = positional.join(' ');
    cliLogger.info('CLI', `positional prompt → one-shot print mode: "${prompt.slice(0, 60)}"`);
    const { runPrintMode } = await import('./printMode.js');
    const exitCode = await runPrintMode({
      prompt,
      model: args.model,
      provider: args.provider,
      workDir: args.workDir,
      yolo: args.yolo,
      json: args.json,
      timeoutSeconds: args.timeoutSeconds,
    });
    return { exitCode };
  }

  try {
    cliLogger.debug('BOOT', 'main() try block entered');
    /* 配置桶提早对齐 — 防 runProviderSetupFlowIfNeeded 读到 anonymous 误判 setup 没完 */
    await applyEarlyAuthContext();
  profileCheckpoint('entry_auth_ctx_done');
    await params.runProviderSetupFlowIfNeeded();
  profileCheckpoint('entry_provider_setup_done');
    cliLogger.debug('BOOT', 'ensureProviderConfigured...');
    await params.ensureProviderConfigured();
  profileCheckpoint('entry_provider_configured_done');

    cliLogger.debug('BOOT', 'creating NeoxCLI...');
    const cli = params.createCli(args);
    params.setActiveCliInstance(cli);
    cliLogger.debug('BOOT', 'cli.init()...');
    await cli.init();
  profileCheckpoint('entry_cli_init_done');
    cliLogger.debug('BOOT', 'cli.init() done, runInteractive()...');
    cliLogger.info('CLI', 'CLI initialized successfully');
    await cli.runInteractive();
    return {};
  } catch (error: any) {
    cliLogger.error('BOOT', `FATAL: ${error.message}`, { stack: error.stack });
    cliLogger.error('CLI', 'Fatal error in main', {
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}
