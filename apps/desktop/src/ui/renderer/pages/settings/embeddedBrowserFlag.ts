/**
 * 内嵌浏览器的开关 —— 单独一个文件, 是为了**让设置搜索也读得到**。
 *
 *   本来这个判断长在 BrowserTab.tsx 里, 而 BrowserTab 是 lazy 加载的:
 *   SettingsPage 要过滤搜索结果就得静态 import 它, 那样代码分割就白做了。
 *   一个只读 localStorage 的纯函数, 拆出来最省事。
 *
 *   为什么默认关: 内嵌浏览器用的是 Electron `<webview>`, 而本构建没开 webviewTag ——
 *   填了地址点「打开」只会得到一个 0×0 的空元素, 什么都看不到 (典型的"点了给不到")。
 *   要不要重开是产品决定, 见 BrowserTab 文件头。
 *
 *   本机逃生门: localStorage['neox.embeddedBrowser.enabled'] = '1' (作者自测;
 *   真要用还得先在 mainWindowFactory 里打开 webviewTag)。
 */
export const EMBEDDED_BROWSER_OVERRIDE_KEY = 'neox.embeddedBrowser.enabled';

export function isEmbeddedBrowserEnabled(): boolean {
  try {
    return typeof window !== 'undefined'
      && window.localStorage.getItem(EMBEDDED_BROWSER_OVERRIDE_KEY) === '1';
  } catch {
    return false;
  }
}
