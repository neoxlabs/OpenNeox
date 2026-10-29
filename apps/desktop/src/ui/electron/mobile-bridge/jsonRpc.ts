/**
 * mobile-bridge/jsonRpc.ts — JSON-RPC 2.0 dispatcher
 *
 * 严格对齐 内部设计文档 §3.3 / §5.
 *
 * 用法:
 *   const dispatcher = new JsonRpcDispatcher();
 *   dispatcher.register('session.subscribe', (params, ctx) => { ... });
 *   const reply = await dispatcher.handle(incomingMessage, context);
 */

import type { RpcMessage } from './types.js';

export type RpcMethodHandler<TContext = unknown> = (
  params: any,
  ctx: TContext,
) => Promise<any> | any;

export class JsonRpcDispatcher<TContext = unknown> {
  private handlers = new Map<string, RpcMethodHandler<TContext>>();

  register(method: string, handler: RpcMethodHandler<TContext>): void {
    if (this.handlers.has(method)) {
      throw new Error(`JsonRpc method "${method}" already registered`);
    }
    this.handlers.set(method, handler);
  }

  unregister(method: string): void {
    this.handlers.delete(method);
  }

  /** 处理收到的 RpcMessage. 返要回的 response (notification 返 null). */
  async handle(msg: RpcMessage, ctx: TContext): Promise<RpcMessage | null> {
    /* 校验基础格式 */
    if (msg.jsonrpc !== '2.0') {
      return makeErrorResponse(msg.id, -32600, 'Invalid Request: jsonrpc must be "2.0"');
    }
    if (typeof msg.method !== 'string' || !msg.method) {
      /* 这是 response (无 method), 不是 request — 我们不处理服务端 → 客户端的 response */
      return null;
    }
    const handler = this.handlers.get(msg.method);
    if (!handler) {
      if (msg.id == null) return null; // notification, 静默丢
      return makeErrorResponse(msg.id, -32601, `Method not found: ${msg.method}`);
    }
    /* 调 handler */
    try {
      const result = await handler(msg.params, ctx);
      if (msg.id == null) return null; // notification, 不回
      return { jsonrpc: '2.0', id: msg.id, result };
    } catch (e: any) {
      /* handler 抛 RpcError → 用它的 code/message; 否则 -32603 internal */
      if (e instanceof RpcError) {
        if (msg.id == null) return null;
        return makeErrorResponse(msg.id, e.code, e.message, e.data);
      }
      // eslint-disable-next-line no-console
      console.error(`[jsonRpc] handler "${msg.method}" failed:`, e);
      if (msg.id == null) return null;
      return makeErrorResponse(msg.id, -32603, `Internal error: ${e?.message ?? String(e)}`);
    }
  }
}

/** 自定义错误 — handler 抛它来设特定 code/message */
export class RpcError extends Error {
  constructor(public code: number, message: string, public data?: any) {
    super(message);
    this.name = 'RpcError';
  }
}

/** 错误码常量 (跟 protocol §5) */
export const RpcErrorCode = {
  // standard JSON-RPC
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // Neox 自定义
  AUTH_FAILED: 4001,
  SESSION_NOT_FOUND: 4002,
  PERMISSION_DENIED: 4003,
  RATE_LIMIT: 4004,
  DESKTOP_OFFLINE: 5001,
  DECRYPT_FAILED: 5002,
} as const;

export function makeErrorResponse(
  id: string | undefined,
  code: number,
  message: string,
  data?: any,
): RpcMessage {
  return {
    jsonrpc: '2.0',
    id: id ?? '',
    error: { code, message, ...(data !== undefined && { data }) },
  };
}

/** helper: 造 notification (不带 id) — 服务端推给客户端 */
export function makeNotification(method: string, params?: any): RpcMessage {
  return { jsonrpc: '2.0', method, ...(params !== undefined && { params }) };
}

/** helper: 造 request (带 id) — 极少情况, Desktop 主动向 Phone 请求 */
export function makeRequest(id: string, method: string, params?: any): RpcMessage {
  return { jsonrpc: '2.0', id, method, ...(params !== undefined && { params }) };
}

/** parse 入流 raw bytes → RpcMessage */
export function parseRpcMessage(raw: string | Buffer): RpcMessage | null {
  try {
    const text = typeof raw === 'string' ? raw : raw.toString('utf-8');
    const obj = JSON.parse(text);
    if (typeof obj !== 'object' || obj == null) return null;
    return obj as RpcMessage;
  } catch {
    return null;
  }
}

/** serialize RpcMessage → string (准备发 WS) */
export function serializeRpcMessage(msg: RpcMessage): string {
  return JSON.stringify(msg);
}
