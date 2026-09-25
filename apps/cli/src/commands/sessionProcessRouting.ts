import {
  handleSessionsCommand,
  handleSessionSwitchCommand,
  handleSessionNewCommand,
  handleSessionInfoCommand,
  handleUndoCommand,
  handleCheckpointCommand,
  handleCheckpointsCommand,
  handleRollbackCommand,
  handleSessionClearCommand,
  handleSessionExportCommand,
  handleCompactCommand,
  handleCleanupCommand,
  handleProcessesCommand,
  handleKillCommand,
  type CommandContext,
  type ProcessCommandContext,
} from './index.js';

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
      // 统一入口: /session <ls|new|info|export|clear|<id>>; 无参=列表选择器
      const sub = (args[0] || '').toLowerCase();
      switch (sub) {
        case '':
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
    case '/undo':
      await handleUndoCommand(deps.getCommandContext(), args[0]); return true;
    case '/checkpoint':
      await handleCheckpointCommand(deps.getCommandContext(), args.join(' ')); return true;
    case '/checkpoints':
      await handleCheckpointsCommand(deps.getCommandContext()); return true;
    case '/rollback':
      await handleRollbackCommand(deps.getCommandContext(), args[0]); return true;
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
