import { loadConfig, saveConfig } from '@neoxlabs/platform/utils/config.js';
import { isGPTModel } from '@neoxlabs/platform/utils/modelDetect.js';

type Choice = { label: string; value: string; description: string };
type PromptSelect = (question: string, choices: Choice[], defaultValue?: string) => Promise<string>;
type LogInfo = (message: string, details?: string) => void;

interface ExperimentalCommandDeps {
  model: string;
  promptSelect: PromptSelect;
  logInfo: LogInfo;
}

export async function handleExperimentalCommand(actionArg: string | undefined, deps: ExperimentalCommandDeps): Promise<void> {
  const expAction = (actionArg || '').toLowerCase();
  const expConfig = loadConfig();
  const currentFGTS = expConfig.experimental?.enableFGTS ?? true;
  const currentPTC = expConfig.experimental?.enablePTC ?? false;

  if (expAction === 'fgts') {
    const newVal = !currentFGTS;
    const updated = { ...expConfig, experimental: { ...expConfig.experimental, enableFGTS: newVal } };
    saveConfig(updated);
    deps.logInfo('FGTS ' + (newVal ? 'enabled' : 'disabled'), newVal ? '已启用 Fine-Grained Tool Streaming' : '已禁用 Fine-Grained Tool Streaming');
    return;
  }
  if (expAction === 'ptc') {
    const newVal = !currentPTC;
    if (newVal && isGPTModel(deps.model)) {
      deps.logInfo('PTC 不可用', 'GPT 模型不支持 Programmatic Tool Calling，请切换到 Claude 或其他兼容模型后再启用。');
      return;
    }
    const updated = { ...expConfig, experimental: { ...expConfig.experimental, enablePTC: newVal } };
    saveConfig(updated);
    deps.logInfo('PTC ' + (newVal ? 'enabled' : 'disabled'), newVal ? '已启用 Programmatic Tool Calling（重启生效）' : '已禁用 Programmatic Tool Calling（重启生效）');
    return;
  }

  try {
    const selected = await deps.promptSelect('实验特性 (Experimental Features)', [
      {
        label: `FGTS ${currentFGTS ? '✓ ON' : '○ OFF'}`,
        value: 'fgts',
        description: 'Fine-Grained Tool Streaming — 工具参数流式输出，降低延迟（仅 Anthropic API）',
      },
      {
        label: `PTC ${currentPTC ? '✓ ON' : '○ OFF'}`,
        value: 'ptc',
        description: 'Programmatic Tool Calling — LLM 写 JS 脚本批量编排工具调用（agentic 模式）',
      },
    ], '');

    if (selected === 'fgts') {
      const newVal = !currentFGTS;
      const updated = { ...expConfig, experimental: { ...expConfig.experimental, enableFGTS: newVal } };
      saveConfig(updated);
      deps.logInfo('FGTS ' + (newVal ? 'enabled' : 'disabled'), newVal ? '已启用 Fine-Grained Tool Streaming（重启生效）' : '已禁用 Fine-Grained Tool Streaming（重启生效）');
    } else if (selected === 'ptc') {
      const newVal = !currentPTC;
      if (newVal && isGPTModel(deps.model)) {
        deps.logInfo('PTC 不可用', 'GPT 模型不支持 Programmatic Tool Calling，请切换到 Claude 或其他兼容模型后再启用。');
      } else {
        const updated = { ...expConfig, experimental: { ...expConfig.experimental, enablePTC: newVal } };
        saveConfig(updated);
        deps.logInfo('PTC ' + (newVal ? 'enabled' : 'disabled'), newVal ? '已启用 Programmatic Tool Calling（重启生效）' : '已禁用 Programmatic Tool Calling（重启生效）');
      }
    }
  } catch (error: any) {
    if (error.message !== 'cancelled') deps.logInfo('Experimental selection failed', error.message);
  }
}
