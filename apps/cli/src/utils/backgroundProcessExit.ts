import prompts from 'prompts';
import { processManager } from '@neoxlabs/platform/platform/processManager.js';
import { colors } from '../constants.js';
import { L } from '../i18n/index.js';

export async function handleBackgroundProcessExitPrompt(skipProcessCheck: boolean): Promise<void> {
  if (skipProcessCheck) {
    return;
  }

  const runningBg = processManager.getBackgroundRunning();
  if (runningBg.length === 0) {
    return;
  }

  console.log();
  console.log(colors.warning(L(`  ⚠  有 ${runningBg.length} 个后台进程正在运行:`, `  ⚠  ${runningBg.length} background process(es) still running:`)));
  console.log();
  runningBg.forEach(proc => {
    console.log(colors.dim(`    PID ${proc.pid}: ${proc.command.substring(0, 50)}${proc.command.length > 50 ? '...' : ''}`));
  });
  console.log();

  const { action } = await prompts({
    type: 'select',
    name: 'action',
    message: L('如何处理这些后台进程?', 'What should we do with these background processes?'),
    choices: [
      { title: L('终止所有后台进程并退出', 'Stop all background processes and exit'), value: 'kill' },
      { title: L('保持运行并退出 (进程将继续在后台运行)', 'Keep them running and exit (they continue in the background)'), value: 'keep' },
      { title: L('取消退出', 'Cancel exit'), value: 'cancel' },
    ],
  });

  if (action === 'cancel') {
    throw new Error('exit_cancelled');
  }

  if (action === 'kill') {
    console.log();
    console.log(colors.info(L('  正在终止后台进程...', '  Stopping background processes...')));
    const result = processManager.killAll(true);
    console.log(colors.success(L(`  ✓ 已终止 ${result.killed} 个进程`, `  ✓ Stopped ${result.killed} process(es)`)));
    if (result.failed > 0) {
      console.log(colors.warning(L(`  ⚠ ${result.failed} 个进程终止失败`, `  ⚠ ${result.failed} process(es) failed to stop`)));
    }
  }
}
