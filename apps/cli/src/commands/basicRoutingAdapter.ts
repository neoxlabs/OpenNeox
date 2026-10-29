import { buildBasicCommandRoutingDeps } from './commandRoutingDepBuilders.js';

export type BasicRoutingDepsFromMain = ReturnType<typeof buildBasicCommandRoutingDeps>;

export function buildBasicCommandRoutingDepsFromMain(params: {
  workDir: string;
  uiController: any;
  getLastSelection: () => string;
  setLastSelection: (value: string) => void;
  executeCommand: (command: string) => Promise<void>;
  logInfo: (message: string, details?: string) => void;
  exitWithCleanup: (options: { skipProcessCheck: boolean; exitCode: number; reason: string }) => void;
}): BasicRoutingDepsFromMain {
  return buildBasicCommandRoutingDeps({
    workDir: params.workDir,
    uiController: params.uiController,
    getLastSelection: params.getLastSelection,
    setLastSelection: params.setLastSelection,
    executeCommand: params.executeCommand,
    logInfo: params.logInfo,
    exitWithCleanup: params.exitWithCleanup,
  });
}
