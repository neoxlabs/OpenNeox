/**
 * 系统文件管理器文案 — Win=资源管理器 / macOS=Finder / 其它=文件管理器。
 * 渲染层用 <html data-platform>；拿不到时用 userAgent 兜底。
 */

export function isRendererWin32(): boolean {
  if (typeof document !== 'undefined') {
    const attr = document.documentElement.getAttribute('data-platform');
    if (attr) return attr === 'win32';
  }
  if (typeof navigator !== 'undefined') {
    return /Win/i.test(navigator.platform || '') || /Windows/i.test(navigator.userAgent || '');
  }
  return false;
}

export function isRendererDarwin(): boolean {
  if (typeof document !== 'undefined') {
    const attr = document.documentElement.getAttribute('data-platform');
    if (attr) return attr === 'darwin';
  }
  if (typeof navigator !== 'undefined') {
    return /Mac/i.test(navigator.platform || '') || /Mac OS/i.test(navigator.userAgent || '');
  }
  return false;
}

/** 「在 xxx 中显示」完整菜单/tooltip 文案 */
export function revealInFileManagerLabel(isZh: boolean): string {
  if (isRendererWin32()) {
    return isZh ? '在资源管理器中显示' : 'Reveal in File Explorer';
  }
  if (isRendererDarwin()) {
    return isZh ? '在 Finder 中显示' : 'Reveal in Finder';
  }
  return isZh ? '在文件管理器中显示' : 'Reveal in File Manager';
}

/** 短名：资源管理器 / Finder / 文件管理器 */
export function fileManagerShortName(isZh: boolean): string {
  if (isRendererWin32()) return isZh ? '资源管理器' : 'File Explorer';
  if (isRendererDarwin()) return isZh ? 'Finder' : 'Finder';
  return isZh ? '文件管理器' : 'File Manager';
}
