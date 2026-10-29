import { loadConfig, saveConfig } from '@neoxlabs/platform/utils/config.js';
import { L } from '../i18n/index.js';

type Choice = { label: string; value: string; description: string };
type PromptSelect = (question: string, choices: Choice[], defaultValue?: string) => Promise<string>;
type LogInfo = (message: string, details?: string) => void;

interface TtsCommandDeps {
  promptSelect: PromptSelect;
  logInfo: LogInfo;
  syncTtsEnabled: (enabled: boolean) => void;
}

export async function handleTtsCommand(actionArg: string | undefined, deps: TtsCommandDeps): Promise<void> {
  const ttsAction = (actionArg || '').toLowerCase();
  const ttsConfig = loadConfig();
  const ttsCurrentEnabled = ttsConfig.tts?.enabled ?? false;

  if (ttsAction === 'on' || ttsAction === 'enable') {
    const updated = { ...ttsConfig, tts: { ...ttsConfig.tts, enabled: true, provider: ttsConfig.tts?.provider || 'edge' as const } };
    saveConfig(updated);
    deps.syncTtsEnabled(true);
    deps.logInfo('TTS enabled', L('TTS 语音输出已启用 (Edge TTS)', 'TTS voice output enabled (Edge TTS)'));
    return;
  }
  if (ttsAction === 'off' || ttsAction === 'disable') {
    const updated = { ...ttsConfig, tts: { ...ttsConfig.tts, enabled: false } };
    saveConfig(updated);
    deps.syncTtsEnabled(false);
    deps.logInfo('TTS disabled', L('TTS 语音输出已禁用', 'TTS voice output disabled'));
    return;
  }

  try {
    const ttsSelected = await deps.promptSelect(L('语音朗读', 'Voice read-aloud'), [
      { label: L('关闭', 'Off'), value: 'off', description: L('不朗读', 'Do not read aloud') },
      { label: 'Edge', value: 'edge', description: L('微软 Edge 免费语音, 中文音质好', 'Free Microsoft Edge voice, good Chinese quality') },
      { label: 'OpenAI', value: 'openai', description: L('OpenAI TTS (需要 API Key)', 'OpenAI TTS (requires API key)') },
    ], ttsCurrentEnabled ? (ttsConfig.tts?.provider || 'edge') : 'off');

    if (ttsSelected === 'off') {
      const updated = { ...ttsConfig, tts: { ...ttsConfig.tts, enabled: false } };
      saveConfig(updated);
      deps.syncTtsEnabled(false);
      deps.logInfo('TTS disabled', L('TTS 语音输出已禁用', 'TTS voice output disabled'));
    } else {
      const updated = { ...ttsConfig, tts: { ...ttsConfig.tts, enabled: true, provider: ttsSelected as any } };
      saveConfig(updated);
      deps.syncTtsEnabled(true);
      deps.logInfo('TTS enabled', L(`TTS 语音输出已启用 (${ttsSelected})`, `TTS voice output enabled (${ttsSelected})`));
    }
  } catch (error: any) {
    if (error.message !== 'cancelled') deps.logInfo('TTS selection failed', error.message);
  }
}
