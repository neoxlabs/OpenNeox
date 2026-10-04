import type { CommandContext } from '../commands/index.js';

export function scheduleStartupUpdateCheck(
  getCommandContext: () => CommandContext,
  delayMs: number = 1200,
): void {
  setTimeout(() => {
    void (async () => {
      try {
        const { checkForUpdatesOnStartup } = await import('../commands/update-cmd.js');
        await checkForUpdatesOnStartup(getCommandContext());
      } catch {
        // Non-critical path, ignore failures.
      }
    })();
  }, delayMs);
}
