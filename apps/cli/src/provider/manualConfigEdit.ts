import chalk from 'chalk';
import { CONFIG_FILE } from '@neoxlabs/platform/utils/config.js';
import { L } from '../i18n/index.js';

export async function handleManualProviderConfigEdit(): Promise<void> {
  console.log();
  console.log(chalk.yellow(L('请编辑配置文件并填入您的 API Key:', 'Edit the config file and fill in your API key:')));
  console.log(chalk.cyan(`  ${CONFIG_FILE}`));
  console.log();

  const { spawn } = await import('child_process');
  const { isWSL } = await import('@neoxlabs/platform/platform/platformDetect.js');
  let editor: string;
  if (process.env.EDITOR || process.env.VISUAL) {
    editor = process.env.EDITOR || process.env.VISUAL!;
  } else if (process.platform === 'darwin') {
    editor = 'open';
  } else if (isWSL()) {
    editor = 'wslview';
  } else {
    editor = 'xdg-open';
  }
  console.log(chalk.dim(L(`  使用 ${editor} 打开配置文件...`, `  Opening the config file with ${editor}...`)));
  spawn(editor, [CONFIG_FILE], { detached: true, stdio: 'ignore' }).unref();

  console.log();
  console.log(chalk.dim(L('编辑完成后，请重新运行 CLI。', 'After editing, run the CLI again.')));
  console.log();
  process.exit(0);
}
