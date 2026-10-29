/**
 * Thinking Command Handler
 * Handles extended thinking mode for Claude and Gemini models
 */

import type { ProviderConfigEntry } from '@neoxlabs/platform/utils/config.js';
import type { AnthropicProvider } from '@neoxlabs/kernel/models/anthropic.js';
import type { GeminiProvider } from '@neoxlabs/kernel/models/gemini.js';
import type { SelectionChoice } from '../cliTypes.js';
import { colors } from '../constants.js';
import { getSchemaRegistry } from '@neoxlabs/kernel/schemas/index.js';
import { cliPrintln } from '../utils/output.js';
import { L } from '../i18n/index.js';

function outputToUI(ctx: { outputLines?: (lines: string[]) => void }, lines: string[]): void {
  if (ctx.outputLines) {
    ctx.outputLines(lines);
  } else {
    lines.forEach(line => cliPrintln(line));
  }
}

/**
 * Thinking command context
 */
export interface ThinkingCommandContext {
  model: string;
  providerSettings: ProviderConfigEntry;
  thinkingMode: 'enabled' | 'disabled' | undefined;
  llmProvider: any;
  setThinkingMode: (mode: 'enabled' | 'disabled' | undefined) => void;
  promptSelect?: (question: string, choices: SelectionChoice[], defaultValue?: string) => Promise<string>;
  logInfo?: (message: string, details?: string) => void;
  outputLines?: (lines: string[]) => void;
}

/**
 * 检查是否为支持 thinking 的 Gemini 模型
 */
function isGeminiThinkingModel(model: string): boolean {
  return model.includes('gemini-3') || model.includes('preview');
}

/**
 * Handle /thinking command
 * Toggle extended thinking mode for Claude and Gemini models
 */
export async function handleThinkingCommand(
  ctx: ThinkingCommandContext,
  rawCommand: string
): Promise<void> {
  const parts = rawCommand.trim().split(/\s+/);
  const action = (parts[1] || '').toLowerCase();

  const logInfo = ctx.logInfo || ((msg: string, details?: string) => {
    const lines = ['', colors.info(`  ${msg}`)];
    if (details) lines.push(colors.dim(`    ${details}`));
    lines.push('');
    outputToUI(ctx, lines);
  });

  // Check provider type
  const isAnthropic = ctx.providerSettings.protocol === 'anthropic';
  const isGemini = ctx.providerSettings.protocol === 'gemini';
  const isSupported = isAnthropic || isGemini;

  // Check if model is known to support thinking
  // Claude 4/5 代 opus/sonnet 全支持 extended thinking, 改代际匹配不再逐版本枚举。
  const isKnownThinkingModel = isAnthropic
    ? (/claude-(opus|sonnet)[-.]?[45]/i.test(ctx.model) ||
       /opus-[45][-.]\d/i.test(ctx.model) ||
       ctx.model.endsWith('-thinking'))
    : isGemini
      ? isGeminiThinkingModel(ctx.model)
      : false;

  const hasEffortMap = (() => {
    try {
      const schema = getSchemaRegistry().resolveModel(ctx.model);
      return !!schema?.effort_map && Object.keys(schema.effort_map).length > 0;
    } catch {
      return false;
    }
  })();

  if (!isSupported && !hasEffortMap) {
    logInfo(L('深度思考', 'Extended thinking'), L(`当前模型 ${ctx.model} 不支持切换思考`, `${ctx.model} has no thinking switch`));
    return;
  }

  const thinkingLabel = (): string =>
    isAnthropic ? 'Claude' : isGemini ? 'Gemini' : ctx.model;

  const enableThinking = () => {
    ctx.setThinkingMode('enabled');
    if (ctx.llmProvider && 'setThinking' in ctx.llmProvider) {
      if (isAnthropic) {
        (ctx.llmProvider as AnthropicProvider).setThinking({ type: 'enabled' });
      } else if (isGemini) {
        (ctx.llmProvider as GeminiProvider).setThinking({ type: 'enabled' });
      }
    }
    const providerName = thinkingLabel();
    /* schema 里明写着 effort_map 就是**声明支持**, 不该再警告"可能不完全适配" ——
     * isKnownThinkingModel 只认 Claude/Gemini 的型号族, 对走 schema 路径的模型恒 false。 */
    const warning = (!isKnownThinkingModel && !hasEffortMap) ? `\n    ⚠ ${L('当前模型可能不完全适配', 'this model may not fully support it')}` : '';
    logInfo(L(`深度思考已开 · ${providerName}`, `${providerName} thinking enabled`), `${L('模型', 'Model')}: ${ctx.model}${warning}`);
  };

  const disableThinking = () => {
    ctx.setThinkingMode('disabled');
    if (ctx.llmProvider && 'setThinking' in ctx.llmProvider) {
      if (isAnthropic) {
        (ctx.llmProvider as AnthropicProvider).setThinking({ type: 'disabled' });
      } else if (isGemini) {
        (ctx.llmProvider as GeminiProvider).setThinking({ type: 'disabled' });
      }
    }
    const providerName = thinkingLabel();
    logInfo(L(`深度思考已关 · ${providerName}`, `${providerName} thinking disabled`), `${L('模型', 'Model')}: ${ctx.model}`);
  };

  // Direct commands
  if (action === 'on' || action === 'enable' || action === 'enabled') {
    enableThinking();
    return;
  }

  if (action === 'off' || action === 'disable' || action === 'disabled') {
    disableThinking();
    return;
  }

  // Interactive selection
  if (ctx.promptSelect && action !== 'status') {
    /* 没设过 (undefined) = 按模型默认开着 —— 状态栏和 /stats 都这么算; 这里原来把 undefined 当关, 三处说法打架 */
    const current = ctx.thinkingMode === 'disabled' ? 'off' : 'on';
    const providerName = thinkingLabel();
    try {
      const selected = await ctx.promptSelect(`${L('深度思考', 'Extended thinking')} · ${providerName}`, [
        { label: L('开启', 'On'), value: 'on', description: L('先想再答, 适合复杂任务 (更慢、更贵)', 'Thinks before answering · for hard tasks (slower, costs more)') },
        { label: L('关闭', 'Off'), value: 'off', description: L('直接回答, 更快', 'Answers directly · faster') },
      ], current);

      if (selected === 'on' && ctx.thinkingMode !== 'enabled') {
        enableThinking();
      } else if (selected === 'off' && ctx.thinkingMode !== 'disabled') {
        disableThinking();
      } else {
        logInfo(L('深度思考', 'Extended thinking'), ctx.thinkingMode === 'disabled' ? L('已关闭', 'Off') : L('已开启', 'On'));
      }
    } catch (error: any) {
      if (error.message !== 'cancelled') {
        logInfo(L('切换思考失败', 'Thinking selection failed'), error.message);
      }
    }
    return;
  }

  // Status display
  const modeLabel = ctx.thinkingMode === 'disabled' ? L('已关闭', 'off')
    : ctx.thinkingMode === 'enabled' ? L('已开启', 'on') : L('已开启 (模型默认)', 'on (model default)');
  /* 'Unknown' 是老判据的残留 —— 非 Claude/Gemini 走 schema 路径也是正常支持的, 不是"未知" */
  const providerName = thinkingLabel();
  logInfo(L('深度思考', 'Extended thinking'), `${L('状态', 'Status')}: ${modeLabel}\n    Provider: ${providerName}\n    ${L('模型', 'Model')}: ${ctx.model}`);
}
