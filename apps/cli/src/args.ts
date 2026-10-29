/**
 * CLI 参数解析
 *
 * 支持会话恢复等参数
 */

import { getCliEdition } from './edition/index.js';
import { L } from './i18n/index.js';

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
  /** CLI-11: print 模式输出格式 (--output-format text|json)。text = 纯文本无 ANSI; json 等价 --json。
   *  不给时按 stdout 是否 TTY 决定 (管道 / 重定向 / CI 一律纯文本)。 */
  outputFormat?: 'text' | 'json';
  keepOrphans?: boolean;
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

      case '--lean':
        /* 极简模式 (core runtime/prompts/lean.ts) —— 只作用于本进程, 不写配置 */
        process.env.NEOX_CONTEXT_PROFILE = 'lean';
        break;

      case '--json':
        args.json = true;
        break;

      case '--output-format': {
        /* CLI-11: 与 print 快路径 (parsePrintArgs) 同一套取值, 两条路不能各认一套 */
        const fmt = (argv[i + 1] ?? '').trim().toLowerCase();
        if (fmt === 'text' || fmt === 'plain') {
          args.outputFormat = 'text';
          i++;
        } else if (fmt === 'json') {
          args.outputFormat = 'json';
          args.json = true;
          i++;
        }
        break;
      }

      case '--keep-orphans':
        args.keepOrphans = true;
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
/* 帮助按界面语言只出一种 —— 原来每行「中文 (English)」两种语言挤在一起 */
const subcommandHelpRows = (): ReadonlyArray<{ id: string; line: string }> => [
  { id: 'provider', line: L('  provider <ls|add|test> Provider 管理', '  provider <ls|add|test> Manage providers') },
  { id: 'model', line: L('  model ls               列出可用模型', '  model ls               List models') },
  { id: 'skill', line: L('  skill <subcommand>     技能管理', '  skill <subcommand>     Manage skills') },
  { id: 'mcp', line: L('  mcp <subcommand>       MCP server 管理', '  mcp <subcommand>       Manage MCP servers') },
  { id: 'browser', line: L('  browser <ls|replay>    浏览器录制回放 · replay --all = 回归测试', '  browser <ls|replay>    Replay recorded browser scripts · replay --all = regression run') },
  { id: 'daemon', line: L('  daemon <subcommand>    后台守护进程', '  daemon <subcommand>    Background daemon') },
  { id: 'update', line: L('  update                 检查并安装更新', '  update                 Check for and install updates') },
  { id: 'uninstall', line: L('  uninstall              清理本地数据', '  uninstall              Remove local data') },
];

function subcommandHelpLines(): string[] {
  const lines = subcommandHelpRows().map((r) => ({ id: r.id as string | null, line: r.line }));
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
  return footer.length > 0 ? `\n${L('更多信息', 'More info')}:\n${footer.join('\n')}\n` : '';
}

export function showHelp(version: string): void {
  console.log(L(`
Neox CLI - AI 代码助手 v${version}

用法: neox [options] ["prompt"]

会话选项:
  -c, --continue         继续最近的会话
  -r, --resume [id]      恢复会话 (不给 id 弹选择器)
  --no-session           禁用会话持久化

通用选项:
  -p, --print            非交互模式: 执行 prompt 并打印结果
  --json                 print 模式输出单个 JSON 对象
  --output-format <fmt>  print 模式输出格式: text (纯文本, 无 ANSI) / json
  --keep-orphans         启动时不清理上次留下的后台进程
  --yolo                 print 模式允许写文件/执行命令
  --lean                 极简模式: 短提示词 + 6 个基础工具, 其余按需 unpack
  --timeout <seconds>    print 模式超时秒数, 默认不限时
  -m, --model <model>    指定模型
  --provider <id>        指定提供商
  -d, --dir <path>       工作目录
  --debug                启用调试日志
  --debug-console        调试日志输出到控制台
  --output-schema <path> 指定 JSON Schema 文件，用于结构化输出
  -h, --help             显示帮助
  -v, --version          显示版本

子命令:
${subcommandHelpLines().join('\n')}

会话命令 (REPL 内):
  /session <ls|new|info|export|clear>  会话管理 (别名 /sessions = /session ls)
  /checkpoint            检查点管理菜单
  /checkpoint create [name]   创建检查点
  /checkpoint enable|disable  开关文件快照
  /rollback <id>         回滚到检查点
  /changes               本会话改过哪些文件 (+N −M)
  /undo [文件] [--force]  撤销上一轮的文件改动 (先列文件再确认; --force 覆盖你的手改)

示例:
  neox                    启动交互会话
  neox "解释这段代码"      一次性执行 prompt 并输出 (同 -p)
  neox -p "解释这段代码"   非交互查询, 输出后退出
  neox -c                 继续上次会话
  neox provider ls        列出已配置 provider
${helpFooter()}`, `
Neox CLI - AI Code Assistant v${version}

Usage: neox [options] ["prompt"]

Session options:
  -c, --continue         Continue the most recent session
  -r, --resume [id]      Resume a session (shows a picker without an id)
  --no-session           Don’t save the session

General options:
  -p, --print            Non-interactive: run the prompt and print the result
  --json                 Print mode: output a single JSON object
  --output-format <fmt>  Print mode format: text (plain, no ANSI) / json
  --keep-orphans         Do not clean up background processes left from last run
  --yolo                 Print mode: allow writing files / running commands
  --lean                 Lean mode: short prompt + 6 basic tools, the rest unpacked on demand
  --timeout <seconds>    Print mode timeout, no limit by default
  -m, --model <model>    Model
  --provider <id>        Provider
  -d, --dir <path>       Working directory
  --debug                Debug logging
  --debug-console        Debug logs to the console
  --output-schema <path> JSON Schema file for structured output
  -h, --help             Show help
  -v, --version          Show version

Subcommands:
${subcommandHelpLines().join('\n')}

Session commands (in the REPL):
  /session <ls|new|info|export|clear>  Manage sessions (alias /sessions = /session ls)
  /checkpoint            Checkpoint menu
  /checkpoint create [name]   Create a checkpoint
  /checkpoint enable|disable  Toggle file snapshots
  /rollback <id>         Roll back to a checkpoint
  /changes               Files changed in this session (+N −M)
  /undo [file] [--force]  Undo the last turn's file changes (lists files, then asks; --force overwrites your edits)

Examples:
  neox                    Start an interactive session
  neox "explain this code"      One-shot prompt (same as -p)
  neox -p "explain this code"   Non-interactive query, exits after output
  neox -c                 Continue the last session
  neox provider ls        List providers
${helpFooter()}`));
}

/**
 * 显示版本信息
 */
export function showVersion(version: string): void {
  console.log(`Neox CLI v${version}`);
}
