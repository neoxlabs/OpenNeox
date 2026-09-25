import type { TTSService } from '../../services/ttsService.js';
import { ProviderFactory } from '../../models/factory.js';
import type { ProviderConfigEntry } from '@neoxlabs/platform/utils/config.js';

type GetProvider = () => ProviderConfigEntry | undefined;

export function ensureTTSSummarizeFn(ttsService: TTSService, getProvider: GetProvider): void {
  /* 网关凭证解析器 —— provider='neoxcloud' 时合成走网关. 幂等可重复设, 放在 summarizeFn
   * 早返之前, 保证 bridge 重新启用 TTS 时云端解析器也始终是最新的. */
  ttsService.setCloudGatewayResolver(() => {
    const p = getProvider();
    return p ? { baseUrl: p.baseUrl, apiKey: p.apiKey } : undefined;
  });

  if (ttsService['summarizeFn']) {
    return;
  }

  ttsService.setSummarizeFn(async (text: string, maxChars: number, model?: string) => {
    const provider = getProvider();
    if (!provider) return text.substring(0, maxChars);
    const adapter = ProviderFactory.createAdapter(provider.protocol, provider);
    const summaryModel = model || 'claude-haiku-4-5-20251001';
    const response = await adapter.chat([
      { role: 'system', content: `你是一个语音摘要助手。把以下内容压缩成${maxChars}字以内的口语化摘要，适合语音朗读。不要用代码、markdown格式、列表。直接说重点。` },
      { role: 'user', content: text },
    ], { model: summaryModel, maxTokens: 300, temperature: 0.3 });
    return response.choices?.[0]?.message?.content || text.substring(0, maxChars);
  });
}

export async function initTTSIfEnabled(
  ttsService: TTSService,
  enabled: boolean,
  getProvider: GetProvider,
): Promise<void> {
  if (!enabled) {
    return;
  }
  ensureTTSSummarizeFn(ttsService, getProvider);
  await ttsService.init();
}
