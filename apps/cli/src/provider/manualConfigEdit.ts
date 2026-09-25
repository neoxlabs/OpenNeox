import chalk from 'chalk';
import { CONFIG_FILE } from '@neoxlabs/platform/utils/config.js';

export async function handleManualProviderConfigEdit(): Promise<void> {
  console.log();
  console.log(chalk.yellow('请编辑配置文件并填入您的 API Key:'));
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
  console.log(chalk.dim(`  使用 ${editor} 打开配置文件...`));
  spawn(editor, [CONFIG_FILE], { detached: true, stdio: 'ignore' }).unref();

  console.log();
  console.log(chalk.dim('编辑完成后，请重新运行 CLI。'));
  console.log();
  process.exit(0);
}
