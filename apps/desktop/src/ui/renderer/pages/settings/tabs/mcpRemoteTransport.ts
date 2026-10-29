/**
 * 粘贴 JSON 填表时, 远程 server 用哪种协议。规则与 core 的
 * migrate/discoverMcp.ts `inferRemoteMcpTransport` 一致 (渲染端不直接 import core 的值):
 *   写了 type 就照它 (sse / http / streamable-http);
 *   没写时路径以 /sse 结尾的是旧 SSE 端点惯例, 其余按标准协议 http。
 */
export function inferRemoteTransport(type: unknown, url: string): 'sse' | 'http' {
  const t = typeof type === 'string' ? type.toLowerCase().replace(/[-_\s]/g, '') : '';
  if (t === 'sse') return 'sse';
  if (t === 'http' || t === 'streamablehttp') return 'http';
  try {
    if (/\/sse\/?$/i.test(new URL(url).pathname)) return 'sse';
  } catch { /* url 不合法: 保存/连接时再报 */ }
  return 'http';
}
