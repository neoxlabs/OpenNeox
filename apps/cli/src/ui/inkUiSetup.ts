import { InkUIAdapter } from '../ink/InkUIAdapter.js';
import type { AgentRunMode } from '@neoxlabs/core/runtime/modeFactory.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

interface CreateInkUIAdapterOptions {
  version: string;
  provider: string;
  model: string;
  reasoningEffort?: string;
  workDir: string;
  commandHints: string[];
  getCompletions: (value: string) => string[];
  account?: string;
  accountTone?: 'cyan' | 'green' | 'gray';
}

export function createInkUIAdapter(options: CreateInkUIAdapterOptions): InkUIAdapter {
  return new InkUIAdapter({
    version: options.version,
    provider: options.provider,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    workDir: options.workDir,
    commandHints: options.commandHints,
    getCompletions: options.getCompletions,
    memory: undefined,
    getPendingMessages: () => [],
    account: options.account,
    accountTone: options.accountTone,
  } as any);
}

interface InitInkUIRuntimeOptions {
  uiController: InkUIAdapter;
  compressionMode: 'sync' | 'async';
  thresholdPercent: number;
  initAskUserUI: (ui: InkUIAdapter) => void;
  setBackgroundTaskCallback: (callbacks: {
    onAdd: (command: string, pid: number) => number;
    onUpdate: (id: number, updates: { status?: string; exitCode?: number; outputLine?: string }) => void;
    onUpdateByPid: (pid: number, updates: { status?: string; exitCode?: number }) => void;
  }) => void;
}

export function initInkUIRuntime(options: InitInkUIRuntimeOptions): void {
  const toStatus = (status?: string): 'running' | 'done' | 'error' | 'killed' | undefined =>
    status === 'running' || status === 'done' || status === 'error' || status === 'killed'
      ? status
      : undefined;

  options.uiController.setCompressionMode(options.compressionMode);
  options.uiController.setCompactionThreshold(options.thresholdPercent);
  options.initAskUserUI(options.uiController);
  options.setBackgroundTaskCallback({
    onAdd: (command, pid) => options.uiController.addBackgroundTask(command, pid),
    onUpdate: (id, updates) => options.uiController.updateBackgroundTask(id, { ...updates, status: toStatus(updates.status) }),
    onUpdateByPid: (pid, updates) => options.uiController.updateBackgroundTaskByPid(pid, { ...updates, status: toStatus(updates.status) }),
  });
}

interface StartInkUIControllerOptions {
  uiController: InkUIAdapter;
  setInkConsolePatch: (enabled: boolean) => void;
  setInkUIActive: (active: boolean) => void;
  startOptions: Parameters<InkUIAdapter['start']>[0];
}

export function startInkUIController(options: StartInkUIControllerOptions): void {
  options.setInkConsolePatch(true);
  try {
    options.setInkUIActive(true);
    options.uiController.start(options.startOptions);
  } catch (error) {
    options.setInkConsolePatch(false);
    options.setInkUIActive(false);
    throw error;
  }
}

interface StartMainInkUIControllerOptions {
  uiController: InkUIAdapter;
  setInkConsolePatch: (enabled: boolean) => void;
  setInkUIActive: (active: boolean) => void;
  onSubmit: (
    input: string,
    images?: Array<{ mediaType?: string; data?: string; name: string }>,
  ) => Promise<void>;
  onExit: () => void;
  onInterrupt: () => void;
  isTaskRunning: () => boolean;
  onToggleThinking: (enabled: boolean) => void;
}

export function startMainInkUIController(options: StartMainInkUIControllerOptions): void {
  startInkUIController({
    uiController: options.uiController,
    setInkConsolePatch: options.setInkConsolePatch,
    setInkUIActive: options.setInkUIActive,
    startOptions: {
      onSubmit: async (input, images) => {
        const convertedImages = images?.map((img) => ({
          mediaType: img.mediaType,
          data: img.data,
          name: img.name || 'image',
        }));
        await options.onSubmit(input, convertedImages);
      },
      onExit: options.onExit,
      onInterrupt: options.onInterrupt,
      isTaskRunning: options.isTaskRunning,
      onToggleThinking: options.onToggleThinking,
    },
  });
}

export function startMainInkUIControllerWithGuards(options: StartMainInkUIControllerOptions): void {
  const uiStartAt = Date.now();
  try {
    startMainInkUIController(options);
    cliLogger.debug('BOOT', `runModernUI: ✓ uiController.start (${Date.now() - uiStartAt}ms)`);
  } catch (error: any) {
    cliLogger.error('BOOT', `runModernUI: ✗ uiController.start (${Date.now() - uiStartAt}ms): ${error?.message || String(error)}`);
    throw error;
  }
}

interface InitMainUIStateOptions {
  uiController: InkUIAdapter;
  currentRunMode: AgentRunMode;
  syncCompressionMode: () => void;
  updateContextWindowDisplay: () => void;
  logContextSettings: (details: { compressionMode: 'sync' | 'async'; thresholdPercent: number }) => void;
  compressionMode: 'sync' | 'async';
  thresholdPercent: number;
}

export function initMainUIState(options: InitMainUIStateOptions): void {
  options.uiController.setRunMode(options.currentRunMode);
  options.syncCompressionMode();
  options.updateContextWindowDisplay();
  options.logContextSettings({
    compressionMode: options.compressionMode,
    thresholdPercent: options.thresholdPercent,
  });
}

interface InitializeMainInkUiOptions {
  version: string;
  provider: string;
  model: string;
  reasoningEffort?: string;
  workDir: string;
  commandHints: string[];
  getCompletions: (value: string) => string[];
  compressionMode: 'sync' | 'async';
  thresholdPercent: number;
  initAskUserUI: (ui: InkUIAdapter) => void;
  setBackgroundTaskCallback: InitInkUIRuntimeOptions['setBackgroundTaskCallback'];
  currentRunMode: AgentRunMode;
  syncCompressionMode: () => void;
  updateContextWindowDisplay: () => void;
  logContextSettings: (details: { compressionMode: 'sync' | 'async'; thresholdPercent: number }) => void;
  account?: string;
  accountTone?: 'cyan' | 'green' | 'gray';
}

export function initializeMainInkUi(options: InitializeMainInkUiOptions): InkUIAdapter {
  const uiController = createInkUIAdapter({
    version: options.version,
    provider: options.provider,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    workDir: options.workDir,
    commandHints: options.commandHints,
    getCompletions: options.getCompletions,
    account: options.account,
    accountTone: options.accountTone,
  });

  initInkUIRuntime({
    uiController,
    compressionMode: options.compressionMode,
    thresholdPercent: options.thresholdPercent,
    initAskUserUI: options.initAskUserUI,
    setBackgroundTaskCallback: options.setBackgroundTaskCallback,
  });

  initMainUIState({
    uiController,
    currentRunMode: options.currentRunMode,
    syncCompressionMode: options.syncCompressionMode,
    updateContextWindowDisplay: options.updateContextWindowDisplay,
    logContextSettings: options.logContextSettings,
    compressionMode: options.compressionMode,
    thresholdPercent: options.thresholdPercent,
  });

  return uiController;
}
