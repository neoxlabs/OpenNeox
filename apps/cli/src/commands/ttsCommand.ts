import { loadConfig, saveConfig } from '@neoxlabs/platform/utils/config.js';

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
    deps.logInfo('TTS enabled', 'TTS 语音输出已启用 (Edge TTS)');
    return;
  }
  if (ttsAction === 'off' || ttsAction === 'disable') {
    const updated = { ...ttsConfig, tts: { ...ttsConfig.tts, enabled: false } };
    saveConfig(updated);
    deps.syncTtsEnabled(false);
    deps.logInfo('TTS disabled', 'TTS 语音输出已禁用');
    return;
  }

  try {
    const ttsSelected = await deps.promptSelect('语音朗读', [
      { label: '关闭', value: 'off', description: '不朗读' },
      { label: 'Edge', value: 'edge', description: '微软 Edge 免费语音, 中文音质好' },
      { label: 'OpenAI', value: 'openai', description: 'OpenAI TTS (需要 API Key)' },
    ], ttsCurrentEnabled ? (ttsConfig.tts?.provider || 'edge') : 'off');

    if (ttsSelected === 'off') {
      const updated = { ...ttsConfig, tts: { ...ttsConfig.tts, enabled: false } };
      saveConfig(updated);
      deps.syncTtsEnabled(false);
      deps.logInfo('TTS disabled', 'TTS 语音输出已禁用');
    } else {
      const updated = { ...ttsConfig, tts: { ...ttsConfig.tts, enabled: true, provider: ttsSelected as any } };
      saveConfig(updated);
      deps.syncTtsEnabled(true);
      deps.logInfo('TTS enabled', `TTS 语音输出已启用 (${ttsSelected})`);
    }
  } catch (error: any) {
    if (error.message !== 'cancelled') deps.logInfo('TTS selection failed', error.message);
  }
}
