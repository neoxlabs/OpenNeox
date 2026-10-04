/**
 * Channel Registry — 管理所有 channel 适配器
 */

import type { Channel, IncomingMessage, ChannelConfig } from '@neoxlabs/platform/channels/types.js';
import { TelegramChannel } from './telegram.js';
import { WebhookChannel } from './webhook.js';
import { GithubChannel } from './github.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

export type MessageHandler = (msg: IncomingMessage) => Promise<string>;

export class ChannelRegistry {
  private channels = new Map<string, Channel>();
  private handler: MessageHandler | null = null;

  /** 设置消息处理器（连接到 RuntimeBridge） */
  setHandler(handler: MessageHandler): void {
    this.handler = handler;
  }

  /** 根据配置初始化所有 channel */
  async initialize(config: ChannelConfig): Promise<void> {
    if (config.telegram?.enabled && config.telegram.botToken) {
      const tg = new TelegramChannel(config.telegram, (msg) => this.onMessage(msg));
      this.channels.set(tg.id, tg);
    }

    if (config.webhook?.enabled) {
      const wh = new WebhookChannel(config.webhook, (msg) => this.onMessage(msg));
      this.channels.set(wh.id, wh);
    }

    /* GitHub 总是建 (没配 = 关着): 它每次轮询前从盘上重读配置, 设置页打开开关就生效, 不用重启。 */
    const gh = new GithubChannel(config.github ?? { enabled: false }, (msg) => this.onMessage(msg));
    this.channels.set(gh.id, gh);
  }

  /** 启动所有已启用的 channel */
  async startAll(): Promise<void> {
    for (const [id, ch] of this.channels) {
      /* github 关着也要起轮询循环 —— 循环里才能看到用户后来把开关打开 */
      if (ch.enabled || ch.type === 'github') {
        try {
          await ch.start();
          cliLogger.info('CHANNEL', `Started channel: ${id}`);
        } catch (e: any) {
          cliLogger.error('CHANNEL', `Failed to start ${id}: ${e.message}`);
        }
      }
    }
  }

  /** 停止所有 channel */
  async stopAll(): Promise<void> {
    for (const [id, ch] of this.channels) {
      try {
        await ch.stop();
        cliLogger.info('CHANNEL', `Stopped channel: ${id}`);
      } catch (e: any) {
        cliLogger.error('CHANNEL', `Failed to stop ${id}: ${e.message}`);
      }
    }
  }

  /** 获取指定 channel */
  get(id: string): Channel | undefined {
    return this.channels.get(id);
  }

  /** 列出所有 channel */
  list(): Array<{ id: string; type: string; enabled: boolean }> {
    return Array.from(this.channels.values()).map(ch => ({
      id: ch.id,
      type: ch.type,
      enabled: ch.enabled,
    }));
  }

  /** 切换 channel 启用状态 */
  async toggle(id: string, enabled: boolean): Promise<boolean> {
    const ch = this.channels.get(id);
    if (!ch) return false;
    if (enabled && !ch.enabled) {
      ch.enabled = true;
      await ch.start();
    } else if (!enabled && ch.enabled) {
      await ch.stop();
      ch.enabled = false;
    }
    return true;
  }

  /** 处理 webhook 入站消息（由 HTTP 路由调用） */
  async handleWebhook(
    channelId: string,
    body: any,
    meta?: { signature?: string; rawBody?: string; event?: string },
  ): Promise<string | null> {
    const ch = this.channels.get(channelId);
    if (!ch || !ch.enabled) return null;
    if (ch.type === 'webhook' && 'handleIncoming' in ch) {
      return (ch as WebhookChannel).handleIncoming(body, meta?.signature);
    }
    if (ch.type === 'github') {
      /* GitHub 的签名是对**原始字节**算的, 必须用 rawBody; 没拿到原文就不校验 = 不收 */
      return (ch as GithubChannel).handleIncoming(meta?.rawBody ?? JSON.stringify(body), { signature: meta?.signature, event: meta?.event });
    }
    return null;
  }

  private async onMessage(msg: IncomingMessage): Promise<void> {
    if (!this.handler) {
      cliLogger.warn('CHANNEL', 'No message handler set, dropping message');
      return;
    }
    try {
      const reply = await this.handler(msg);
      const ch = this.channels.get(msg.channelId);
      if (ch) {
        await ch.sendMessage({ chatId: msg.chatId, text: reply });
      }
    } catch (e: any) {
      cliLogger.error('CHANNEL', `Handler error: ${e.message}`);
    }
  }
}
