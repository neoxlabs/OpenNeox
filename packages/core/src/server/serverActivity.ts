/** 跟踪 SSE 连接和最近请求时间，供 daemon 判断空闲状态。 */

let _activeSseClients = 0;
let _lastActivityTs = Date.now();

/** 任意 HTTP 请求 / SSE 数据往来时调一下, 刷新"最后活跃"时间戳。 */
export function touchActivity(): void {
  _lastActivityTs = Date.now();
}

/** 一个 SSE 客户端 (/events) 连上。 */
export function sseClientConnected(): void {
  _activeSseClients += 1;
  _lastActivityTs = Date.now();
}

/** 一个 SSE 客户端断开。 */
export function sseClientDisconnected(): void {
  _activeSseClients = Math.max(0, _activeSseClients - 1);
  _lastActivityTs = Date.now();
}

export function getActiveSseClients(): number {
  return _activeSseClients;
}

export function getLastActivityTs(): number {
  return _lastActivityTs;
}
