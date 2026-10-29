import { app } from 'electron';

interface WindowsUpdater {
  autoInstallOnAppQuit: boolean;
  quitAndInstall(): void;
}

let pendingInstall: { onQuit: (event: unknown, exitCode: number) => void; cancel: () => void } | null = null;

/** Defer installation until the cancellable quit confirmation and cleanup have finished. */
export function requestWindowsUpdateInstall(updater: WindowsUpdater): void {
  requestInstallOnQuit(() => updater.quitAndInstall(), updater);
}

export function requestInstallerOnQuit(install: () => void, updater?: WindowsUpdater): void {
  requestInstallOnQuit(install, updater);
}

function requestInstallOnQuit(install: () => void, updater?: WindowsUpdater): void {
  if (pendingInstall) return;
  const previousAutoInstall = updater?.autoInstallOnAppQuit;
  if (updater) updater.autoInstallOnAppQuit = false;
  const onQuit = (_event: unknown, exitCode: number) => {
    pendingInstall = null;
    if (exitCode !== 0) {
      console.error('[auto-update] 应用异常退出，跳过安装:', exitCode);
      return;
    }
    try {
      install();
    } catch (error) {
      console.error('[auto-update] 安装器启动失败:', error);
    }
  };
  pendingInstall = {
    onQuit,
    cancel: () => {
      if (updater) updater.autoInstallOnAppQuit = previousAutoInstall!;
    },
  };
  app.once('quit', onQuit);
  app.quit();
}

export function cancelPendingWindowsUpdateInstall(): void {
  if (!pendingInstall) return;
  app.removeListener('quit', pendingInstall.onQuit);
  pendingInstall.cancel();
  pendingInstall = null;
}
