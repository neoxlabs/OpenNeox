/**
 * Telegram Bot Channel — 长轮询模式
 */

import type { Channel, IncomingMessage, OutgoingMessage, TelegramChannelConfig } from '@neoxlabs/platform/channels/types.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

type OnMessage = (msg: IncomingMessage) => Promise<void>;

export class TelegramChannel implements Channel {
  readonly id = 'telegram';
  readonly type = 'telegram' as const;
  enabled: boolean;

  private token: string;
  private allowedChatIds: Set<string>;
  private pollingInterval: number;
  private offset = 0;
  private polling = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private onMessage: OnMessage;

  constructor(config: TelegramChannelConfig, onMessage: OnMessage) {
    this.enabled = config.enabled;
    this.token = config.botToken;
    this.allowedChatIds = new Set(config.allowedChatIds ?? []);
    this.pollingInterval = config.pollingInterval ?? 3000;
    this.onMessage = onMessage;
  }

  async start(): Promise<void> {
    this.polling = true;
    this.poll();
    cliLogger.info('TELEGRAM', 'Polling started');
  }

  async stop(): Promise<void> {
    this.polling = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    cliLogger.info('TELEGRAM', 'Polling stopped');
  }

  async sendMessage(msg: OutgoingMessage): Promise<void> {
    const url = `https://api.telegram.org/bot${this.token}/sendMessage`;
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: msg.chatId,
          text: msg.text,
          parse_mode: msg.format === 'markdown' ? 'MarkdownV2' : msg.format === 'html' ? 'HTML' : undefined,
        }),
      });
    } catch (e: any) {
      cliLogger.error('TELEGRAM', `sendMessage failed: ${e.message}`);
    }
  }

  private async poll(): Promise<void> {
    if (!this.polling) return;

    try {
      const url = `https://api.telegram.org/bot${this.token}/getUpdates?offset=${this.offset}&timeout=30`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 35000);

      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      if (res.ok) {
        const data = await res.json() as any;
        if (data.ok && Array.isArray(data.result)) {
          for (const update of data.result) {
            this.offset = update.update_id + 1;
            await this.handleUpdate(update);
          }
        }
      }
    } catch (e: any) {
      if (e.name !== 'AbortError') {
        cliLogger.error('TELEGRAM', `Poll error: ${e.message}`);
      }
    }

    if (this.polling) {
      this.timer = setTimeout(() => this.poll(), this.pollingInterval);
    }
  }

  private async handleUpdate(update: any): Promise<void> {
    const message = update.message;
    if (!message?.text) return;

    const chatId = String(message.chat.id);

    // 检查白名单
    if (this.allowedChatIds.size > 0 && !this.allowedChatIds.has(chatId)) {
      cliLogger.warn('TELEGRAM', `Rejected message from unauthorized chat: ${chatId}`);
      return;
    }

    const incoming: IncomingMessage = {
      channelId: this.id,
      chatId,
      text: message.text,
      from: {
        id: String(message.from?.id ?? 'unknown'),
        name: message.from?.first_name ?? 'Unknown',
      },
      timestamp: message.date * 1000,
      raw: update,
    };

    await this.onMessage(incoming);
  }
}
