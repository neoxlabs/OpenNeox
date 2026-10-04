import type { ProviderProtocol, ProviderCapability, ProviderChannel } from '@neoxlabs/kernel/types/configTypes.js';

export interface CreateProviderInput {
  /** 可选稳定 id (如 oauth-claude); 不传则按 name 生成 */
  id?: string;
  name: string;
  protocol: ProviderProtocol;
  apiKey: string;
  /** Tab/channels: 每 Tab {apiKey, protocol, models?, baseUrl?} (明文 key)。空/单 = 单 Tab。 */
  channels?: ProviderChannel[];
  baseUrl?: string;
  urlSuffix?: string;
  maxTokens?: number;
  maxInputTokens?: number;
  defaultModel?: string;
  models?: string[];
  setAsDefault?: boolean;
  /** Anthropic 身份策略, 仅 anthropic 协议时生效 (auto/on/off). */
  claudeCodeMode?: 'auto' | 'on' | 'off';
  /** 渠道 (额外协议/模态), 存进 provider.capabilities[]。 */
  capabilities?: ProviderCapability[];
}

export interface UpdateProviderInput {
  name?: string;
  protocol?: ProviderProtocol;
  apiKey?: string;
  /** Tab/channels: 传数组整批替换 (明文 key); 不传保留。 */
  channels?: ProviderChannel[];
  baseUrl?: string;
  urlSuffix?: string;
  maxTokens?: number;
  maxInputTokens?: number;
  defaultModel?: string;
  /* 整批替换 models — Neox Cloud sync 用. 不传则保留原有列表. */
  models?: string[];
  /** Anthropic 身份策略, 仅 anthropic 协议时生效 (auto/on/off). */
  claudeCodeMode?: 'auto' | 'on' | 'off';
  /** 渠道 (额外协议/模态), 整批替换 provider.capabilities[]。 */
  capabilities?: ProviderCapability[];
}

export interface FetchProviderModelsRequest {
  protocol: ProviderProtocol;
  baseUrl?: string;
  urlSuffix?: string;
  apiKey: string;
}

export interface FetchProviderModelsResult {
  models: string[];
  sourceUrl?: string;
  error?: string;
}
