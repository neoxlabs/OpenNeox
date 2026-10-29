/**
 * 远端执行的会话 (云端会话) 的传输口 —— 共享代码只认这个接口, 不 import 具体实现。
 *
 * 具体实现 (cloud-session/: relay 消费端 + 会话密钥表) 只在商业发行版里存在, 由发行版
 * 入口 (mainEdition.ts / ipc/liteEdition.ts) 在启动时注册。公开构建没有云端会话, 用的是
 * 下面的 localOnly: 没有任何会话是远端的, 所以聊天 / 检查点 / 审批全部走本机那条路;
 * 真有调用方要往远端发 (渲染端显式标了 transport='cloud'), 拿到的是一个明确的失败。
 *
 * 这不是"连不上就当本地"的兜底: localOnly 是公开构建的真实语义, 商业构建启动时就被替换,
 * 替换发生在任何 IPC 注册之前。
 */
import type { RpcMessage } from '@neoxlabs/core/relay-transport/index.js';
import type { CloudRelayClient } from './mobile-bridge/cloudRelayClient.js';

export type RemoteSessionKeyResult =
  | { ok: true }
  | { ok: false; reason: string; code: string };

export interface RemoteSessionTransport {
  /** 这个会话是否在远端执行 (本机只是转发)。 */
  has(sessionId: string): boolean;
  /** 丢掉本地缓存的会话密钥 (下次 ensureKey 重新向服务端要)。 */
  forget(sessionId: string): void;
  /** 清空全部远端会话缓存 (登出时)。 */
  clear(): void;
  /** 确保手里有该会话的加密密钥; 失败带原因与错误码。 */
  ensureKey(sessionId: string): Promise<RemoteSessionKeyResult>;
  /** 发一条 JSON-RPC 请求给远端并等响应。 */
  sendRequest(sessionId: string, method: string, params?: unknown): Promise<RpcMessage>;
  /** 这条审批请求是不是远端会话发来的。 */
  isRemoteApproval(requestId: string): boolean;
  replyApproval(requestId: string, approved: boolean, remember: boolean): Promise<void>;
  /** 与手机中继共用同一条 relay 连接 (同一设备两条连接会互相挤掉)。 */
  attachRelayClient(client: CloudRelayClient): void;
  dispose(): Promise<void>;
}

const REMOTE_UNAVAILABLE = 'Remote sessions are not available in this build';

export const localOnlySessions: RemoteSessionTransport = {
  has: () => false,
  forget: () => {},
  clear: () => {},
  ensureKey: async () => ({ ok: false, reason: REMOTE_UNAVAILABLE, code: 'UNAVAILABLE' }),
  sendRequest: async () => { throw new Error(REMOTE_UNAVAILABLE); },
  isRemoteApproval: () => false,
  replyApproval: async () => { throw new Error(REMOTE_UNAVAILABLE); },
  attachRelayClient: () => {},
  dispose: async () => {},
};

let transport: RemoteSessionTransport = localOnlySessions;

export function registerRemoteSessionTransport(next: RemoteSessionTransport): void {
  transport = next;
}

export function remoteSessions(): RemoteSessionTransport {
  return transport;
}
