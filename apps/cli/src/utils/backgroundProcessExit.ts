import prompts from 'prompts';
import { processManager } from '@neoxlabs/platform/platform/processManager.js';
import { colors } from '../constants.js';

export async function handleBackgroundProcessExitPrompt(skipProcessCheck: boolean): Promise<void> {
  if (skipProcessCheck) {
    return;
  }

  const runningBg = processManager.getBackgroundRunning();
  if (runningBg.length === 0) {
    return;
  }

  console.log();
  console.log(colors.warning(`  ⚠  有 ${runningBg.length} 个后台进程正在运行:`));
  console.log();
  runningBg.forEach(proc => {
    console.log(colors.dim(`    PID ${proc.pid}: ${proc.command.substring(0, 50)}${proc.command.length > 50 ? '...' : ''}`));
  });
  console.log();

  const { action } = await prompts({
    type: 'select',
    name: 'action',
    message: '如何处理这些后台进程?',
    choices: [
      { title: '终止所有后台进程并退出', value: 'kill' },
      { title: '保持运行并退出 (进程将继续在后台运行)', value: 'keep' },
      { title: '取消退出', value: 'cancel' },
    ],
  });

  if (action === 'cancel') {
    throw new Error('exit_cancelled');
  }

  if (action === 'kill') {
    console.log();
    console.log(colors.info('  正在终止后台进程...'));
    const result = processManager.killAll(true);
    console.log(colors.success(`  ✓ 已终止 ${result.killed} 个进程`));
    if (result.failed > 0) {
      console.log(colors.warning(`  ⚠ ${result.failed} 个进程终止失败`));
    }
  }
}
