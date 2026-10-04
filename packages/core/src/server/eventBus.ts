/** Server Event Bus 为 SSE、WebSocket 与进程内客户端分发带序号的事件。 */

import { EventEmitter } from 'events';
import type { AgentRuntimeEvent } from '../runtime/runtimeTypes.js';
import type { RuntimeEventTracker } from '../runtime/runtimeEventHub.js';

// ============================================================================
// Types
// ============================================================================

export interface ServerEvent {
  sessionId: string;
  type: string;
  data: AgentRuntimeEvent;
  tracker?: RuntimeEventTracker;
  timestamp: number;
  /** 全局单调递增序列号 — 断线续传的基础 */
  seq: number;
  /** 事件 UUID — 去重用 */
  uuid?: string;
}

// ============================================================================
// EventBus
// ============================================================================

/** 每个 session 的事件环形缓冲容量 */
const SESSION_BUFFER_CAPACITY = 500;

export class EventBus {
  private emitter = new EventEmitter();
  /** 缓存每个 session 最近的 run_result，用于 SSE 重连时回放 */
  private lastRunResult = new Map<string, ServerEvent>();
  /** 全局单调递增序列号 */
  private globalSeq = 0;
  /** per-session 事件环形缓冲 — 支持 seq-num 续传 */
  private sessionBuffers = new Map<string, ServerEvent[]>();
  /** per-session seq-num 高水位（用于 carryover） */
  private sessionSeqHighWater = new Map<string, number>();

  constructor() {
    // 避免 listener 过多警告（多个 SSE 客户端同时连接）
    this.emitter.setMaxListeners(100);
  }

  /** 获取当前全局 seq */
  get currentSeq(): number {
    return this.globalSeq;
  }

  /**
   * 发布事件（server 内部调用）
   */
  publish(event: Omit<ServerEvent, 'seq'>): void {
    // 分配全局 seq
    this.globalSeq += 1;
    const seqEvent: ServerEvent = { ...event, seq: this.globalSeq };

    //  缓存 run_result 用于客户端重连回放
    if (seqEvent.type === 'run_result') {
      this.lastRunResult.set(seqEvent.sessionId, seqEvent);
      // 30s 后自动清理缓存（run_result 只需要短暂保留供重连回放）
      setTimeout(() => this.lastRunResult.delete(seqEvent.sessionId), 30_000);
    }

    //  写入 session 环形缓冲
    this.pushToBuffer(seqEvent.sessionId, seqEvent);

    //  更新 session seq 高水位
    this.sessionSeqHighWater.set(seqEvent.sessionId, seqEvent.seq);

    /* 子 agent 镜像带 `__subAgentMirror`, sessionId = 子会话 id。
     *
     *  曾经把它排除出 '*' —— CLI Ink 订 '*' 又不按 sessionId 过滤, 镜像
     * 会跟父 timeline 的 taskAgent 事件翻倍, 海量 tool_call_delta ×2 饿死渲染循环。
     * CLI runtimeEvents 现在会跳过 `__subAgentMirror`, 翻倍不再成立。
     *
     *  必须进 '*': 桌面 SSE / LocalRuntimeAdapter 只订 '*', 不订
     * session:<subSid>。排除之后点进子会话只能 1s 拉一次 DB, 输入框没有运行态、
     * 编辑卡是写完才出现的静照, 跟主会话 / 云端直播完全两套。镜像进 '*' 后,
     * renderer 按信封 sessionId 写子会话自己的 timeline, 父卡仍走带 taskAgentId
     * 的那份, 两边不混。 */
    this.emitter.emit('*', seqEvent);
    this.emitter.emit(`session:${seqEvent.sessionId}`, seqEvent);
  }

  /**
   *  获取最近的 run_result（用于 SSE 重连后回放）
   */
  getLastRunResult(sessionId: string): ServerEvent | undefined {
    return this.lastRunResult.get(sessionId);
  }

  /**
   *  获取 session 的 seq-num 高水位
   */
  getSeqHighWater(sessionId: string): number {
    return this.sessionSeqHighWater.get(sessionId) ?? 0;
  }

  /**
   *  从指定 seq-num 之后回放历史事件（断线续传核心）
   * @param sessionId 会话 ID
   * @param fromSeq 从此 seq 之后开始（不包含此 seq）
   * @returns 需要回放的事件列表
   */
  replayFrom(sessionId: string, fromSeq: number): ServerEvent[] {
    const buffer = this.sessionBuffers.get(sessionId);
    if (!buffer || buffer.length === 0) return [];
    return buffer.filter(e => e.seq > fromSeq);
  }

  /**
   * 创建 RuntimeEventSink，桥接 RuntimeEventHub → EventBus
   */
  createSink(name: string = 'server-bus') {
    return {
      name,
      handle: (sessionId: string, event: AgentRuntimeEvent, tracker: RuntimeEventTracker) => {
        this.publish({
          sessionId,
          type: event.type,
          data: event,
          tracker,
          timestamp: event.timestamp ?? Date.now(),
        });
      },
    };
  }

  /**
   * 订阅事件流（SSE 端点用）
   * 返回 AsyncIterable，for-await 消费
   *
   *  新增 fromSeq 参数：从指定 seq 之后开始（断线续传）
   */
  subscribe(
    sessionId?: string,
    fromSeq?: number,
  ): AsyncIterable<ServerEvent> & { close: () => void } {
    const channel = sessionId ? `session:${sessionId}` : '*';
    const emitter = this.emitter;

    let closed = false;
    let resolve: ((v: IteratorResult<ServerEvent>) => void) | null = null;
    const queue: ServerEvent[] = [];
    let lastYieldAt = Date.now(); // 控制连续消费事件时的 macrotask 让出频率

    //  如果指定了 fromSeq，先回放历史
    if (sessionId && fromSeq !== undefined && fromSeq > 0) {
      const replay = this.replayFrom(sessionId, fromSeq);
      queue.push(...replay);
    }

    const handler = (event: ServerEvent) => {
      //  过滤已回放的事件（防止重复）
      if (fromSeq !== undefined && event.seq <= fromSeq) return;

      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ value: event, done: false });
      } else {
        queue.push(event);
      }
    };

    emitter.on(channel, handler);

    const cleanup = () => {
      if (closed) return;
      closed = true;
      emitter.off(channel, handler);
      // 唤醒等待中的 consumer
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ value: undefined as never, done: true });
      }
    };

    const iterable = {
      close: cleanup,

      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<ServerEvent>> {
            /* close 只停止接收新事件；队列非空时先交付，排空后才结束迭代。 */
            if (queue.length > 0) {
              const value = queue.shift()!;
              /* 根治 in-process(方案C) CLI 大 explore UI 冻结 (审计 , 对齐 Claude Code,
               *   按 agent profile 定论改【按时间】让出):队列堆满时连续 drain 只走 microtask(Promise.resolve),
               *   Ink 16ms 渲染节流 + 心跳是 macrotask(timer) → 排在 microtask 后永不 fire → UI 冻结。
               *   按【固定计数】让出对大 tool_output 不稳(32 个大事件之间仍是长同步片); 改成【每同步处理满 4ms
               *   强制 setImmediate 让出一次 macrotask】, 不管事件大小, 保证每 4ms(<半帧 8ms)timer/IO 能插队。 */
              const now = Date.now();
              if (now - lastYieldAt >= 4) {
                lastYieldAt = now;
                return new Promise(r => setImmediate(() => r({ value, done: false })));
              }
              return Promise.resolve({ value, done: false });
            }
            if (closed) {
              return Promise.resolve({ value: undefined as never, done: true });
            }
            return new Promise(r => { resolve = r; });
          },
          return(): Promise<IteratorResult<ServerEvent>> {
            cleanup();
            return Promise.resolve({ value: undefined as never, done: true });
          },
        };
      },
    };

    return iterable;
  }

  /**
   *  清理指定 session 的缓冲
   */
  clearSessionBuffer(sessionId: string): void {
    this.sessionBuffers.delete(sessionId);
    this.sessionSeqHighWater.delete(sessionId);
    this.lastRunResult.delete(sessionId);
  }

  /**
   * 清理
   */
  dispose(): void {
    this.emitter.removeAllListeners();
    this.lastRunResult.clear();
    this.sessionBuffers.clear();
    this.sessionSeqHighWater.clear();
  }

  // ─── 内部 ───

  /** 环形缓冲写入 */
  private pushToBuffer(sessionId: string, event: ServerEvent): void {
    let buffer = this.sessionBuffers.get(sessionId);
    if (!buffer) {
      buffer = [];
      this.sessionBuffers.set(sessionId, buffer);
    }
    buffer.push(event);
    // 超出容量时移除最旧的
    if (buffer.length > SESSION_BUFFER_CAPACITY) {
      buffer.splice(0, buffer.length - SESSION_BUFFER_CAPACITY);
    }
  }
}
