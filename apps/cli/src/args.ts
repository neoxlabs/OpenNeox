/**
 * CLI 参数解析
 *
 * 支持会话恢复等参数
 */

import { getCliEdition } from './edition/index.js';

export interface CLIArgs {
  /** 继续最近的会话 */
  continue: boolean;
  /** 恢复指定会话（true = 显示选择器，string = 会话 ID） */
  resume: string | boolean;
  /** 指定模型 */
  model?: string;
  /** 指定 Provider */
  provider?: string;
  /** 工作目录 */
  workDir?: string;
  /** 显示帮助 */
  help: boolean;
  /** 显示版本 */
  version: boolean;
  /** 禁用会话持久化 */
  noSession: boolean;
  /** 启用调试日志 */
  debug?: boolean;
  /** 调试日志同时输出到控制台 */
  debugConsole?: boolean;
  /** 结构化输出 schema 路径 */
  outputSchema?: string;
  /** print/一次性模式允许 mutation 工具 (--yolo / --dangerously-skip-permissions) */
  yolo?: boolean;
  json?: boolean;
  /** print/一次性模式超时秒数 (--timeout <seconds>) */
  timeoutSeconds?: number;
  /** 未知参数（用于错误提示） */
  unknownArgs?: string[];
  /** 位置参数（如 update 命令） */
  _: string[];
}

export function parseArgs(argv: string[] = process.argv): CLIArgs {
  const args: CLIArgs = {
    continue: false,
    resume: false,
    help: false,
    version: false,
    noSession: false,
    _: [],
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];

    switch (arg) {
      case '-c':
      case '--continue':
        args.continue = true;
        break;

      case '-r':
      case '--resume':
        // 检查下一个参数是否是 session ID（不以 - 开头）
        const nextArg = argv[i + 1];
        if (nextArg && !nextArg.startsWith('-')) {
          args.resume = nextArg;
          i++;
        } else {
          args.resume = true; // 显示选择器
        }
        break;

      case '-m':
      case '--model':
        if (argv[i + 1]) {
          args.model = argv[++i];
        }
        break;

      case '--provider':
        if (argv[i + 1]) {
          args.provider = argv[++i];
        }
        break;

      case '-d':
      case '--dir':
      case '--workdir':
        if (argv[i + 1]) {
          args.workDir = argv[++i];
        }
        break;

      case '-h':
      case '--help':
      case '-help':
        args.help = true;
        break;

      case '-v':
      case '-V':
      case '--version':
      case '-version':
        args.version = true;
        break;

      case '--no-session':
        args.noSession = true;
        break;

      case '--debug':
        args.debug = true;
        break;

      case '--debug-console':
        args.debug = true;
        args.debugConsole = true;
        break;

      case '--output-schema':
        if (argv[i + 1]) {
          args.outputSchema = argv[++i];
        }
        break;

      case '--yolo':
      case '--dangerously-skip-permissions':
        args.yolo = true;
        break;

      case '--json':
        args.json = true;
        break;

      case '--timeout':
        if (argv[i + 1]) {
          const secs = Number(argv[++i]);
          if (Number.isFinite(secs) && secs > 0) args.timeoutSeconds = secs;
        }
        break;

      default:
        // 检测未知的 - 或 -- 开头的参数
        if (arg.startsWith('-')) {
          if (!args.unknownArgs) {
            args.unknownArgs = [];
          }
          args.unknownArgs.push(arg);
        } else {
          args._.push(arg);
        }
        break;
    }
  }

  return args;
}

/**
 * 显示帮助信息
 */
/** `neox --help` 子命令段的共享行; 账号类 (login / whoami / usage ...) 由发行版插槽按 helpBefore 插入 */
const SUBCOMMAND_HELP_ROWS: ReadonlyArray<{ id: string; line: string }> = [
  { id: 'provider', line: '  provider <ls|add|test> Provider 管理 (Manage providers)' },
  { id: 'model', line: '  model ls               列出可用模型 (List models)' },
  { id: 'skill', line: '  skill <subcommand>     技能管理 (Skill management)' },
  { id: 'mcp', line: '  mcp <subcommand>       MCP server 管理 (MCP management)' },
  { id: 'browser', line: '  browser <ls|replay>    浏览器录制回放 · replay --all = 回归测试 (Replay recorded browser scripts)' },
  { id: 'daemon', line: '  daemon <subcommand>    后台守护进程 (Background daemon)' },
  { id: 'update', line: '  update                 检查并安装更新 (Check & install updates)' },
  { id: 'uninstall', line: '  uninstall              清理本地数据 (Clean local data)' },
];

function subcommandHelpLines(): string[] {
  const lines = SUBCOMMAND_HELP_ROWS.map((r) => ({ id: r.id as string | null, line: r.line }));
  for (const cmd of getCliEdition().subcommands) {
    if (!cmd.helpLine) continue;
    const at = cmd.helpBefore ? lines.findIndex((l) => l.id === cmd.helpBefore) : -1;
    const row = { id: null, line: cmd.helpLine };
    if (at >= 0) lines.splice(at, 0, row);
    else lines.push(row);
  }
  return lines.map((l) => l.line);
}

function helpFooter(): string {
  const footer = getCliEdition().helpFooterLines;
  return footer.length > 0 ? `\n更多信息 (More Info):\n${footer.join('\n')}\n` : '';
}

export function showHelp(version: string): void {
  console.log(`
Neox CLI - AI 代码助手 (AI Code Assistant) v${version}

用法 (Usage): neox [options] ["prompt"]

会话选项 (Session Options):
  -c, --continue         继续最近的会话 (Continue most recent session)
  -r, --resume [id]      恢复会话 (Resume session - shows selector if no ID)
  --no-session           禁用会话持久化 (Disable session persistence)

通用选项 (General Options):
  -p, --print            非交互模式: 执行 prompt 并打印结果 (Non-interactive print mode)
  --json                 print 模式输出单个 JSON 对象 (JSON output in print mode)
  --yolo                 print 模式允许写文件/执行命令 (Allow mutations in print mode)
  --timeout <seconds>    print 模式超时秒数, 默认 300 (Print mode timeout, default 300s)
  -m, --model <model>    指定模型 (Specify model)
  --provider <id>        指定提供商 (Specify provider)
  -d, --dir <path>       工作目录 (Working directory)
  --debug                启用调试日志 (Enable debug logging)
  --debug-console        调试日志输出到控制台 (Debug logs to console)
  --output-schema <path> 指定 JSON Schema 文件，用于结构化输出 (Structured output schema)
  -h, --help             显示帮助 (Show help)
  -v, --version          显示版本 (Show version)

子命令 (Subcommands):
${subcommandHelpLines().join('\n')}

会话命令 (Session Commands in REPL):
  /session <ls|new|info|export|clear>  会话管理 (Manage sessions; 别名 /sessions = /session ls)
  /checkpoint            检查点管理菜单 (Checkpoint menu)
  /checkpoint create [name]   创建检查点 (Create checkpoint)
  /checkpoint enable|disable  开关文件快照 (Toggle file snapshots)
  /rollback <id>         回滚到检查点 (Rollback to checkpoint)

示例 (Examples):
  neox                    启动交互会话 (Start interactive session)
  neox "解释这段代码"      一次性执行 prompt 并输出 (One-shot prompt, same as -p)
  neox -p "解释这段代码"   非交互查询, 输出后退出 (One-shot query)
  neox -c                 继续上次会话 (Continue last session)
  neox provider ls        列出已配置 provider (List providers)
${helpFooter()}`);
}

/**
 * 显示版本信息
 */
export function showVersion(version: string): void {
  console.log(`Neox CLI v${version}`);
}
