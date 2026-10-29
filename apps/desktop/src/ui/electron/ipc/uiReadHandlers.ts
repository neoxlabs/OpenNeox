import { ipcMain } from './ipcMainBridged.js';
import { storageService } from '../../../platform-electron/storageService.js';

interface RegisterUIReadHandlersOptions {
  consumeCachedUIState: () => Promise<any>;
}

export function registerUIReadHandlers({ consumeCachedUIState }: RegisterUIReadHandlersOptions): void {
  /**
   * `ui:get-last-state`
   *
   * 返回全局状态 + (可选) per-workspace 编辑器布局。
   * renderer 调用时可以带 workspacePath —— 带了就从 per-workspace storage 读,
   * 否则从 global fallback 读 (首次启动 / welcome page)。
   */
  ipcMain.handle('ui:get-last-state', async (_event, workspacePath?: string) => {
    const uiState = await consumeCachedUIState();

    let editorLayout: {
      editorOpenFiles?: string[];
      editorActiveFile?: string;
      editorViewMode?: 'agent' | 'editor';
      sidebarVisible?: boolean;
      terminalVisible?: boolean;
    } = {};
    if (workspacePath) {
      editorLayout = await storageService.loadWorkspaceLayout(workspacePath);
    } else {
      editorLayout = {
        editorOpenFiles: uiState.editorOpenFiles,
        editorActiveFile: uiState.editorActiveFile,
        editorViewMode: uiState.editorViewMode,
        sidebarVisible: uiState.sidebarVisible,
        terminalVisible: uiState.terminalVisible,
      };
    }

    /* 超级调色盘: 启动时也把 themePack id 带回, renderer 优先用它。 */
    const themePackId = await storageService.getThemePackId();

    return {
      lastWorkspace: uiState.lastWorkspace,
      lastModelId: uiState.lastModelId,
      theme: uiState.theme,
      darkModePreference: uiState.darkModePreference,
      colorTheme: uiState.colorTheme,
      themePreset: uiState.themePreset,
      themePackId: themePackId ?? undefined,
      workspaces: uiState.workspaces,
      onboardingCompleted: uiState.onboardingCompleted,
      editorOpenFiles: editorLayout.editorOpenFiles,
      editorActiveFile: editorLayout.editorActiveFile,
      editorViewMode: editorLayout.editorViewMode,
      sidebarVisible: editorLayout.sidebarVisible,
      terminalVisible: editorLayout.terminalVisible,
    };
  });

  /* 引导完成标记 —— 唯一的写操作, 放在这儿是因为它同样只碰 storageService。
   * 少了它极简版每次启动都从引导第一步开始, 而且不报错 (renderer 那边是
   * catch 住只 console 一句), 很容易被当成"引导设计成这样"。 */
  ipcMain.handle('ui:set-onboarding-completed', async (_event, completed: boolean) => {
    await storageService.setOnboardingCompleted(completed);
  });

  /* 主题偏好的**写入** —— 只碰 storageService, 不碰 Electron。
   * 留在 uiHandlers 里的话极简版就存不住主题选择: 选了看着变了, 重启回到默认,
   * 而且不报错 (调用方 catch 住)。 */
  ipcMain.handle('ui:set-theme-preset', async (_event, preset: string) => {
    await storageService.setThemePreset(preset);
  });
  ipcMain.handle('ui:set-theme-pack', async (_event, packId: string) => {
    await storageService.setThemePack(packId);
  });

  ipcMain.handle('ui:get-theme', async () => {
    const ui = await storageService.loadUIState();
    return {
      darkMode: ui.darkModePreference,
      colorTheme: ui.colorTheme,
      themePackId: ui.themePackId,
      themePreset: ui.themePreset,
      theme: ui.theme,
    };
  });
}
