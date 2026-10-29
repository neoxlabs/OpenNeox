import { loadConfig, saveConfig } from '@neoxlabs/platform/utils/config.js';
import { isGPTModel } from '@neoxlabs/platform/utils/modelDetect.js';
import { L } from '../i18n/index.js';

type Choice = { label: string; value: string; description: string };
type PromptSelect = (question: string, choices: Choice[], defaultValue?: string) => Promise<string>;
type LogInfo = (message: string, details?: string) => void;

interface ExperimentalCommandDeps {
  model: string;
  promptSelect: PromptSelect;
  logInfo: LogInfo;
}

const ptcUnavailable = (deps: ExperimentalCommandDeps) => deps.logInfo(
  L('PTC 不可用', 'PTC unavailable'),
  L('GPT 模型不支持 Programmatic Tool Calling，请切换到 Claude 或其他兼容模型后再启用。',
    'GPT models don’t support Programmatic Tool Calling — switch to Claude or another compatible model first.'),
);
const toggled = (deps: ExperimentalCommandDeps, key: 'FGTS' | 'PTC', on: boolean, restart: boolean) => {
  const name = key === 'FGTS' ? 'Fine-Grained Tool Streaming' : 'Programmatic Tool Calling';
  const tail = restart ? L('（重启生效）', ' (takes effect after restart)') : '';
  deps.logInfo(`${key} ${on ? 'enabled' : 'disabled'}`, `${on ? L('已启用', 'Enabled') : L('已禁用', 'Disabled')} ${name}${tail}`);
};

export async function handleExperimentalCommand(actionArg: string | undefined, deps: ExperimentalCommandDeps): Promise<void> {
  const expAction = (actionArg || '').toLowerCase();
  const expConfig = loadConfig();
  const currentFGTS = expConfig.experimental?.enableFGTS ?? true;
  const currentPTC = expConfig.experimental?.enablePTC ?? false;

  if (expAction === 'fgts') {
    const newVal = !currentFGTS;
    const updated = { ...expConfig, experimental: { ...expConfig.experimental, enableFGTS: newVal } };
    saveConfig(updated);
    toggled(deps, 'FGTS', newVal, false);
    return;
  }
  if (expAction === 'ptc') {
    const newVal = !currentPTC;
    if (newVal && isGPTModel(deps.model)) {
      ptcUnavailable(deps);
      return;
    }
    const updated = { ...expConfig, experimental: { ...expConfig.experimental, enablePTC: newVal } };
    saveConfig(updated);
    toggled(deps, 'PTC', newVal, true);
    return;
  }

  try {
    const selected = await deps.promptSelect(L('实验特性', 'Experimental features'), [
      {
        label: `FGTS ${currentFGTS ? '✓ ON' : '○ OFF'}`,
        value: 'fgts',
        description: L('Fine-Grained Tool Streaming — 工具参数流式输出，降低延迟（仅 Anthropic API）',
          'Fine-Grained Tool Streaming — streams tool arguments for lower latency (Anthropic API only)'),
      },
      {
        label: `PTC ${currentPTC ? '✓ ON' : '○ OFF'}`,
        value: 'ptc',
        description: L('Programmatic Tool Calling — LLM 写 JS 脚本批量编排工具调用（agentic 模式）',
          'Programmatic Tool Calling — the model writes JS to batch tool calls (agentic mode)'),
      },
    ], '');

    if (selected === 'fgts') {
      const newVal = !currentFGTS;
      const updated = { ...expConfig, experimental: { ...expConfig.experimental, enableFGTS: newVal } };
      saveConfig(updated);
      toggled(deps, 'FGTS', newVal, true);
    } else if (selected === 'ptc') {
      const newVal = !currentPTC;
      if (newVal && isGPTModel(deps.model)) {
        ptcUnavailable(deps);
      } else {
        const updated = { ...expConfig, experimental: { ...expConfig.experimental, enablePTC: newVal } };
        saveConfig(updated);
        toggled(deps, 'PTC', newVal, true);
      }
    }
  } catch (error: any) {
    if (error.message !== 'cancelled') deps.logInfo(L('实验特性设置失败', 'Experimental selection failed'), error.message);
  }
}
