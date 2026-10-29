/**
 * renderer 侧认自己的系统 —— 插件市场要判「这个插件支持我吗」。
 *
 * ─── 为什么不去问主进程 ────────────────────────────────────────────────────
 * preload 没有暴露 process.platform (也不值得为这个新开一条 IPC), 而 renderer 本来就
 * 拿得到宿主系统: Electron 里 navigator.platform / userAgent 就是真实平台。
 * 同款做法见 utils/fileManagerLabels.ts (那边也是 navigator.platform + userAgent)。
 *
 * 判不出来返回**空串** —— isPlatformSupported 把空串当「支持」, 所以认不出系统时
 * 市场照旧能用, 只是不显示平台提示。宁可少拦, 不可错杀。
 */
export function hostPlatform(): string {
  const ua = typeof navigator === 'undefined'
    ? ''
    : `${navigator.platform || ''} ${navigator.userAgent || ''}`;
  if (/mac|iphone|ipad/i.test(ua)) return 'darwin';
  if (/win/i.test(ua)) return 'win32';
  if (/linux|x11/i.test(ua)) return 'linux';
  return '';
}
