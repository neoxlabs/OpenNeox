/**
 * RuntimeAdapter — CLI/Electron 与 Runtime 之间的抽象层
 *
 * 两种实现：
 * - LocalRuntimeAdapter: 直接调用 runtime（当前行为，过渡期保留）
 * - RemoteRuntimeAdapter: 通过 NeoxClient SDK 调用 server
 */

import type { AgentRuntimeEvent } from '../runtime/runtimeTypes.js';
import type { RuntimeEventTracker } from '../runtime/runtimeEventHub.js';
import type { HostAttachment } from '../runtime/runtimeTypes.js';
import type { ModelRouteConfig } from '@neoxlabs/platform/utils/config.js';

// ============================================================================
// Types
// ============================================================================

export type RuntimeEventCallback = (
  event: AgentRuntimeEvent,
  tracker: RuntimeEventTracker,
) => void;

export interface AdapterChatRequest {
  sessionId: string;
  prompt: string;
  mode: string;
  attachments?: HostAttachment[];
  providerId?: string;
  modelName?: string;
  isAutoRouted?: boolean;
  routeConfig?: ModelRouteConfig;
  effortLevel?: string;
}

export interface AdapterStatus {
  isRunning: boolean;
  mode: string;
  activeSessions: string[];
}

// ============================================================================
// Interface
// ============================================================================

export interface RuntimeAdapter {
  /** 发送聊天消息 */
  chat(request: AdapterChatRequest): Promise<void>;

  /** 中断当前执行 */
  abort(sessionId: string): void;

  /** 注入消息（任务运行中追加） */
  injectMessage(sessionId: string, message: string, images?: Array<{ mediaType: string; data: string; name?: string }>): void;

  /** 订阅 runtime 事件 */
  onEvent(callback: RuntimeEventCallback): void;

  /** 移除事件监听 */
  offEvent(callback: RuntimeEventCallback): void;

  /** 切换运行模式 */
  setRunMode(mode: string): void;

  /** 获取当前运行模式 */
  getRunMode(): string;

  /** 获取状态 */
  getStatus(): AdapterStatus;

  /** 清理资源 */
  dispose(): void;
}
