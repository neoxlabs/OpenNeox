/**
 * Webhook Channel — 通用 HTTP Webhook 入站
 *
 * 外部系统通过 POST /webhook/webhook 发送消息，
 * 回复通过 response body 返回。
 */

import type { Channel, IncomingMessage, OutgoingMessage, WebhookChannelConfig } from '@neoxlabs/platform/channels/types.js';
import { createHmac } from 'crypto';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

type OnMessage = (msg: IncomingMessage) => Promise<void>;

export class WebhookChannel implements Channel {
  readonly id = 'webhook';
  readonly type = 'webhook' as const;
  enabled: boolean;

  private secret: string | undefined;
  private onMessage: OnMessage;
  /** 存储待回复的 promise resolver */
  private pendingReplies = new Map<string, (reply: string) => void>();

  constructor(config: WebhookChannelConfig, onMessage: OnMessage) {
    this.enabled = config.enabled;
    this.secret = config.secret;
    this.onMessage = onMessage;
  }

  async start(): Promise<void> {
    cliLogger.info('WEBHOOK', 'Webhook channel ready (passive — waits for HTTP requests)');
  }

  async stop(): Promise<void> {
    this.pendingReplies.clear();
  }

  async sendMessage(msg: OutgoingMessage): Promise<void> {
    // Webhook 回复通过 pendingReplies 机制返回
    const resolver = this.pendingReplies.get(msg.chatId);
    if (resolver) {
      resolver(msg.text);
      this.pendingReplies.delete(msg.chatId);
    }
  }

  /**
   * 处理入站 webhook 请求
   * 由 server 路由调用
   *
   * 期望 body 格式:
   * { chatId: string, text: string, from?: { id: string, name: string } }
   */
  async handleIncoming(body: any, signature?: string): Promise<string> {
    // 验证签名
    if (this.secret && signature) {
      const expected = createHmac('sha256', this.secret)
        .update(JSON.stringify(body))
        .digest('hex');
      if (signature !== `sha256=${expected}`) {
        throw new Error('Invalid webhook signature');
      }
    }

    const chatId = body.chatId || `wh-${Date.now()}`;
    const incoming: IncomingMessage = {
      channelId: this.id,
      chatId,
      text: body.text || '',
      from: body.from || { id: 'webhook', name: 'Webhook' },
      timestamp: Date.now(),
      raw: body,
    };

    // 创建回复 promise
    const replyPromise = new Promise<string>((resolve) => {
      this.pendingReplies.set(chatId, resolve);
      // 超时 60s
      setTimeout(() => {
        if (this.pendingReplies.has(chatId)) {
          this.pendingReplies.delete(chatId);
          resolve('[timeout] No response within 60s');
        }
      }, 60000);
    });

    await this.onMessage(incoming);
    return replyPromise;
  }
}
