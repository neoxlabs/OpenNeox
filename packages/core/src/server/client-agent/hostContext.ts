/**
 * Host Context - 宿主上下文封装
 *
 * 提供对 Neox CLI 主 Runtime 的只读访问和有限控制能力
 */

import type { AgentRuntimeHost } from '@neoxlabs/core/runtime/agentRuntimeHost.js';
import type { DefaultSessionManager } from '@neoxlabs/core/memory/session-manager.js';
import type {
  HostStatus,
  AgentInfo,
  ActivityRecord,
  SessionInfo,
  SystemInfo,
  AgentMode,
  HostEventType,
} from './protocol.js';

export interface HostContextOptions {
  runtimeHost: AgentRuntimeHost | null;
  sessionManager: DefaultSessionManager;
  version: string;
  workingDirectory: string;
}

type HostRuntimeFacade = {
  isExecuting?: () => boolean;
  getCurrentTask?: () => string | null;
  getMode?: () => AgentMode;
  getSessionId?: () => string;
  getMemorySnapshot?: () => { tokensUsed?: number; contextWindow?: number } | null;
  getCurrentTool?: () => string | null;
  getProgress?: () => number;
  getCurrentTaskId?: () => string | undefined;
  interrupt?: () => void;
};

/**
 * 宿主上下文
 *
 * 封装对主 Runtime 的访问，提供给 Client Agent 使用
 */
export class HostContext {
  private runtimeHost: AgentRuntimeHost | null;
  private sessionManager: DefaultSessionManager;
  private version: string;
  private workingDirectory: string;
  private startTime: number;
  private activityLog: ActivityRecord[] = [];
  private maxActivityLog = 100;

  // 事件订阅
  private eventSubscribers = new Map<string, Set<HostEventType>>();
  private eventCallbacks = new Map<string, (event: { type: HostEventType; data: unknown }) => void>();

  constructor(options: HostContextOptions) {
    this.runtimeHost = options.runtimeHost;
    this.sessionManager = options.sessionManager;
    this.version = options.version;
    this.workingDirectory = options.workingDirectory;
    this.startTime = Date.now();
  }

  /**
   * 更新 Runtime Host 引用
   */
  setRuntimeHost(host: AgentRuntimeHost | null): void {
    this.runtimeHost = host;
  }

  /**
   * 记录活动
   */
  logActivity(type: ActivityRecord['type'], summary: string, details?: unknown): void {
    this.activityLog.unshift({
      timestamp: Date.now(),
      type,
      summary,
      details,
    });

    // 限制日志大小
    if (this.activityLog.length > this.maxActivityLog) {
      this.activityLog.pop();
    }

    // 广播事件
    this.broadcastEvent(type as HostEventType, { summary, details });
  }

  /**
   * 广播事件给订阅者
   */
  broadcastEvent(type: HostEventType, data: unknown): void {
    for (const [clientId, events] of this.eventSubscribers) {
      if (events.has('*') || events.has(type)) {
        const callback = this.eventCallbacks.get(clientId);
        if (callback) {
          callback({ type, data });
        }
      }
    }
  }

  // ==================== Host Introspection API ====================

  /**
   * 获取宿主状态
   */
  async getStatus(): Promise<HostStatus> {
    const host = this.runtimeHost as unknown as HostRuntimeFacade | null;
    const isRunning = host?.isExecuting?.() ?? false;
    const currentTask = host?.getCurrentTask?.() ?? null;
    const mode = (host?.getMode?.() ?? 'agentic') as AgentMode;
    const sessionId = host?.getSessionId?.() ?? '';

    // 内存使用情况
    const memorySnapshot = host?.getMemorySnapshot?.();
    const tokensUsed = memorySnapshot?.tokensUsed ?? 0;
    const contextWindow = memorySnapshot?.contextWindow ?? 128000;
    const pressure = contextWindow > 0 ? tokensUsed / contextWindow : 0;

    return {
      isRunning,
      currentTask,
      mode,
      sessionId,
      workingDirectory: this.workingDirectory,
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      memoryUsage: {
        tokensUsed,
        contextWindow,
        pressure,
      },
    };
  }

  /**
   * 获取运行中的 Agent 列表
   */
  async getAgents(): Promise<AgentInfo[]> {
    const agents: AgentInfo[] = [];
    const host = this.runtimeHost as unknown as HostRuntimeFacade | null;

    // 主 Agent
    if (host) {
      agents.push({
        id: 'main',
        role: 'main',
        status: host.isExecuting?.() ? 'running' : 'idle',
        currentTool: host.getCurrentTool?.() ?? null,
        progress: host.getProgress?.() ?? 0,
        startedAt: this.startTime,
      });
    }

    return agents;
  }

  /**
   * 获取最近活动
   */
  async getActivity(limit = 10): Promise<ActivityRecord[]> {
    return this.activityLog.slice(0, limit);
  }

  /**
   * 获取会话信息
   */
  async getSession(): Promise<SessionInfo> {
    const session = await this.sessionManager.getMostRecent();

    if (!session) {
      return {
        sessionId: '',
        messageCount: 0,
        tokensUsed: 0,
        lastUserMessage: '',
        lastAssistantSummary: '',
        checkpoints: 0,
      };
    }

    const messages = await session.getMessages();
    const userMessages = messages.filter((m: any) => m.role === 'user');
    const assistantMessages = messages.filter((m: any) => m.role === 'assistant');

    const lastUserMessage = userMessages[userMessages.length - 1]?.content ?? '';
    const lastAssistantMessage = assistantMessages[assistantMessages.length - 1]?.content ?? '';

    // 截取摘要
    const lastAssistantSummary = typeof lastAssistantMessage === 'string'
      ? lastAssistantMessage.slice(0, 200)
      : '';

    let tokensUsed = 0;
    let checkpoints = 0;
    try {
      const { tokenUsageService } = await import('@neoxlabs/platform/platform/tokenUsageService.js');
      const stats = await tokenUsageService.getSummary();
      tokensUsed = stats?.totalTokens ?? 0;
    } catch { /* non-critical */ }
    try {
      const { getDatabase } = await import('@neoxlabs/platform/platform/database.js');
      const db = getDatabase();
      const rows = (db as any).getRawDb?.()
        ?.prepare('SELECT COUNT(*) as cnt FROM checkpoints WHERE session_id = ?')
        ?.get(session.sessionId);
      checkpoints = rows?.cnt ?? 0;
    } catch { /* checkpoint table may not exist */ }

    return {
      sessionId: session.sessionId,
      messageCount: messages.length,
      tokensUsed,
      lastUserMessage: typeof lastUserMessage === 'string' ? lastUserMessage : '',
      lastAssistantSummary,
      checkpoints,
    };
  }

  /**
   * 获取系统信息
   */
  async getSystem(): Promise<SystemInfo> {
    let gitBranch: string | null = null;
    let gitStatus: 'clean' | 'dirty' | 'unknown' = 'unknown';

    try {
      const { execSync } = await import('child_process');

      // 获取 git branch
      try {
        gitBranch = execSync('git rev-parse --abbrev-ref HEAD', {
          cwd: this.workingDirectory,
          encoding: 'utf-8',
          timeout: 5000,
        }).trim();
      } catch {
        gitBranch = null;
      }

      // 获取 git status
      try {
        const status = execSync('git status --porcelain', {
          cwd: this.workingDirectory,
          encoding: 'utf-8',
          timeout: 5000,
        }).trim();
        gitStatus = status.length === 0 ? 'clean' : 'dirty';
      } catch {
        gitStatus = 'unknown';
      }
    } catch {
      // ignore
    }

    return {
      platform: process.platform,
      arch: process.arch,
      cwd: this.workingDirectory,
      gitBranch,
      gitStatus,
      nodeVersion: process.version,
      neoxVersion: this.version,
    };
  }

  /**
   * 中断当前任务
   */
  async interrupt(reason?: string): Promise<{ interrupted: boolean; taskId?: string }> {
    if (!this.runtimeHost) {
      return { interrupted: false };
    }

    const host = this.runtimeHost as unknown as HostRuntimeFacade;
    const taskId = host.getCurrentTaskId?.();
    /* 宿主没有 interrupt 就是没打断, 不能报成功 */
    if (typeof host.interrupt !== 'function') return { interrupted: false, taskId };

    try {
      host.interrupt();
      this.logActivity('message', `Task interrupted${reason ? `: ${reason}` : ''}`, { taskId, reason });
      return { interrupted: true, taskId };
    } catch {
      return { interrupted: false };
    }
  }

  /**
   * 发送命令到主 Agent
   */
  async sendCommand(
    text: string,
    priority: 'normal' | 'high' = 'normal'
  ): Promise<{ queued: boolean; position: number; estimatedWait?: number; error?: string }> {
    this.logActivity('message', `Command rejected (no command queue): ${text.slice(0, 50)}`, { text, priority });
    return { queued: false, position: 0, error: 'unsupported: this host has no command queue' };
  }

  /**
   * 订阅事件
   */
  subscribe(
    clientId: string,
    events: HostEventType[],
    callback: (event: { type: HostEventType; data: unknown }) => void
  ): string {
    const subscriptionId = `${clientId}-${Date.now()}`;

    if (!this.eventSubscribers.has(clientId)) {
      this.eventSubscribers.set(clientId, new Set());
    }

    const clientEvents = this.eventSubscribers.get(clientId)!;
    events.forEach(e => clientEvents.add(e));

    this.eventCallbacks.set(clientId, callback);

    return subscriptionId;
  }

  /**
   * 取消订阅
   */
  unsubscribe(clientId: string, events?: HostEventType[]): boolean {
    if (!this.eventSubscribers.has(clientId)) {
      return false;
    }

    if (events) {
      const clientEvents = this.eventSubscribers.get(clientId)!;
      events.forEach(e => clientEvents.delete(e));
    } else {
      this.eventSubscribers.delete(clientId);
      this.eventCallbacks.delete(clientId);
    }

    return true;
  }

  /**
   * 清理客户端订阅
   */
  cleanupClient(clientId: string): void {
    this.eventSubscribers.delete(clientId);
    this.eventCallbacks.delete(clientId);
  }
}
