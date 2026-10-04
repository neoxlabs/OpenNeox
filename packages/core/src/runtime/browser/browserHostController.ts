/**
 * Optional host-side browser controller.
 *
 * Desktop runs the runtime in Electron main process, where BrowserView webContents
 * are already available. In that environment browser tools should use the host
 * controller instead of Electron's global remote-debugging TCP port.
 */

export interface BrowserHostController {
  listSurfaces?(): Promise<Array<{ surfaceId: string; url: string; title: string; [key: string]: any }>>;
  diagnose?(): Promise<any>;

  browserNavigate?(args: any): Promise<any>;
  browserScreenshot?(args: any): Promise<any>;
  browserGetState?(args: any): Promise<any>;
  browserGetAriaTree?(args: any): Promise<any>;
  browserQuery?(args: any): Promise<any>;
  browserGetText?(args: any): Promise<any>;
  browserClick?(args: any): Promise<any>;
  browserType?(args: any): Promise<any>;
  browserPressKey?(args: any): Promise<any>;
  browserScroll?(args: any): Promise<any>;
  browserHover?(args: any): Promise<any>;
  browserSelectOption?(args: any): Promise<any>;
  browserFillForm?(args: any): Promise<any>;
  browserWaitFor?(args: any): Promise<any>;
  browserWaitForNavigation?(args: any): Promise<any>;
  browserGetConsoleLogs?(args: any): Promise<any>;
  browserGetNetwork?(args: any): Promise<any>;
  browserGetResponseBody?(args: any): Promise<any>;
  browserBack?(args: any): Promise<any>;
  browserForward?(args: any): Promise<any>;
  browserReload?(args: any): Promise<any>;
  browserExpect?(args: any): Promise<any>;
  browserEval?(args: any): Promise<any>;
  browserGetCookies?(args: any): Promise<any>;
  browserSetCookies?(args: any): Promise<any>;
  browserClearCookies?(args: any): Promise<any>;
  browserGetLocalStorage?(args: any): Promise<any>;
  browserSetLocalStorage?(args: any): Promise<any>;
  browserMockResponse?(args: any): Promise<any>;
  browserClearMocks?(args: any): Promise<any>;
  browserListMocks?(args: any): Promise<any>;
  browserSetInputFiles?(args: any): Promise<any>;
  browserClickAt?(args: any): Promise<any>;
  browserMouseMove?(args: any): Promise<any>;
  browserDrag?(args: any): Promise<any>;
  browserKeyboardType?(args: any): Promise<any>;
  browserKeyboardPress?(args: any): Promise<any>;

  /* UI 测试强化 — 可选实现. embedded 模式暂不实现全部,
   *  外置 Chrome 模式全部走 browserManager (Playwright) 兜底不需要 host. */
  browserSetViewport?(args: any): Promise<any>;
  browserWaitForNetworkIdle?(args: any): Promise<any>;
  browserHighlight?(args: any): Promise<any>;
  browserA11yScan?(args: any): Promise<any>;
  browserGetPerfMetrics?(args: any): Promise<any>;
  browserPdf?(args: any): Promise<any>;
  browserExportStorageState?(args: any): Promise<any>;
  browserImportStorageState?(args: any): Promise<any>;
  browserWaitForDownload?(args: any): Promise<any>;
  browserThrottle?(args: any): Promise<any>;
  browserRecordStart?(args: any): Promise<any>;
  browserRecordStop?(args: any): Promise<any>;
  browserGetComputedStyle?(args: any): Promise<any>;
  browserGetBbox?(args: any): Promise<any>;
  browserGetFullDom?(args: any): Promise<any>;
}

let hostController: BrowserHostController | null = null;
const GLOBAL_BROWSER_HOST_KEY = '__NEOX_BROWSER_HOST_CONTROLLER__';

export function setBrowserHostController(controller: BrowserHostController | null): void {
  hostController = controller;
}

export function getBrowserHostController(): BrowserHostController | null {
  return hostController ?? ((globalThis as any)[GLOBAL_BROWSER_HOST_KEY] as BrowserHostController | undefined) ?? null;
}
