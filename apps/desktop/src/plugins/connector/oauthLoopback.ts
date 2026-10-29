/**
 * 连接器 OAuth 回环地址 / 回调页转义 —— 不碰 Electron, 方便单测。
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Google Desktop 客户端只认 127.0.0.1。
 * Azure 公共客户端登记的是 http://localhost, 实际回调必须用这个主机名。
 */
export function loopbackRedirectHost(authorizeUrl: string): 'localhost' | '127.0.0.1' {
  try {
    const host = new URL(authorizeUrl).hostname.toLowerCase();
    if (
      host === 'login.microsoftonline.com'
      || host.endsWith('.microsoftonline.com')
      || host === 'login.microsoft.com'
      || host.endsWith('.microsoft.com')
      || host === 'slack.com'
      || host.endsWith('.slack.com')
    ) {
      return 'localhost';
    }
  } catch { /* 清单 URL 坏了时走 Google 那条, 至少不把请求打到 LAN */ }
  return '127.0.0.1';
}

export function loopbackRedirectUri(port: number, authorizeUrl: string): string {
  return `http://${loopbackRedirectHost(authorizeUrl)}:${port}/callback`;
}
