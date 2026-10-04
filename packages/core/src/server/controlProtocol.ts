/** 双向 control_request/control_response 协议，覆盖握手、模型、权限、状态和连接控制。 */

import { randomUUID } from 'crypto';

// ─── 类型定义 ───

export type ControlRequestSubtype =
  | 'initialize'
  | 'set_model'
  | 'set_permission_mode'
  | 'interrupt'
  | 'set_mode'
  | 'get_status'
  | 'reconnect'
  | 'ping';

export interface ControlRequest {
  type: 'control_request';
  request_id: string;
  request: {
    subtype: ControlRequestSubtype;
    [key: string]: unknown;
  };
}

export interface ControlResponseSuccess {
  type: 'control_response';
  request_id: string;
  response: {
    subtype: 'success';
    [key: string]: unknown;
  };
}

export interface ControlResponseError {
  type: 'control_response';
  request_id: string;
  response: {
    subtype: 'error';
    error: string;
  };
}

export type ControlResponse = ControlResponseSuccess | ControlResponseError;

// ─── 类型守卫 ───

export function isControlRequest(value: unknown): value is ControlRequest {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return (
    obj.type === 'control_request' &&
    typeof obj.request_id === 'string' &&
    typeof obj.request === 'object' &&
    obj.request !== null &&
    typeof (obj.request as Record<string, unknown>).subtype === 'string'
  );
}

export function isControlResponse(value: unknown): value is ControlResponse {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return (
    obj.type === 'control_response' &&
    typeof obj.request_id === 'string' &&
    typeof obj.response === 'object' &&
    obj.response !== null
  );
}

// ─── 控制请求处理器 ───

export interface ControlRequestHandlers {
  onInitialize?: () => InitializeResponse;
  onSetModel?: (model: string) => { ok: boolean; error?: string };
  onSetPermissionMode?: (mode: string) => { ok: boolean; error?: string };
  onInterrupt?: (reason?: string) => void;
  onSetMode?: (mode: string) => { ok: boolean; error?: string };
  onGetStatus?: () => Record<string, unknown>;
  onReconnect?: () => void;
  /** 是否为 outbound-only 模式 */
  outboundOnly?: boolean;
}

export interface InitializeResponse {
  models?: string[];
  modes?: string[];
  capabilities?: string[];
  pid?: number;
  version?: string;
}

/** 处理 control_request；outbound-only 连接只允许查询类请求。 */
export function handleControlRequest(
  request: ControlRequest,
  handlers: ControlRequestHandlers,
): ControlResponse {
  const { request_id } = request;
  const { subtype } = request.request;

  // outbound-only 模式：只允许 initialize 和 ping
  if (handlers.outboundOnly && subtype !== 'initialize' && subtype !== 'ping' && subtype !== 'get_status') {
    return makeErrorResponse(request_id,
      'This session is outbound-only. Control requests are not accepted.');
  }

  switch (subtype) {
    case 'initialize': {
      const result = handlers.onInitialize?.() ?? {};
      return makeSuccessResponse(request_id, {
        ...result,
        pid: result.pid ?? process.pid,
      });
    }

    case 'set_model': {
      const model = request.request.model as string;
      if (!model) return makeErrorResponse(request_id, 'Missing model parameter');
      const result = handlers.onSetModel?.(model);
      if (result && !result.ok) return makeErrorResponse(request_id, result.error ?? 'Failed');
      return makeSuccessResponse(request_id, { model });
    }

    case 'set_permission_mode': {
      const mode = request.request.mode as string;
      if (!mode) return makeErrorResponse(request_id, 'Missing mode parameter');
      const result = handlers.onSetPermissionMode?.(mode);
      if (result && !result.ok) return makeErrorResponse(request_id, result.error ?? 'Failed');
      return makeSuccessResponse(request_id, { mode });
    }

    case 'interrupt': {
      const reason = request.request.reason as string | undefined;
      handlers.onInterrupt?.(reason);
      return makeSuccessResponse(request_id, {});
    }

    case 'set_mode': {
      const mode = request.request.mode as string;
      if (!mode) return makeErrorResponse(request_id, 'Missing mode parameter');
      const result = handlers.onSetMode?.(mode);
      if (result && !result.ok) return makeErrorResponse(request_id, result.error ?? 'Failed');
      return makeSuccessResponse(request_id, { mode });
    }

    case 'get_status': {
      const status = handlers.onGetStatus?.() ?? {};
      return makeSuccessResponse(request_id, status);
    }

    case 'reconnect': {
      handlers.onReconnect?.();
      return makeSuccessResponse(request_id, {});
    }

    case 'ping': {
      return makeSuccessResponse(request_id, { pong: true, timestamp: Date.now() });
    }

    default:
      return makeErrorResponse(request_id, `Unknown control request subtype: ${subtype}`);
  }
}

// ─── 控制请求发起器 ───

/** 超时时间（毫秒） */
const CONTROL_REQUEST_TIMEOUT_MS = 10_000;

interface PendingRequest {
  resolve: (response: ControlResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * ControlRequester — 发起控制请求并等待响应
 * 用于服务端主动向客户端发送控制请求
 */
export class ControlRequester {
  private pending = new Map<string, PendingRequest>();

  /**
   * 创建 control_request 消息
   */
  createRequest(subtype: ControlRequestSubtype, params?: Record<string, unknown>): ControlRequest {
    return {
      type: 'control_request',
      request_id: randomUUID(),
      request: {
        subtype,
        ...params,
      },
    };
  }

  /**
   * 发送控制请求并等待响应
   * @param send 发送函数
   * @param subtype 请求子类型
   * @param params 额外参数
   * @param timeoutMs 超时（默认 10s）
   */
  async request(
    send: (msg: ControlRequest) => Promise<void>,
    subtype: ControlRequestSubtype,
    params?: Record<string, unknown>,
    timeoutMs = CONTROL_REQUEST_TIMEOUT_MS,
  ): Promise<ControlResponse> {
    const req = this.createRequest(subtype, params);

    return new Promise<ControlResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(req.request_id);
        reject(new Error(`Control request '${subtype}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(req.request_id, { resolve, reject, timer });
      send(req).catch((err) => {
        this.pending.delete(req.request_id);
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  /**
   * 处理收到的 control_response — 匹配等待中的请求
   * @returns true 如果匹配成功
   */
  handleResponse(response: ControlResponse): boolean {
    const pending = this.pending.get(response.request_id);
    if (!pending) return false;
    this.pending.delete(response.request_id);
    clearTimeout(pending.timer);
    pending.resolve(response);
    return true;
  }

  /** 取消所有等待中的请求 */
  cancelAll(reason = 'Connection closed'): void {
    this.pending.forEach((pending) => {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    });
    this.pending.clear();
  }

  /** 等待中的请求数量 */
  get pendingCount(): number {
    return this.pending.size;
  }
}

// ─── 工具函数 ───

function makeSuccessResponse(requestId: string, data: Record<string, unknown>): ControlResponseSuccess {
  return {
    type: 'control_response',
    request_id: requestId,
    response: {
      subtype: 'success',
      ...data,
    },
  };
}

function makeErrorResponse(requestId: string, error: string): ControlResponseError {
  return {
    type: 'control_response',
    request_id: requestId,
    response: {
      subtype: 'error',
      error,
    },
  };
}
