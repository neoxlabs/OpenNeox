
import { randomUUID } from 'crypto';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

// ─── 类型定义 ───

export type SessionStatus = 'active' | 'paused' | 'archived' | 'expired';

export interface SessionMetadata {
  /** 服务端分配的会话 ID */
  id: string;
  /** 人类可读的标题 */
  title?: string;
  /** 创建时间 */
  createdAt: number;
  /** 最后活跃时间 */
  lastActiveAt: number;
  /** 当前状态 */
  status: SessionStatus;
  /** 当前 epoch — 每次重连 +1 */
  epoch: number;
  /** 创建该会话的设备 ID */
  ownerDeviceId: string;
  /** 订阅该会话事件的设备 ID 集合 */
  subscribers: Set<string>;
  /** 工作目录 */
  workDir?: string;
  /** Git 分支 */
  gitBranch?: string;
  /** 模式 */
  mode?: string;
  /** 统计 */
  stats: SessionStats;
}

export interface SessionStats {
  messageCount: number;
  eventCount: number;
  toolCallCount: number;
  /** 当前 seq-num 高水位 */
  lastSeqNum: number;
}

export interface CreateSessionOptions {
  title?: string;
  ownerDeviceId: string;
  workDir?: string;
  gitBranch?: string;
  mode?: string;
}

export interface SessionSnapshot {
  id: string;
  title?: string;
  status: SessionStatus;
  epoch: number;
  ownerDeviceId: string;
  subscriberCount: number;
  createdAt: number;
  lastActiveAt: number;
  stats: SessionStats;
  mode?: string;
}

// ─── 刷新调度器 ───

export interface TokenRefreshSchedule {
  sessionId: string;
  refreshAt: number;
  timer: ReturnType<typeof setTimeout>;
}

export type TokenRefreshCallback = (sessionId: string) => Promise<void>;

// ─── SessionManager ───

export class SessionManager {
  private sessions = new Map<string, SessionMetadata>();
  private refreshSchedules = new Map<string, TokenRefreshSchedule>();
  private onTokenRefresh?: TokenRefreshCallback;

  /** 最大会话数 */
  private maxSessions: number;
  /** 会话过期时间（毫秒） */
  private sessionTTL: number;

  constructor(options?: {
    maxSessions?: number;
    sessionTTL?: number;
    onTokenRefresh?: TokenRefreshCallback;
  }) {
    this.maxSessions = options?.maxSessions ?? 100;
    this.sessionTTL = options?.sessionTTL ?? 24 * 60 * 60 * 1000; // 24h
    this.onTokenRefresh = options?.onTokenRefresh;
  }

  // ─── 创建 ───

  create(options: CreateSessionOptions): SessionMetadata {
    // 容量检查
    if (this.sessions.size >= this.maxSessions) {
      this.evictExpired();
      if (this.sessions.size >= this.maxSessions) {
        throw new Error(`Max sessions reached (${this.maxSessions})`);
      }
    }

    const now = Date.now();
    const session: SessionMetadata = {
      id: `nxs_${randomUUID().replace(/-/g, '')}`,
      title: options.title,
      createdAt: now,
      lastActiveAt: now,
      status: 'active',
      epoch: 1,
      ownerDeviceId: options.ownerDeviceId,
      subscribers: new Set([options.ownerDeviceId]),
      workDir: options.workDir,
      gitBranch: options.gitBranch,
      mode: options.mode,
      stats: {
        messageCount: 0,
        eventCount: 0,
        toolCallCount: 0,
        lastSeqNum: 0,
      },
    };

    this.sessions.set(session.id, session);
    return session;
  }

  // ─── 查询 ───

  get(sessionId: string): SessionMetadata | undefined {
    return this.sessions.get(sessionId);
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  list(filter?: { status?: SessionStatus; deviceId?: string }): SessionSnapshot[] {
    const result: SessionSnapshot[] = [];
    this.sessions.forEach((session) => {
      if (filter?.status && session.status !== filter.status) return;
      if (filter?.deviceId && !session.subscribers.has(filter.deviceId)) return;
      result.push(this.toSnapshot(session));
    });
    return result.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }

  /** 获取活跃会话数 */
  get activeCount(): number {
    let count = 0;
    this.sessions.forEach((s) => { if (s.status === 'active') count++; });
    return count;
  }

  // ─── 活跃更新 ───

  touch(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActiveAt = Date.now();
    }
  }

  /** 记录消息/事件/工具调用统计 */
  recordStat(sessionId: string, type: 'message' | 'event' | 'toolCall', count = 1): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.lastActiveAt = Date.now();
    switch (type) {
      case 'message': session.stats.messageCount += count; break;
      case 'event': session.stats.eventCount += count; break;
      case 'toolCall': session.stats.toolCallCount += count; break;
    }
  }

  /** 更新 seq-num 高水位 */
  updateSeqNum(sessionId: string, seqNum: number): void {
    const session = this.sessions.get(sessionId);
    if (session && seqNum > session.stats.lastSeqNum) {
      session.stats.lastSeqNum = seqNum;
    }
  }

  // ─── Epoch 版本化 ───

  /**
   * Bump epoch — 重连时调用。
   * @returns 新 epoch 值
   */
  bumpEpoch(sessionId: string): number {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    session.epoch += 1;
    session.lastActiveAt = Date.now();
    return session.epoch;
  }

  /**
   * 验证 epoch — 旧 worker 请求应被拒绝。
   * @returns true 如果 epoch 匹配
   */
  validateEpoch(sessionId: string, epoch: number): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    return session.epoch === epoch;
  }

  // ─── 订阅管理 ───

  subscribe(sessionId: string, deviceId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'active') return false;
    session.subscribers.add(deviceId);
    return true;
  }

  unsubscribe(sessionId: string, deviceId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.subscribers.delete(deviceId);
    }
  }

  /** 设备断开时清理其所有订阅 */
  removeDevice(deviceId: string): void {
    this.sessions.forEach((session) => {
      session.subscribers.delete(deviceId);
    });
  }

  // ─── 生命周期 ───

  pause(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'active') return false;
    session.status = 'paused';
    return true;
  }

  resume(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'paused') return false;
    session.status = 'active';
    session.lastActiveAt = Date.now();
    return true;
  }

  archive(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.status = 'archived';
    this.cancelRefresh(sessionId);
    return true;
  }

  destroy(sessionId: string): boolean {
    this.cancelRefresh(sessionId);
    return this.sessions.delete(sessionId);
  }

  // ─── Token 主动刷新 ───

  scheduleTokenRefresh(
    sessionId: string,
    expiresInMs: number,
    bufferMs = 5 * 60 * 1000,
  ): void {
    this.cancelRefresh(sessionId);
    if (!this.onTokenRefresh) return;

    const refreshAt = Date.now() + Math.max(0, expiresInMs - bufferMs);
    const delay = Math.max(0, expiresInMs - bufferMs);

    const timer = setTimeout(async () => {
      this.refreshSchedules.delete(sessionId);
      try {
        await this.onTokenRefresh!(sessionId);
      } catch (err: any) {
        cliLogger.debug('SESSION', `Token refresh failed for ${sessionId}: ${err?.message}`);
      }
    }, delay);

    // 防止 timer 阻止进程退出
    if (timer.unref) timer.unref();

    this.refreshSchedules.set(sessionId, { sessionId, refreshAt, timer });
  }

  private cancelRefresh(sessionId: string): void {
    const schedule = this.refreshSchedules.get(sessionId);
    if (schedule) {
      clearTimeout(schedule.timer);
      this.refreshSchedules.delete(sessionId);
    }
  }

  // ─── 清理 ───

  /** 驱逐过期会话 */
  evictExpired(): number {
    const now = Date.now();
    let evicted = 0;
    const toRemove: string[] = [];
    this.sessions.forEach((session, id) => {
      if (now - session.lastActiveAt > this.sessionTTL) {
        toRemove.push(id);
      }
    });
    for (const id of toRemove) {
      this.archive(id);
      this.sessions.delete(id);
      evicted++;
    }
    return evicted;
  }

  /** 销毁所有会话和定时器 */
  dispose(): void {
    this.refreshSchedules.forEach((schedule) => clearTimeout(schedule.timer));
    this.refreshSchedules.clear();
    this.sessions.clear();
  }

  // ─── 工具 ───

  private toSnapshot(session: SessionMetadata): SessionSnapshot {
    return {
      id: session.id,
      title: session.title,
      status: session.status,
      epoch: session.epoch,
      ownerDeviceId: session.ownerDeviceId,
      subscriberCount: session.subscribers.size,
      createdAt: session.createdAt,
      lastActiveAt: session.lastActiveAt,
      stats: { ...session.stats },
      mode: session.mode,
    };
  }
}
