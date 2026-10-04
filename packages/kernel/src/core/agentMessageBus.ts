/**
 * AgentMessageBus — agent 间消息队列 (P0-2 Multi-agent)
 *
 * 痛点: Neox explore 子 agent 完成后通过 return value 把 result 给主 agent, 这是
 *   一次性单向. 没有"sub-agent 跑到一半给主或 sibling 发消息" 的能力.
 *
 * 设计: 每个 agent 一个 inbox (FIFO 队列). send(from, to, payload) 入队,
 *   receive(to) 取走所有 pending message + 清 inbox. peek 看不清.
 *
 * 跟 AgentRegistry 配套用 — Registry 知道"谁在线", Bus 负责"传消息".
 *
 * 投递语义:
 *   - to 必须是已 registerInbox 的 sessionId, 否则 send 报错 (避免静默丢消息)
 *   - inbox 是 FIFO + 持久化于内存, 直到 receive 被调
 *   - 顺序: send 调用顺序 = receive 拿到的顺序
 *   - shutdown 协议: messageType='shutdown', 接收方读到后该优雅退出
 */

/* 'progress' / 'blocker' (Team P1 §3.4): report_to_conductor 的上报类别 —
 *   成员 agent 向 Conductor 单向上报进度/阻塞, runner 注入 reminder 时作 role 属性。 */
export type MessageType = 'task' | 'result' | 'question' | 'shutdown' | 'info' | 'progress' | 'blocker';

export interface AgentMessage {
  /** 全局唯一 id (timestamp-counter 拼接) */
  id: string;
  /** 发送方 sessionId */
  fromSessionId: string;
  /** 发送方 agent name (sender 给 UI 显示用) */
  fromAgentName: string;
  /** 接收方 sessionId */
  toSessionId: string;
  /** 消息类型 — task / result / question / shutdown / info */
  messageType: MessageType;
  /** 消息正文 (markdown / 任意 string) */
  payload: string;
  /** 时间戳 (Date.now()) */
  timestamp: number;
}

class AgentMessageBusImpl {
  private inboxes = new Map<string, AgentMessage[]>();
  private msgCounter = 0;

  /**
   * 给 sessionId 创建 inbox. 已存在则 no-op.
   *   必须先 register 才能接收消息, 否则 send 会报"无 inbox".
   *   通常 agent 启动时调.
   */
  registerInbox(sessionId: string): void {
    if (!this.inboxes.has(sessionId)) {
      this.inboxes.set(sessionId, []);
    }
  }

  /**
   * 删 inbox. 未读消息一起丢弃 (生产中应先 receive 处理).
   *   通常 agent 退出时调.
   */
  unregisterInbox(sessionId: string): void {
    this.inboxes.delete(sessionId);
  }

  /**
   * 发消息. 返消息 id. 抛错:
   *   - 接收方 inbox 不存在 (没 register / agent 已退出)
   *   - payload 空字符串
   *
   * 不抛错: from === to (允许 self-message, 可作 reminder 用)
   */
  send(input: {
    fromSessionId: string;
    fromAgentName: string;
    toSessionId: string;
    messageType?: MessageType;
    payload: string;
  }): string {
    if (!input.payload || !input.payload.trim()) {
      throw new Error('AgentMessageBus.send: payload 不能为空');
    }
    const inbox = this.inboxes.get(input.toSessionId);
    if (!inbox) {
      throw new Error(
        `AgentMessageBus.send: 接收方 ${input.toSessionId} 没有 inbox (未 register / 已退出)`
      );
    }
    this.msgCounter += 1;
    const id = `msg-${Date.now()}-${this.msgCounter}`;
    const msg: AgentMessage = {
      id,
      fromSessionId: input.fromSessionId,
      fromAgentName: input.fromAgentName,
      toSessionId: input.toSessionId,
      messageType: input.messageType ?? 'info',
      payload: input.payload,
      timestamp: Date.now(),
    };
    inbox.push(msg);
    return id;
  }

  /**
   * 拿所有 pending message + 清 inbox. 不存在 inbox 返空数组.
   *
   * 一次性消费语义: 同一条消息只被 receive 一次. 多次调返空 (除非新 send).
   */
  receive(sessionId: string): AgentMessage[] {
    const inbox = this.inboxes.get(sessionId);
    if (!inbox || inbox.length === 0) return [];
    const messages = [...inbox];
    inbox.length = 0;
    return messages;
  }

  /**
   * 看 inbox 不清 — 用于检测 "我有没有 unread", 不打算处理 (例如 system reminder 注入).
   */
  peek(sessionId: string): AgentMessage[] {
    const inbox = this.inboxes.get(sessionId);
    if (!inbox) return [];
    return [...inbox];
  }

  /** 快速判 inbox 有无 unread, 不构造数组 */
  hasMessages(sessionId: string): boolean {
    const inbox = this.inboxes.get(sessionId);
    return !!inbox && inbox.length > 0;
  }

  /** 强清单个 inbox (不删 inbox 本身) */
  clear(sessionId: string): void {
    const inbox = this.inboxes.get(sessionId);
    if (inbox) inbox.length = 0;
  }

  /** 全清 — 主要 test 用 */
  clearAll(): void {
    this.inboxes.clear();
    this.msgCounter = 0;
  }

  /** 统计 — 诊断用 */
  inboxCount(): number {
    return this.inboxes.size;
  }

  totalPending(): number {
    let total = 0;
    for (const inbox of this.inboxes.values()) total += inbox.length;
    return total;
  }
}

/* 全局单例 */
export const agentMessageBus = new AgentMessageBusImpl();

/** 测试用 — 独立实例避免污染全局 */
export function createAgentMessageBus(): AgentMessageBusImpl {
  return new AgentMessageBusImpl();
}

export type AgentMessageBus = AgentMessageBusImpl;
