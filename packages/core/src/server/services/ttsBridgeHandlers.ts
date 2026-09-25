import type { RuntimeBridge } from '../index.js';
import type { TTSService } from '../../services/ttsService.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import type { ProviderConfigEntry } from '@neoxlabs/platform/utils/config.js';
import { ensureTTSSummarizeFn } from './ttsSetup.js';

type TTSBridgeMethods = Pick<
  RuntimeBridge,
  'setTTSEnabled' | 'isTTSEnabled' | 'getTTSConfig' | 'updateTTSConfig' | 'speakTTS'
>;

interface CreateTTSBridgeHandlersOptions {
  ttsService: TTSService;
  defaultProvider?: ProviderConfigEntry;
  initialTTSConfig: any;
}

export function createTTSBridgeHandlers(options: CreateTTSBridgeHandlersOptions): TTSBridgeMethods {
  const { ttsService, defaultProvider, initialTTSConfig } = options;

  return {
    setTTSEnabled(enabled: boolean) {
      const wasEnabled = ttsService.isEnabled();
      /* 只切 enabled, 不再硬写 provider:'edge' —— 否则会覆盖用户在设置里选的 neoxcloud/openai.
       * 未配置 provider 时 init() 内部 `|| 'edge'` 兜底, 行为不变. */
      ttsService.updateConfig({ enabled });
      if (enabled && !wasEnabled) {
        ensureTTSSummarizeFn(ttsService, () => defaultProvider);
        ttsService.init().catch(err => {
          cliLogger.error('SERVER', `TTS init failed: ${err.message}`);
        });
      }
      cliLogger.info('SERVER', `TTS ${enabled ? 'enabled' : 'disabled'}`);
    },

    isTTSEnabled() {
      return ttsService.isEnabled();
    },

    getTTSConfig() {
      return initialTTSConfig ?? { enabled: false };
    },

    /* 一次性合成任意文本 (消息脚注"重新朗读") — 全局 TTS 关着也能用:
     * 临时拉起 provider 合成完还原 enabled 状态, 不产生持久副作用。 */
    async speakTTS(text: string) {
      if (!text?.trim()) return null;
      ensureTTSSummarizeFn(ttsService, () => defaultProvider);
      const wasEnabled = ttsService.isEnabled();
      try {
        if (!wasEnabled) {
          ttsService.updateConfig({ enabled: true });
          await ttsService.init();
        }
        const r = await ttsService.speak(text);
        /* speak() 失败时只会给 null, 真因留在 lastSpeakError 上 —— 带出去,
         * 否则上层只能翻译成一句放之四海皆准的「检查语音合成配置」。 */
        return r ?? { error: ttsService.getLastSpeakError() ?? '合成失败 (无更多信息)' };
      } catch (err: any) {
        cliLogger.warn('SERVER', `speakTTS failed: ${err?.message ?? err}`);
        return { error: err?.message ? String(err.message) : String(err) };
      } finally {
        if (!wasEnabled) ttsService.updateConfig({ enabled: false });
      }
    },

    updateTTSConfig(ttsConfig: any) {
      const wasEnabled = ttsService.isEnabled();
      const prev = ttsService.getConfig();
      ttsService.updateConfig(ttsConfig);
      /* 确保 summarizeFn + 云端网关解析器已就绪 (provider 可能切到 neoxcloud). 幂等. */
      ensureTTSSummarizeFn(ttsService, () => defaultProvider);
      /* 重新 init 的条件: 从关到开, 或运行中改了 provider/连接字段。
       * BYOK provider (OpenAICompat) 在构造时捕获 apiUrl/apiKey/model —
       * 只比 provider 会漏"provider 没变但换了 URL/Key/模型"的场景, 旧实例继续打旧端点. */
      const connChanged = (['provider', 'apiUrl', 'apiKey', 'model'] as const)
        .some(k => ttsConfig[k] !== undefined && ttsConfig[k] !== (prev as any)[k]);
      if ((ttsConfig.enabled && !wasEnabled) || (ttsService.isEnabled() && connChanged)) {
        ttsService.init().catch(err => {
          cliLogger.error('SERVER', `TTS init failed: ${err.message}`);
        });
      }
    },
  };
}
