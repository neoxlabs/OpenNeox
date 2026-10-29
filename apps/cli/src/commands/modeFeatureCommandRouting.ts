import type { SelectionChoice } from '../cliTypes.js';
import { handleSandboxCommand } from './modeRunSandboxCommands.js';
import { handleTtsCommand } from './ttsCommand.js';
import { handleExperimentalCommand } from './experimentalCommand.js';
// /speed /effort /style 已彻底移除: 它们的 setter 写的 state 引擎从不读取(假命令)。
// 早先已从 menu/completion/help 下架, 但 dispatch 路径残留 → 用户仍能输入并得到
// "已设置"的假确认。现连 dispatch 也删。真正生效的并发档位是 /mode auto|low。

interface ModeFeatureCommandRoutingDeps {
  cmd: string;
  args: string[];
  model: string;
  promptSelect: (
    question: string,
    choices: SelectionChoice[],
    defaultValue?: string,
  ) => Promise<string>;
  logInfo: (message: string, details?: string) => void;
  isSandboxEnabled: () => boolean;
  setSandboxEnabled: (enabled: boolean) => void;
  syncSandboxMode: (enabled: boolean) => Promise<void>;
  syncTtsEnabled: (enabled: boolean) => void;
}

export async function handleModeFeatureCommandRouting(
  deps: ModeFeatureCommandRoutingDeps,
): Promise<boolean> {
  switch (deps.cmd) {
    case '/sandbox':
      await handleSandboxCommand(deps.args[0], {
        isSandboxEnabled: deps.isSandboxEnabled,
        setSandboxEnabled: deps.setSandboxEnabled,
        syncSandboxMode: deps.syncSandboxMode,
        promptSelect: deps.promptSelect,
        logInfo: deps.logInfo,
      });
      return true;
    case '/tts':
      await handleTtsCommand(deps.args[0], {
        promptSelect: deps.promptSelect,
        logInfo: deps.logInfo,
        syncTtsEnabled: deps.syncTtsEnabled,
      });
      return true;
    case '/experimental':
      await handleExperimentalCommand(deps.args[0], {
        model: deps.model,
        promptSelect: deps.promptSelect,
        logInfo: deps.logInfo,
      });
      return true;
    default:
      return false;
  }
}
