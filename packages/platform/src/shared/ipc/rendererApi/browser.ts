type BrowserDebugResult = import('../../ipc.js').BrowserDebugResult;
type BrowserStatus = import('../../ipc.js').BrowserStatus;
type ChromeInstallation = import('../../ipc.js').ChromeInstallation;

export interface RendererAPIBrowser {
  // ==================== 浏览器工具管理 ====================
  browserGetStatus: () => Promise<BrowserStatus>;
  browserDebugUrl: (url: string, options?: {
    waitTime?: number;
    captureNetwork?: boolean;
    captureConsole?: boolean;
    captureScreenshot?: boolean;
  }) => Promise<BrowserDebugResult>;
  browserDetectChrome: () => Promise<ChromeInstallation>;
}
