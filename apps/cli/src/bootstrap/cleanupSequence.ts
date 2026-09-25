interface CleanupSequenceSteps {
  stopUi: () => void;
  stopRemoteServer: () => Promise<void>;
  disposeRemoteAdapter: () => void;
  stopServerConnection: () => void;
  shutdownActionLog: () => Promise<void>;
  handleBackgroundProcesses: () => Promise<void>;
}

export async function runCleanupSequence(steps: CleanupSequenceSteps): Promise<void> {
  steps.stopUi();
  await steps.stopRemoteServer();
  steps.disposeRemoteAdapter();
  steps.stopServerConnection();
  await steps.shutdownActionLog();
  await steps.handleBackgroundProcesses();
}
