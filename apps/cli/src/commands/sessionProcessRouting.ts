import {
  handleSessionsCommand,
  handleSessionSwitchCommand,
  handleSessionNewCommand,
  handleSessionInfoCommand,
  handleCheckpointCommand,
  handleCheckpointsCommand,
  handleRollbackCommand,
  handleChangesCommand,
  handleUndoCommand,
  handleSessionClearCommand,
  handleSessionExportCommand,
  handleCompactCommand,
  handleCleanupCommand,
  handleProcessesCommand,
  handleKillCommand,
  type CommandContext,
  type ProcessCommandContext,
} from './index.js';
import { L } from '../i18n/index.js';

interface SessionProcessDeps {
  getCommandContext: () => CommandContext;
  getProcessCommandContext: () => ProcessCommandContext;
  model: string;
  isRunning: boolean;
  setAutoCompactionInProgress: (value: boolean) => void;
}

export async function handleSessionProcessRouting(
  cmd: string,
  args: string[],
  deps: SessionProcessDeps,
): Promise<boolean> {
  switch (cmd) {
    case '/sessions':  // 隐藏别名: 等价 /session ls
    case '/resume':    // 同上 —— Claude Code / Codex 用户的肌肉记忆, 敲了却是"未知命令"
      await handleSessionsCommand(deps.getCommandContext()); return true;
    case '/session': {
      // 统一入口: /session <ls|new|info|export|clear|<id>>
      let sub = (args[0] || '').toLowerCase();
      if (!sub) {
        const ctx = deps.getCommandContext();
        try {
          sub = await ctx.promptSelect(L('会话', 'Session'), [
            { label: L('接着之前的会话', 'Resume a session'), value: 'ls' },
            { label: L('新会话', 'New session'), value: 'new' },
            { label: L('当前会话详情', 'Current session info'), value: 'info' },
            { label: L('导出当前会话', 'Export this session'), value: 'export', description: L('存到 ~/.neox/exports (JSON)', 'Saved to ~/.neox/exports (JSON)') },
          ], 'ls');
        } catch { return true; }
        if (!sub) return true;
      }
      switch (sub) {
        case 'ls':
        case 'list':
          await handleSessionsCommand(deps.getCommandContext()); return true;
        case 'new':
          await handleSessionNewCommand(deps.getCommandContext(), deps.model); return true;
        case 'info':
          await handleSessionInfoCommand(deps.getCommandContext()); return true;
        case 'export':
          await handleSessionExportCommand(deps.getCommandContext(), args[1]); return true;
        case 'clear':
          await handleSessionClearCommand(deps.getCommandContext()); return true;
        default:
          // 非关键字 → 当作 session id 切换
          await handleSessionSwitchCommand(deps.getCommandContext(), args[0]); return true;
      }
    }
    case '/session-new':  // 隐藏别名
      await handleSessionNewCommand(deps.getCommandContext(), deps.model); return true;
    case '/session-info':  // 隐藏别名
      await handleSessionInfoCommand(deps.getCommandContext()); return true;
    case '/checkpoint':
      await handleCheckpointCommand(deps.getCommandContext(), args.join(' ')); return true;
    case '/checkpoints':
      await handleCheckpointsCommand(deps.getCommandContext()); return true;
    case '/rollback':
      await handleRollbackCommand(deps.getCommandContext(), args[0]); return true;
    case '/changes':
      await handleChangesCommand(deps.getCommandContext()); return true;
    case '/undo': {
      /* 无参 = 撤销上一轮全部文件改动; /undo <文件> 只撤一个; --force = 覆盖用户手改 */
      const force = args.includes('--force') || args.includes('-f');
      const positional = args.filter(arg => !arg.startsWith('-'));
      await handleUndoCommand(deps.getCommandContext(), positional[0], { force }); return true;
    }
    case '/session-clear':
      await handleSessionClearCommand(deps.getCommandContext()); return true;
    case '/session-export':
      await handleSessionExportCommand(deps.getCommandContext(), args[0]); return true;
    case '/compact':
      deps.setAutoCompactionInProgress(await handleCompactCommand(deps.getCommandContext(), deps.isRunning)); return true;
    case '/cleanup':
      await handleCleanupCommand(deps.getCommandContext(), args[0]); return true;
    case '/processes':
    case '/ps':
      await handleProcessesCommand(deps.getProcessCommandContext(), args[0]); return true;
    case '/kill':
      await handleKillCommand(deps.getProcessCommandContext(), args[0]); return true;
    default:
      return false;
  }
}
