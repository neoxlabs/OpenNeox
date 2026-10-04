import { spawn } from 'node:child_process';
import { CLI_VERSION } from '../constants.js';

/** 反馈 / 报 bug: 打开官网反馈页 (发出去是一封寄到 support@ 的信), 打不开就把地址印出来 */
function openFeedback(): void {
  const url = `https://neox-dev.com/feedback?source=cli&v=${encodeURIComponent(CLI_VERSION)}&p=${encodeURIComponent(`${process.platform}-${process.arch}`)}`;
  console.log(`\n  反馈 / 报 bug: ${url}\n  或直接写信: support@neox-dev.com\n`);
  try {
    const [bin, args] = process.platform === 'darwin' ? ['open', [url]]
      : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
    spawn(bin as string, args as string[], { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
  } catch { /* 没有浏览器 (ssh 里): 上面的地址已经印出来了 */ }
}

interface BasicCommandRoutingDeps {
  handleExit: () => void;
  handleHelp: () => Promise<void>;
  handleSchemaExample: (schemaName?: string) => Promise<void>;
}

export async function handleBasicCommandRouting(
  cmd: string,
  args: string[],
  deps: BasicCommandRoutingDeps,
): Promise<boolean> {
  switch (cmd) {
    case '/exit':
    case '/quit':
    case 'exit':
    case 'quit':
      deps.handleExit();
      return true;
    case '/help':
      await deps.handleHelp();
      return true;
    case '/feedback':
      openFeedback();
      return true;
    case '/schema-example':
      // structured-output schema 脚手架 — 高级/自动化用, 默认不对最终用户暴露
      if (!process.env.NEOX_DEBUG && !process.env.CLI_DEBUG) return false;
      await deps.handleSchemaExample(args[0]);
      return true;
    default:
      return false;
  }
}
