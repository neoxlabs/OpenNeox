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
    logInfo('Extended thinking', `当前模型 ${ctx.model} 没有声明思考档位 (schema 里没有 effort_map)`);
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
    const warning = (!isKnownThinkingModel && !hasEffortMap) ? '\n    ⚠ 当前模型可能不完全适配' : '';
    logInfo(`${providerName} thinking enabled`, `模型: ${ctx.model}${warning}`);
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
    logInfo(`${providerName} thinking disabled`, `模型: ${ctx.model}`);
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
    const current = ctx.thinkingMode === 'enabled' ? 'on' : 'off';
    const providerName = thinkingLabel();
    try {
      const selected = await ctx.promptSelect(`深度思考 · ${providerName}`, [
        { label: '开启', value: 'on', description: '先想再答, 适合复杂任务 (更慢、更贵)' },
        { label: '关闭', value: 'off', description: '直接回答, 更快' },
      ], current);

      if (selected === 'on' && ctx.thinkingMode !== 'enabled') {
        enableThinking();
      } else if (selected === 'off' && ctx.thinkingMode !== 'disabled') {
        disableThinking();
      } else {
        logInfo('Extended Thinking', `当前状态: ${ctx.thinkingMode === 'enabled' ? '已开启' : '已关闭'}`);
      }
    } catch (error: any) {
      if (error.message !== 'cancelled') {
        logInfo('Thinking selection failed', error.message);
      }
    }
    return;
  }

  // Status display
  const modeLabel = ctx.thinkingMode === 'enabled' ? '已开启' : ctx.thinkingMode === 'disabled' ? '已关闭' : '未设置';
  /* 'Unknown' 是老判据的残留 —— 非 Claude/Gemini 走 schema 路径也是正常支持的, 不是"未知" */
  const providerName = thinkingLabel();
  logInfo('Extended Thinking', `状态: ${modeLabel}\n    Provider: ${providerName}\n    模型: ${ctx.model}`);
}
