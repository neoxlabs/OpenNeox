import type { RuntimeBridge } from '../index.js';
import type { ProviderConfigEntry, STTConfig } from '@neoxlabs/platform/utils/config.js';
import { transcribeViaGateway } from '../../services/sttService.js';

type STTBridgeMethods = Pick<RuntimeBridge, 'transcribeAudio'>;

interface CreateSTTBridgeHandlersOptions {
  /** chat 路径同一份 gateway entry (订阅用户即网关 baseUrl + nxk). */
  defaultProvider?: ProviderConfigEntry;
  sttConfig?: STTConfig;
}

export function createSTTBridgeHandlers(options: CreateSTTBridgeHandlersOptions): STTBridgeMethods {
  const { defaultProvider, sttConfig } = options;

  return {
    async transcribeAudio(audioBase64: string, format?: string): Promise<{ text: string }> {
      const baseUrl = defaultProvider?.baseUrl;
      const apiKey = defaultProvider?.apiKey;
      if (!baseUrl || !apiKey) {
        throw new Error('语音识别需要登录 NeoxCloud 订阅 (网关凭证缺失)');
      }
      const text = await transcribeViaGateway(
        { baseUrl, apiKey },
        audioBase64,
        {
          model: sttConfig?.model || 'doubao-asr',
          format: format || 'wav',
          language: sttConfig?.language,
        },
      );
      return { text };
    },
  };
}
