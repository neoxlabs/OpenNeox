/**
 * Channels — 多渠道消息适配
 */

export { ChannelRegistry, type MessageHandler } from './registry.js';
export type {
  Channel,
  ChannelType,
  ChannelConfig,
  IncomingMessage,
  OutgoingMessage,
  TelegramChannelConfig,
  WebhookChannelConfig,
} from '@neoxlabs/platform/channels/types.js';
export { TelegramChannel } from './telegram.js';
export { WebhookChannel } from './webhook.js';
