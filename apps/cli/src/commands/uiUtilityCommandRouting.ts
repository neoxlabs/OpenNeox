import type { CommandContext } from './index.js';

interface UiUtilityCommandRoutingDeps {
  cmd: string;
  showSkillsScreen: () => Promise<void>;
  showLanguageMenu: () => Promise<void>;
  getCommandContext: () => CommandContext;
}

export async function handleUiUtilityCommandRouting(
  deps: UiUtilityCommandRoutingDeps,
): Promise<boolean> {
  switch (deps.cmd) {
    case '/skills':
      await deps.showSkillsScreen();
      return true;
    case '/language':
    case '/lang':
      await deps.showLanguageMenu();
      return true;
    case '/update': {
      const { handleUpdateCommand } = await import('./update-cmd.js');
      await handleUpdateCommand(deps.getCommandContext());
      return true;
    }
    default:
      return false;
  }
}
