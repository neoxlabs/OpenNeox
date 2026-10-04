import { cliHealthMonitor, cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

export function logRunModernUiDebugStateFromMain(stage: 'start' | 'beforeStart' | 'afterStart'): void {
  if (!process.env.CLI_DEBUG) {
    return;
  }
  if (stage === 'start') {
    cliLogger.info('CLI', '=== runModernUI() starting ===');
    cliHealthMonitor.logStdinState('runModernUI.start');
    return;
  }
  if (stage === 'beforeStart') {
    cliLogger.debug('CLI', 'Ink UI adapter created, starting UI...');
    cliHealthMonitor.logStdinState('runModernUI.beforeStart');
    return;
  }
  cliLogger.info('CLI', '=== runModernUI() UI started, entering event loop ===');
  cliHealthMonitor.logStdinState('runModernUI.afterStart');
}

export async function runModernUiFlowFromMain(params: {
  workDir: string;
  logRunModernUiDebugState: (stage: 'start' | 'beforeStart' | 'afterStart') => void;
  ensureProviderReadyForUi: () => Promise<void>;
  initializeModernUiSession: (bt: (label: string) => void) => Promise<void>;
  initializeInkUi: (workDirShort: string) => void;
  startInkUiControllerWithGuards: () => void;
  startRemoteServerForModernUi: (bt: (label: string) => void) => Promise<void>;
  scheduleStartupUpdateCheck: () => void;
}): Promise<void> {
  const _t0 = Date.now();
  const _bt = (label: string) => cliLogger.debug('BOOT', `runModernUI: ${label} (+${Date.now() - _t0}ms)`);
  _bt('enter');
  params.logRunModernUiDebugState('start');

  await params.ensureProviderReadyForUi();

  const workDirShort = params.workDir.replace(process.env.HOME || '', '~');

  await params.initializeModernUiSession(_bt);

  // Initialize Ink UI
  _bt('creating InkUIAdapter...');
  params.initializeInkUi(workDirShort);

  params.logRunModernUiDebugState('beforeStart');

  // Start UI
  _bt('uiController.start()...');
  params.startInkUiControllerWithGuards();

  // this.updateContextWindowDisplay();

  _bt('UI started');
  params.logRunModernUiDebugState('afterStart');

  await params.startRemoteServerForModernUi(_bt);

  params.scheduleStartupUpdateCheck();

  _bt('ready ✓');

  // Keep process alive
  return new Promise(() => { });
}
